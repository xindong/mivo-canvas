# RUNBOOK — 更新日志自动补扫

> 每日 8:00（北京时间）由 GitHub Actions 跑纯脚本流水线:scan → rewrite → publish。
> 失败语义是 GitHub Actions run 变红 + GitHub 默认通知；不再拉起 maker 调度器 agent，也不再调用 `schedule_notify_current_run` / `schedule_silence_current_run`。

## GitHub Actions 触发器

Workflow: `.github/workflows/daily-changelog.yml`

- `schedule`: `0 0 * * *`（UTC 00:00 = 北京 08:00）
- `workflow_dispatch`: 手动触发
- `concurrency`: `daily-changelog-${{ github.repository }}`，防止每日任务重叠
- `timeout-minutes`: 40（publish 内部 CI 轮询上限 30 分钟）

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
- 归天：落地 commit 的 committer 时间左移 8 小时取本地日历日（与 `src/lib/changelogDate.ts` 一致）。
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
- 直调公司网关 OpenAI-compatible chat completions：
  - base 默认 `https://llm-proxy.tapsvc.com/v1`
  - model 默认 `claude-haiku-4-5`
  - key 从 `MIVO_CHANGELOG_LLM_KEY` 读取（本地调试也兼容 `MIVO_LLM_API_KEY` / `MIVO_IMAGE_API_KEY`）
- 输出 `/tmp/mivo-changelog-rewrite.json`：

```json
{ "entries": [{ "date": "YYYY-MM-DD", "features": [{"text": "...", "by": "...", "prs": [123]}], "fixes": [] }] }
```

rewrite 写文件前会先跑 publish 同款校验。校验失败时，会把错误带回下一次 LLM 请求，最多重试 2 次；仍失败则非零退出。

可选参数：`--scan <path>`、`--output <path>`、`--model <name>`、`--base <url>`。也可用 env `MIVO_CHANGELOG_LLM_MODEL`、`MIVO_CHANGELOG_LLM_BASE`、`MIVO_CHANGELOG_LLM_TIMEOUT_MS` 覆盖。

### 3. publish — 校验 + 开 PR + 轮询 CI + squash merge

```bash
node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json
```

输入校验（写死，不信任 LLM）：

- 合法 JSON；每条有非空 `text` / `by` / `prs`。
- 改写产物的 PR 集合必须与 scan 产物的 PR 集合完全一致（多/漏都拒绝）。
- date 不信 LLM：每条 `prs` 在 scan 里的归天日必须全一致，且等于 entry 的 `date`。
- by 不信 LLM：单 PR 条目 `by` 必须精确等于该 PR 的 scan author；多 PR 合并条目 `by` 必须是 `prs` 中某 PR 的 scan author。
- `text` 命中代码术语黑名单 → 拒绝。

写回流程：

1. 从最新 `origin/main` 建临时 worktree `/tmp/mivo-changelog-wt-<pid>`。
2. 合并写回 `public/changelog.json`（同日 entry 合并、`prs` 去重追加、`features` / `fixes` 追加、entries 按 date 降序、`lastGithash`=scan anchor、`updatedAt`=当前本地时间）。
3. 建分支 `chore/changelog-<最大结算日>`，commit `chore: 更新日志补扫 <日期>`。
4. `PREFLIGHT_SKIP=1 git push -u origin <branch>`；Actions 里 remote 已用 `MIVO_CHANGELOG_PAT` 配好。
5. `gh pr create`。
6. 轮询 CI（`gh pr checks <N> --json name,state`，每 30s，上限 30 分钟）；head 落后先 `gh pr update-branch`。
7. merge 前铁律：分支名匹配 `^chore/changelog-`；PR files 仅含 `public/changelog.json`；checks 全 pass；`mergeable=MERGEABLE`。全过才 `gh pr merge --squash`。
8. 收尾：删远程分支 + 清临时 worktree（失败路径也清本地 worktree/分支，PR 保留待人工处理）。

退出码：

- 0 → 已 merge，stdout `{"status":"merged","pr":N,...}`。
- 非 0 → stderr 有原因，workflow 红灯；若 PR 已创建则保留待人工处理。

可选参数：`--scan <path>`（默认 `/tmp/mivo-changelog-scan.json`）、`--dry-run`（只校验 + 打印计划命令，不执行 git/gh 写操作）。

## 关于 `PREFLIGHT_SKIP=1`

changelog-only 非代码改动，临时 worktree 无 `node_modules`，本地 pre-push 五道校验会因依赖缺失挂掉。用 `PREFLIGHT_SKIP=1` 跳过本地 hook；真正门槛是 PR CI。Actions runner 上也保留该 env，行为一致且无害。

## 本地调试

```bash
node scripts/changelog/auto-changelog.mjs scan
MIVO_CHANGELOG_LLM_KEY=sk-... node scripts/changelog/auto-changelog.mjs rewrite
node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json --dry-run
```

不要在本地随手跑非 dry-run publish：它会创建真实 PR、等待 CI，并在全绿后自动 merge。
