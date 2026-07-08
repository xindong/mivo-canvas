---
name: generate-changelog
description: 补扫已合入 main 的 PR 并更新 public/changelog.json（侧边栏"更新日志"面板的数据源）。触发时机：每次提 PR 前的收尾动作（在功能分支上跑一遍补扫，把此前已合入 main 的 PR 收录进日志、随本 PR 一起提交），或用户喊"更新日志"。
---

# generate-changelog — 更新日志补扫生成

维护 `public/changelog.json`（侧边栏"更新日志"面板的静态数据源）。**纯补扫制**：只收录**已经合入 main** 的 PR，当前待提交的 PR 不写入——它的归属日在合并前不可知（07:50 生成、08:10 合入会归错结算日），留给下一次任何人跑本 skill 时补录。语义上 PR N 的 changelog 更新收录到 PR N-1 及之前（滞后一班车，换取归属日 100% 精确）。

## 数据模型

```json
{
  "lastGithash": "<上次扫描时 origin/main 的 HEAD>",
  "updatedAt": "<最近一次实际写入新内容的 ISO 时间戳（本地时区带偏移）>",
  "entries": [
    {
      "date": "YYYY-MM-DD",
      "prs": [99],
      "features": [{ "text": "...", "by": "作者名" }],
      "fixes": [{ "text": "...", "by": "作者名" }]
    }
  ]
}
```

- `entries` 按 `date` 降序；全量保留（前端只展示最近 7 天，不删旧数据）
- `prs` 记录该天已收录的 PR 号，是补扫去重的唯一依据；前端不展示
- `updatedAt` 是前端未读红点的比对基准
- `features`/`fixes` 的每条是 `{ text, by }`：`by` = 该 PR 落地 commit 的 **git author name**（`%an`，无网络依赖）；前端把 `by` 渲染成条目尾部的灰字小标签（空串则不显示）。旧版纯 string 条目前端可向后兼容读取，但**新写入一律用对象形态**

## 流程（每一步都必须照做）

### 1. 锚点

读 `public/changelog.json` 的 `lastGithash`——上次生成时已覆盖到的 main commit。

### 2. 补扫（协作者全覆盖的核心）

```bash
git fetch origin main
git log --first-parent --format='%H|%cI|%an|%s' <lastGithash>..origin/main
```

（`%an` 即作者名，直接作为该 PR 所有条目的 `by` 字段；subject 按前三个 `|` 切分后取剩余全段，防 subject 自带竖线。）

- **必须用 `--first-parent`**：钉死主干落地 commit 作为候选范围，排除 merge 形态 PR 的分支内部 commit。**不要用 `--merges`**——本仓历史是混合形态（#95 起全是 squash 单父提交，早期才有 merge commit），`--merges` 会漏掉全部 squash PR。
- **PR 识别双模式**（两种都认，按 PR 号归并）：
  1. squash 形态（当前主流）：subject 以 `(#N)` 结尾
  2. merge 形态（历史遗留）：subject 匹配 `Merge pull request #N`
- **不限作者**：协作者的 PR 即使从未跑过本 skill，也会在下一次任何人生成时被补录。
- 与现有 entries 的 `prs` 求差集：已收录的 PR 号直接跳过（去重闭环）。

### 3. 归天（8:00 结算边界 + 本地时区）

每个 PR 取其**落地 main 的 commit 的 committer 时间**（squash 形态即该单父提交、merge 形态即 merge commit；有疑问时用 `gh pr view N --json mergedAt` 交叉核对）。按 8:00 边界归入**它自己的结算日**（不是生成当天）：

- 时间轴左移 8 小时后取本地日历日（07:59 归前一天，08:00 起归当天）
- **必须用代码换算，禁止心算/手写**，且**禁用 `toISOString()` 取日**（那是 UTC 日，会把边界错移）。与前端 `src/lib/changelogDate.ts` 的 `toChangelogDay` 语义一致，可直接参考：

```bash
node -e '
const ts = new Date(process.argv[1]).getTime() - 8 * 3600_000
const d = new Date(ts)
console.log(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)
' '2026-07-05T07:59:00+08:00'
```

### 4. 分类

commit subject 前缀 `feat` → `features`，`fix` → `fixes`；其他前缀（perf/chore/test/refactor…）按"用户能感知到什么"判断归类，感知不到的合并成一条低调的描述也要收录（所有 PR 都必须进日志）。标题信息不足时读 commit body，必要时 `gh pr view N` 取 PR body。

### 5. 口语化改写铁律（用户红线，一条都不能破）

- 以**使用者视角**描述"你能感知到什么变了"
- **禁止**出现函数名、文件名、组件名、hook、store、IPC、渲染引擎名等一切代码词汇
- 一条一个用户可感知的变化（一个 PR 可拆多条，多个 PR 也可合一条）
- 示例：写"画布上的坐标钉图标统一了样式"，不写"统一 pin icon 渲染组件"
- 每条填 `by` = 该 PR 落地 commit 的 `%an`；一个 PR 拆出的多条同 `by`，多个 PR 合成的一条取主 PR 的 `%an`

