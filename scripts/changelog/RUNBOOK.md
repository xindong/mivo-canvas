# RUNBOOK — 更新日志自动补扫

> 每日 8:00（北京时间）由 GitHub Actions 跑纯脚本流水线:scan → rewrite → publish。
> 失败语义是 GitHub Actions run 变红 + GitHub 默认通知；不再拉起 maker 调度器 agent，也不再调用 `schedule_notify_current_run` / `schedule_silence_current_run`。

## GitHub Actions 触发器

Workflow: `.github/workflows/daily-changelog.yml`

- `schedule`: `0 0 * * *`（UTC 00:00 = 北京 08:00）
- `workflow_dispatch`: 手动触发
- `concurrency`: `daily-changelog-${{ github.repository }}`，防止每日任务重叠
- `timeout-minutes`: 40（publish 内部 CI 轮询上限 30 分钟）
- job env 固定 `TZ=Asia/Shanghai`。scan/publish 的归天和 `updatedAt` 都依赖本地时区；脚本启动时会检查当前时区，非北京时间且未设置 `TZ=Asia/Shanghai` 会直接失败，避免 GitHub runner 默认 UTC 把 8:00 边界漂移。

## 必需 Secrets

在 GitHub 仓库配置：`Settings → Secrets and variables → Actions → Repository secrets`

- `MIVO_CHANGELOG_PAT`: 用于 `gh` 和 `git push` 的 PAT，必须有仓库写权限。建议 fine-grained PAT 至少授予本仓库 `Contents: Read and write`、`Pull requests: Read and write`。
- `MIVO_CHANGELOG_LLM_KEY`: 公司 LLM 网关 `sk-` key，用于 rewrite 子命令直调 `https://llm-proxy.tapsvc.com/v1/chat/completions`。

必须使用 PAT 而不是 workflow 默认 `GITHUB_TOKEN`：由 `GITHUB_TOKEN` 创建/推送的 PR 不会再触发本仓库 CI，publish 的 `gh pr checks` 会等不到检查结果并最终超时。

## 三步

### 1. scan — 扫出已合入 main 的新 PR

```bash
node scripts/changelog/auto-changelog.mjs scan
```

- 读 `public/changelog.json` 的 `lastGithash` 作锚点，`git fetch origin main`，`git log --first-parent <锚点>..origin/main`。
- PR 识别双模式（squash `(#N)` / merge `Merge pull request #N`），与现有 entries 的 `prs` 求差集去重，跳过 `chore: 更新日志补扫` 自身 meta-PR。
- 归天：落地 commit 的 committer 时间左移 8 小时取本地日历日（与 `src/lib/changelogDate.ts` 一致）。必须在 `Asia/Shanghai` 时区运行；本地若不是北京时间，先显式加 `TZ=Asia/Shanghai`。
- 每条 PR 的 `body` + `by`（PR opener）用 `gh pr view N --json body,author` 一次取双；失败降级为 `by` 走 `^2`/`%an`，`body` 走空串。
- 退出码 0：
  - 无新 PR → stdout `{"status":"empty"}`。Actions 成功退出，不开 PR，不前移 `lastGithash`。
  - 有新 PR → 把 `{"status":"pending","anchor":...,"items":[...]}` 写入 `/tmp/mivo-changelog-scan.json` 并打印。
- 退出码非 0 → workflow 红灯。

可选参数：`--anchor <hash>`（历史重扫，**会跳过去重**，仅调试用）、`--output <path>`、`--no-fetch`。

### 2. rewrite — 口语化改写（唯一用 LLM 的环节）

```bash
MIVO_CHANGELOG_LLM_KEY=sk-... \
node scripts/changelog/auto-changelog.mjs rewrite
```

- 读 `/tmp/mivo-changelog-scan.json`。
- 按 `scripts/changelog/REWRITE_PROMPT.md` 组 prompt。
- prompt 输入不是原始 scan，而是脚本确定性骨架：每个 PR 已带 `date`、`by`、`kind`（`feat`→`features`，`fix`→`fixes`，其他前缀低调归入 `fixes`）。
- 直调公司网关 OpenAI-compatible chat completions：
  - base 默认 `https://llm-proxy.tapsvc.com/v1`
  - model 默认 `claude-haiku-4-5`
  - key 从 `MIVO_CHANGELOG_LLM_KEY` 读取（本地调试也兼容 `MIVO_LLM_API_KEY` / `MIVO_IMAGE_API_KEY`）
