# REWRITE_PROMPT — 更新日志口语化改写指令

> 供 `auto-changelog.mjs rewrite` 直调 LLM 网关使用。输入 = `auto-changelog.mjs scan` 的产物(`/tmp/mivo-changelog-scan.json`),输出 = 改写后的 JSON(交给 `auto-changelog.mjs publish --rewrite`)。
>
> 这是整个补扫闭环里**唯一**用到 LLM 的环节。脚本会**写死校验**你的输出,不合规一律拒绝,所以请严格按本指令来。

---

## 你的任务

读入下方 `<scan>` 里的 PR 清单(每条含 `pr` / `day` / `author` / `subject` / `body`),把它们改写成**使用者视角**的更新日志条目,按 `day` 归并成 entry,输出下方 `<schema>` 规定形态的 JSON。

## 铁律五条(一条都不能破)

1. **使用者视角**:描述"用户能感知到什么变了",不描述实现。
2. **禁代码词**:禁止出现函数名、文件名、组件名、hook、store、IPC、渲染引擎名、工具链名等**一切代码词汇**。脚本有一份代码术语黑名单(preflight / CI / tsc / lint / hook / CRUD / BFF / Basic Auth / API / prompt / token / refactor / commit / merge / npm / vite / react / zustand / leafer / tsx / oauth / proxy / e2e / playwright / vitest / typecheck / squash / workflow / sha / hash / cache / async / component / props / dispatch / schema / http / url / cors / auth / session / cookie / endpoint / route / handler / node / env …),命中即整份拒绝。中文口语化文本不应出现这些英文词。
3. **一条一变化**:一条只写一个用户可感知的变化。一个 PR 可拆成多条,多个 PR 也可合并成一条。
4. **写感知不写实现**:写"画布上的坐标钉图标统一了样式",**不写**"统一 pin icon 渲染组件";写"局部重绘能在图上圈选区域改图",**不写**"mask edit overlay 接入"。
5. **`by` 字段**:每条填该 PR 的作者(即 `<scan>` 里每条 `item.author`,由 scan 从 `gh pr view --json author` 的 PR opener 取;gh 取不到时 scan 已降级到 `^2`/`%an`)。一个 PR 拆出的多条 `by` 相同;多个 PR 合并成的一条,`by` 取**主 PR**(贡献该条变化最多的那个)的 `author`。不要自己编作者名,直接用 scan 给的。

## 必须满足的硬约束(脚本会校验)

> **以下任一条不过,整份改写被脚本拒绝(exit 非 0),需修正后重跑——不会只挑合格条目放行。**

- **每个 PR 都要覆盖,不许漏**:输出里所有 `prs` 数组的并集,必须**恰好**等于 `<scan>` 里全部 `pr` 的集合——多一个、漏一个都会被拒绝。
- **date 不许篡改**:每条 `prs` 在 `<scan>` 里的 `day` 必须全一致,且必须 = 该 entry 的 `date`。日期由 scan 按 8:00 结算边界算好,你只能照抄,不能改。
- **by 不许凭空写**:单 PR 条目 `by` 必须**精确等于**该 PR 在 `<scan>` 里的 `author`;多 PR 合并条目 `by` 必须是 `prs` 中**至少一个** PR 的 `author`(允许你选主 PR,但不能写一个谁都不是的名字)。
- **合并条目必须带全部来源 PR 号**:若一条由多个 PR 合成,它的 `prs` 数组必须**列出全部**贡献该条的 PR 号(这是去重与归属依据,不能只写一个)。
- **同一天归同一个 entry**:同一 `day` 的所有条目放进同一个 `entry`,不要建多个同日 entry。
- **分类**:偏新功能/能力增强 → `features`;偏修复/稳定性 → `fixes`。拿不准就按"用户能不能感知到新东西"判断——能 → features,只是更稳/修了坏 → fixes。所有 PR 都必须进日志(感知不到的也合并成一条低调描述)。
- **`text`** 非空;**`prs`** 非空且为正整数数组。

## 输出 JSON schema

```json
{
  "entries": [
    {
      "date": "YYYY-MM-DD",
      "features": [
        { "text": "使用者视角的一句话", "by": "作者名", "prs": [142] }
      ],
      "fixes": [
        { "text": "使用者视角的一句话", "by": "作者名", "prs": [148] }
      ]
    }
  ]
}
```

只输出这个 JSON,不要加 markdown 代码围栏、不要解释、不要前后缀。`features` / `fixes` 可为空数组但不可缺省。

## few-shot 例子

### 输入(scan 片段)

```json
{
  "items": [
    { "pr": 142, "day": "2026-07-07", "author": "aj0928", "subject": "feat: 选区工具新增椭圆/矩形/自由圈选 (#142)", "body": "" },
    { "pr": 145, "day": "2026-07-07", "author": "Praise", "subject": "feat: 侧栏项目目录管理 (#145)", "body": "新建/改名/删除项目,画板可在项目间移动" }
  ]
}
```

### 好的输出

```json
{
  "entries": [
    {
      "date": "2026-07-07",
      "features": [
        { "text": "选区工具新增椭圆、矩形、自由圈选和点选几种形状", "by": "aj0928", "prs": [142] },
        { "text": "侧栏可以管理项目目录了:新建、改名、删除项目,画板能在项目之间移动归类", "by": "Praise", "prs": [145] }
      ],
      "fixes": []
    }
  ]
}
```

### 坏的输出(会被拒绝)

```json
{ "entries": [{ "date": "2026-07-07", "features": [
  { "text": "新增 mask edit overlay 组件支持椭圆/矩形 selection", "by": "aj0928", "prs": [142] }
], "fixes": [] }] }
```
拒绝原因:命中黑名单(mask / overlay / selection 不在黑名单字面里,但 `component` 命中?——本例 `overlay`/`selection` 是代码词,改写应换成"局部重绘的圈选区域"),且漏了 PR 145。正确做法见"好的输出"。

> 注:黑名单是脚本写死的英文词列表,中文口语化文本一般不会命中。只要你通篇用中文描述用户感知,就不会触黑名单。

---

## 输入(<scan>)

`auto-changelog.mjs rewrite` 会把 `/tmp/mivo-changelog-scan.json` 的内容注入这里:

```json
{{SCAN_JSON}}
```

## 输出

只输出改写好的 JSON。脚本会校验通过后写到 `/tmp/mivo-changelog-rewrite.json`,然后 GitHub Actions 跑 `node scripts/changelog/auto-changelog.mjs publish --rewrite /tmp/mivo-changelog-rewrite.json`。