### 6. 机器字段一律用代码取（禁 LLM 手写）

- `date`：第 3 步的代码换算结果
- `lastGithash`：`git rev-parse origin/main`
- `updatedAt`：系统时间（`date +%Y-%m-%dT%H:%M:%S%z` 加冒号成 `+08:00` 形态）

### 7. 写回

- 同日已有 entry 时**合并进同一 entry**：`prs` 按号去重追加，`features`/`fixes` 追加新条目
- entries 保持按 `date` 降序
- `lastGithash` 置为 `origin/main` HEAD
- `updatedAt` **仅在实际有新条目写入时刷新**——无新 PR 的空跑不改 `updatedAt`（避免无意义红点），此时 `lastGithash` 照常前移
- 生成后把新增条目给用户过目，确认后随功能 PR 一起提交

## 注意

- main 有分支保护：changelog.json 的变更默认**随功能 PR 一起走**（生成动作发生在提 PR 前的分支上），不单开 PR。**例外**：下面的"自动模式"作为无人值守兜底，会单开 changelog-only PR
- 本 skill 不做运行时 git——生成完全发生在开发态（自动模式由外部调度器在开发机上触发，仍是开发态）

### 自动模式（每日 8:00 调度器无人值守调用）

> **机械步骤已由脚本承载（2026-07-08）**：本模式的全部机械步骤（fetch / git log 差集 / 归天 / 去重 / 建临时 worktree / 合并写回 / 开 PR / 轮询 CI / squash merge / 清理）已下沉为**零 LLM 确定性脚本** `scripts/changelog/auto-changelog.mjs`（零 npm 依赖）。每日 8:00 调度器拉起的轻量 agent **只做三件事**：
>
> 1. `node scripts/changelog/auto-changelog.mjs scan` — 扫出新 PR，产物落 `/tmp/mivo-changelog-scan.json`
> 2. 按 `scripts/changelog/REWRITE_PROMPT.md` 把 scan 产物**口语化改写**（本闭环唯一用 LLM 的环节），写 `/tmp/mivo-changelog-rewrite.json`
> 3. `node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json` — 校验 + 开 PR + 轮询 CI + squash merge
>
> 三步编排详见 `scripts/changelog/RUNBOOK.md`。脚本行为与下方原 SOP 语义一致；下面保留原 SOP 作为**语义规格说明**，供审查脚本实现是否忠实于本 skill 时对照。

由定时调度器每日 8:00 触发（恰在结算日翻页后），无人值守跑完整补扫闭环。完整 SOP：

1. **同步主干**：`git fetch origin main`，从最新 `origin/main` 检出干净工作区（建议临时 worktree，避免污染开发中的工作树），在其上执行上文"流程"第 1–7 步生成/更新 `public/changelog.json`（每条含 `by`）。无人值守跑法下第 7 步的"给用户过目"跳过，靠第 5 步铁律自守
2. **无新 PR → 静默退出**：补扫差集为空（changelog.json 无实质变化，`updatedAt` 不刷新）时，**不开 PR、不留分支**，调用 `schedule_silence_current_run`（lizi_scheduler MCP）静默本次运行，然后清理临时 worktree 退出
3. **有新条目 → 开 PR**：
   ```bash
   git checkout -b chore/changelog-YYYY-MM-DD   # 日期 = 当天结算日
   git add public/changelog.json
   git commit -m "chore: 更新日志补扫 YYYY-MM-DD"
   git push -u origin chore/changelog-YYYY-MM-DD
   gh pr create --title "chore: 更新日志补扫 YYYY-MM-DD" --body "<新增条目清单>"
   ```
4. **轮询 CI 到全绿才 merge**：`gh pr checks <N> --watch` 轮询 6 项必需 CI。若 CI 报 head 落后基线，先 `gh pr update-branch <N>` 再等重跑。**全部通过后才**执行：
   ```bash
   gh pr merge <N> --squash --delete-branch
   ```
5. **merge 后同步 main**：`git fetch origin main` 并快进本地 main（或直接清理临时 worktree——下次运行总是从最新 origin/main 开始）
6. **安全铁律（一条都不能破）**：
   - 只允许 merge **本 SOP 自己在本次运行中创建**的 changelog-only PR（分支名匹配 `chore/changelog-*`，diff 仅含 `public/changelog.json`），**绝不 merge 任何其他 PR**
   - CI 未全绿 / 出现冲突 / 等待超过合理时长（建议 30 分钟）→ **不 merge**，调用 `schedule_notify_current_run`（lizi_scheduler MCP）把 PR 链接与卡点原因通知用户，保留 PR 待人工处理后退出
   - 任何步骤失败（fetch 失败、push 被拒、gh 报错）同样走 `schedule_notify_current_run` 通知，不做破坏性重试
