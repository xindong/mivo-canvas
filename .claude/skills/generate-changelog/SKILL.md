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
    { "date": "YYYY-MM-DD", "prs": [99], "features": ["..."], "fixes": ["..."] }
  ]
}
```

- `entries` 按 `date` 降序；全量保留（前端只展示最近 7 天，不删旧数据）
- `prs` 记录该天已收录的 PR 号，是补扫去重的唯一依据；前端不展示
- `updatedAt` 是前端未读红点的比对基准

## 流程（每一步都必须照做）

### 1. 锚点

读 `public/changelog.json` 的 `lastGithash`——上次生成时已覆盖到的 main commit。

### 2. 补扫（协作者全覆盖的核心）

```bash
git fetch origin main
git log --first-parent --format='%H|%cI|%s' <lastGithash>..origin/main
```

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

- main 有分支保护：changelog.json 的变更**随功能 PR 一起走**（生成动作发生在提 PR 前的分支上），不单开 PR
- 本 skill 不做定时任务、不做运行时 git——生成完全发生在开发态