- LLM 只输出 PR→文案映射；脚本校验通过后写入 `/tmp/mivo-changelog-rewrite.json`：

```json
{ "items": [{ "pr": 123, "text": "使用者视角的一句话" }] }
```

允许同日同类 PR 合并为 `{ "prs": [123, 124], "text": "..." }`。`date` / `by` / `kind` / 最终 `prs` 全部由脚本从 scan 骨架回填。rewrite 写文件前会校验覆盖、合并合法性、text 黑名单；失败时把错误带回下一次 LLM 请求，最多重试 2 次，仍失败则非零退出。

可选参数：`--scan <path>`、`--output <path>`、`--model <name>`、`--base <url>`。也可用 env `MIVO_CHANGELOG_LLM_MODEL`、`MIVO_CHANGELOG_LLM_BASE`、`MIVO_CHANGELOG_LLM_TIMEOUT_MS` 覆盖。

### 3. publish — 校验 + 开 PR + 轮询 CI + squash merge

```bash
node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json
```

输入校验与组装（写死，不信任 LLM）：

- 合法 JSON；每条只有 `pr` 或 `prs` + 非空 `text`。
- 覆盖集合必须与 scan PR 集合完全一致，且每个 PR 只能出现一次。
- 合并条目只能合并 scan 里同日、同 kind 的 PR。
- `date` / `by` / `kind` 不读 LLM：最终 entries 由脚本从 scan 骨架确定性回填。
- `text` 命中代码术语黑名单 → 拒绝；白名单短语 `API 密钥` 会先剔除再扫描，裸 `api` / `API` 仍拒绝。

写回流程：

1. 从最新 `origin/main` 建临时 worktree `/tmp/mivo-changelog-wt-<pid>`。
2. 合并写回 `public/changelog.json`（同日 entry 合并、`prs` 去重追加、`features` / `fixes` 追加、entries 按 date 降序、`lastGithash`=scan anchor、`updatedAt`=当前本地时间）。
3. 建分支 `chore/changelog-<最大结算日>`，commit `chore: 更新日志补扫 <日期>`。
4. `PREFLIGHT_SKIP=1 git push -u origin <branch>`；Actions 里 remote 已用 `MIVO_CHANGELOG_PAT` 配好。
5. `gh pr create`。
6. 轮询 CI（`gh pr checks <N> --json name,state`，每 30s，上限 30 分钟）；head 落后先 `gh pr update-branch`。
7. merge 前铁律：分支名匹配 `^chore/changelog-`；PR files 仅含 `public/changelog.json`；checks 全 pass；`mergeable=MERGEABLE`。
8. 若铁律全部通过且 PR 仍有 unresolved review threads，publish 会通过 GraphQL 对每条线程先发可见回复，再 `resolveReviewThread`。回复说明该 PR 是每日更新日志自动补扫产物、只含 `public/changelog.json`、内容经脚本硬校验，并附原评论要点。此逻辑只允许在上述 changelog-only PR 上执行；任何其他分支名或文件集合都会拒绝自动处理。
9. 全过后 `gh pr merge --squash`；若 GitHub base branch policy 刚解除仍短暂拒绝，脚本会短暂重试，仍失败则非零退出并保留 PR。
10. 收尾：删远程分支 + 清临时 worktree（失败路径也清本地 worktree/分支，PR 保留待人工处理）。

退出码：

- 0 → 已 merge，stdout `{"status":"merged","pr":N,...}`。
- 非 0 → stderr 有原因，workflow 红灯；若 PR 已创建则保留待人工处理。

可选参数：`--scan <path>`（默认 `/tmp/mivo-changelog-scan.json`）、`--dry-run`（只校验 + 打印计划命令，不执行 git/gh 写操作）。

## 关于 `PREFLIGHT_SKIP=1`

changelog-only 非代码改动，临时 worktree 无 `node_modules`，本地 pre-push 五道校验会因依赖缺失挂掉。用 `PREFLIGHT_SKIP=1` 跳过本地 hook；真正门槛是 PR CI。Actions runner 上也保留该 env，行为一致且无害。

## 本地调试

```bash
TZ=Asia/Shanghai node scripts/changelog/auto-changelog.mjs scan
TZ=Asia/Shanghai MIVO_CHANGELOG_LLM_KEY=sk-... node scripts/changelog/auto-changelog.mjs rewrite
TZ=Asia/Shanghai node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json --dry-run
```

不要在本地随手跑非 dry-run publish：它会创建真实 PR、等待 CI，并在全绿后自动 merge。
