# RUNBOOK — 更新日志自动补扫三步编排

> 每日 8:00 调度器拉起轻量 agent,只做三件事:scan → rewrite → publish。本文是给调度 prompt 直接引用的运行手册。
>
**前提**:运行环境已 `git fetch` 权限、`gh` 已登录、当前工作树是 `mivo-canvas` 仓库且 `scripts/changelog/auto-changelog.mjs` 已合入 main(或至少在当前 checkout 可见)。

## 三步

### 1. scan — 扫出已合入 main 的新 PR

```bash
node scripts/changelog/auto-changelog.mjs scan
```

- 读 `public/changelog.json` 的 `lastGithash` 作锚点,`git fetch origin main`,`git log --first-parent <锚点>..origin/main`。
- PR 识别双模式(squash `(#N)` / merge `Merge pull request #N`),与现有 entries 的 `prs` 求差集去重,跳过 `chore: 更新日志补扫` 自身 meta-PR。
- 归天:落地 commit 的 committer 时间左移 8 小时取本地日历日(与 `src/lib/changelogDate.ts` 一致)。
- 每条 PR 的 `body` 用 `gh pr view N --json body` 取(失败降级空串)。
- **退出码 0**:
  - 无新 PR → stdout `{"status":"empty"}`。**直接结束本轮**(静默,不开 PR)。
  - 有新 PR → 把 `{"status":"pending","anchor":...,"items":[...]}` 写入 `/tmp/mivo-changelog-scan.json` 并打印。
- **退出码非 0** → stderr 有原因,走 `schedule_notify_current_run`。

可选参数:`--anchor <hash>`(历史重扫,**会跳过去重**,仅调试用)、`--output <path>`、`--no-fetch`。

### 2. rewrite — 口语化改写(唯一用 LLM 的环节)

把 `/tmp/mivo-changelog-scan.json` 的内容喂给轻量 LLM 会话,指令模板见 `scripts/changelog/REWRITE_PROMPT.md`。LLM 产出 `/tmp/mivo-changelog-rewrite.json`,形态:

```json
{ "entries": [{ "date": "YYYY-MM-DD", "features": [{"text","by","prs":[...]}], "fixes": [...] }] }
```

铁律:使用者视角、禁代码词、每条带 `prs`、合并条目必须列全部来源 PR、scan 里每个 PR 都要覆盖不漏。

### 3. publish — 校验 + 开 PR + 轮询 CI + squash merge

```bash
node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json
```

**输入校验(写死,不信任 LLM)**:
- 合法 JSON;每条有非空 `text`/`by`/`prs`;
- 改写产物的 PR 集合必须与 scan 产物的 PR 集合**完全一致**(多/漏都拒绝);
- `text` 命中代码术语黑名单 → 拒绝。
- 任一不过 → 非零退出 + stderr 原因,**绝不静默放行**。

**写回流程**:
1. 从最新 `origin/main` 建临时 worktree `/tmp/mivo-changelog-wt-<pid>`;
2. 合并写回 `public/changelog.json`(同日 entry 合并、`prs` 去重追加、`features`/`fixes` 追加、entries 按 date 降序、`lastGithash`=scan 的 anchor、`updatedAt`=当前本地时间);
3. `git checkout -b chore/changelog-<最大结算日>` → commit(`chore: 更新日志补扫 <日期>`)→ `PREFLIGHT_SKIP=1 git push -u origin <branch>`;
4. `gh pr create`;
5. 轮询 CI(`gh pr checks <N> --json name,state`,每 30s,上限 30 分钟);head 落后先 `gh pr update-branch`;
6. **merge 前铁律**(全写死):分支名匹配 `^chore/changelog-`;PR files 仅含 `public/changelog.json`;checks 全 pass;`mergeable=MERGEABLE`(刚算完 CI 时该字段常短暂为 `UNKNOWN`,重试 6 次/10s 仍非 MERGEABLE 才 fail;`CONFLICTING` 等立即 fail)。全过才 `gh pr merge --squash`;
7. 收尾:`git push origin --delete <branch>` + `git worktree remove --force`(失败路径也清,trap)。

**退出码**:
- 0 → 已 merge(stdout `{"status":"merged","pr":N,...}`);
- 非 0 → stderr 原因,走 `schedule_notify_current_run`,PR 保留待人工处理。

可选参数:`--scan <path>`(默认 `/tmp/mivo-changelog-scan.json`)、`--dry-run`(只校验 + 打印计划命令,不执行写操作,用于验证)。

## 关于 `PREFLIGHT_SKIP=1`

changelog-only 非代码改动,临时 worktree 无 `node_modules` 跑不了 pre-push 五道本地校验(typecheck/lint/build/...)。用 `PREFLIGHT_SKIP=1` 跳过本地 pre-push,CI 仍会跑真校验。这是既定决策——本地校验在 deps-less worktree 必挂,CI 是真门槛。

## 调度 prompt 引用示例

```
1. 跑 `node scripts/changelog/auto-changelog.mjs scan`。
   - 若 stdout 为 {"status":"empty"}:本轮无新 PR,调 schedule_silence_current_run 退出。
   - 若失败(非零退出):把 stderr 原因填入 schedule_notify_current_run 通知用户,退出。
2. 读 /tmp/mivo-changelog-scan.json,按 scripts/changelog/REWRITE_PROMPT.md 改写,写 /tmp/mivo-changelog-rewrite.json。
3. 跑 `node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json`。
   - 成功:PR 已 merge,退出。
   - 失败:把 stderr 原因 + PR 链接(若有)填入 schedule_notify_current_run 通知用户,退出。
```
