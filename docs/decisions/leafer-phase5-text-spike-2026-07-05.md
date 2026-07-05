# Phase 5 静态文本 golden fixture spike 判决(2026-07-05)

> 依据总计划 Phase 5:"先只做 golden fixture spike(CJK/wrap/line-height/weight/编辑态切换),全部稳定过才开 Leafer text PR,否则文本永久留 DOM。"

## 1. 判决

**文本永久留 DOM。** 不开 Leafer text 正式化 PR。

- 判据:9 用例 golden fixture 要求**全部**稳定通过;实测 3 个用例结构性失败。
- 该结局是总计划预留的合法分支,不影响性能目标——0g 已证明 20k pan p95=17.3ms 的达标组合里,全景态 text 走 LOD 降级(纯色块),高保真态 text 留 DOM 的数量在虚拟化后是百级,DOM 完全扛得住。

## 2. 实验设置

- 工装:`visual-diff.mjs --fixture=text --text-paint=leafer`(本 PR 新增,可长期复跑)
- flag:`?textPaint=leafer`(默认 dom,生产零影响);Leafer 侧以 DOM 等价 props 绘制——
  `.dom-text-node` 的 padding 6/10、line-height 1.28、Inter 字体栈、产品缺省
  (24px/#232323/500/left)、`textWrap:'break'`(Leafer 中最接近
  `overflow-wrap:anywhere` 的选项)、`verticalAlign:'top'`
- 基线:dom 渲染同一 fixture;dom-vs-dom 自检 diff=0%

## 3. 结果矩阵(dom vs leafer+textPaint,DPR1)

总体 diff **0.4126%**(1920×1080 全画布口径,被空白区稀释;判决按分区目检 diff 图):

| 用例 | 结果 | 说明 |
|------|------|------|
| txt-cjk 纯中文长段 | ✅ 近零差 | CJK 逐字断行与行高完全对齐 |
| txt-newline 显式换行 | ✅ 近零差 | pre-wrap 语义一致 |
| txt-color 自定义颜色 | ✅ 近零差 | fill 透传正确 |
| txt-center / txt-right 对齐 | ⚠ 行尾少量差 | 中文行对齐,英文行断点微差 |
| txt-mixed 中英混排 | ❌ 结构性错位 | 第 2 行起断点不同 → 整段后移 |
| txt-longword 英文长词 | ❌ 结构性错位 | anywhere vs break 断词点不同,行数改变 |
| txt-big-bold 24px/700 | ❌ 结构性错位 | 粗体英文断点漂移,第 2 行整行重影 |
| txt-small 12px | ❌ 英文尾部错位 | 同 mixed 根因 |

## 4. 根因

浏览器 `overflow-wrap:anywhere` 允许在**任意字符间**断行(仅当单词整体放不下时),
且断行决策依赖浏览器自己的字形测量;Leafer `textWrap:'break'` 的断词策略与其
测量结果在 ASCII 词、粗体、小字号下系统性偏离。断点是离散决策——差一个字符
就是整行错位,不存在"调参逼近"路径。纯 CJK 逐字断行两边规则一致,所以中文达标。

## 5. 后续动作(FU-11 转正)

文本留 DOM 后,leafer 模式的既定取舍(markup 文字层不可见)需要收口:

- note 正文、rect/ellipse 标注文字、line/arrow 线上 label(`MarkupTextLayer`)
  在 leafer 模式下以 **DOM 文字层 overlay** 形式恢复渲染——shape/line 本体仍由
  Leafer 画,文字层由 DOM 画(D2 混合渲染边界的自然延伸)。
- type='text' / annotation 节点维持现状(本来就走 DOM,零改动)。
- 全景 LOD 态文字随降级隐藏(0g 口径不变)。

## 6. 复跑方式

```bash
npm run visual:diff -- --candidate=dom --fixture=text --port=4331          # 自检 0%
npm run visual:diff -- --candidate=leafer --fixture=text --text-paint=leafer --port=4332
```

diff 图:`test-artifacts/visual-diff/diff-dom-vs-leafer-text.png`
