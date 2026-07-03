# M9 对话式面板交互状态矩阵

检查时间：2026-07-03  
检查分支：`demo/improve-hud`  
检查 HEAD：`9f215a443a137b23d854f5a2cefc0df5d949ddfa`

优先级定义：

- P0：会让用户误以为卡死、失败无路可走、或长耗时操作无法脱身。
- P1：明显影响丝滑度，但不阻断主链路。
- P2：可感知的小打磨，当前流程可用。
- P3：锦上添花，暂不建议做。

## 链路 × 状态

| 链路 | default | hover | active | focus | loading / 生成中 | disabled | error | empty | success | cancel |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 对话发送 / 生成（ChatComposer + ChatMessageList） | ✅ 输入区、发送按钮、消息气泡 | ✅ 按钮 hover | ✅ 用户消息乐观上屏 | ❌ P1：发送、取消、折叠等按钮缺少统一键盘 focus ring | ✅ enhancing / generating spinner | ❌ P1：发送禁用有视觉但缺少原因提示；输入区忙碌禁用无解释 | ✅ assistant error + 重试 | ✅ 空对话提示 | ✅ 结果图 / notice | ❌ P0：30-90s 生成无取消入口 |
| 增强参数卡（EnhanceParamCard） | ✅ 场景、比例、质量、折叠块 | ✅ 参数 chip hover | ✅ 折叠展开、重新生成 | ❌ P1：折叠按钮和 chip focus 不明显 | ✅ 深度思考 spinner | ✅ 非最后一条 / busy 禁用 | ✅ degraded reason 显示 | N/A：随 assistant 消息出现，无独立空态 | ✅ 增强参数展示 | ❌ P1：增强阶段无取消入口 |
| 结果图（ChatResultImage） | ✅ 缩略图按钮定位 | ✅ hover 透明度反馈 | ✅ 点击定位 | ❌ P1：图片按钮 focus 不明显 | ✅ unresolved asset skeleton | ❌ P2：不可定位原因无显式 disabled，仅无图占位 | ❌ P1：图片加载失败没有文字错误态 | N/A：没有结果时不渲染 | ✅ 加载成功显示缩略图 | N/A：定位动作无需取消 |
| 参数弹层（ComposerParamsPopover） | ✅ 比例 / 质量 / 模型分组 | ✅ 选项 hover | ✅ active / aria-pressed | ❌ P1：比例、质量、模型按钮 focus 不明显 | N/A：本地参数选择无加载 | ✅ unavailable 模型 disabled + title | N/A：无远程错误 | N/A：模型能力常量不为空 | ✅ 选择后 chip 高亮 | N/A：即时本地操作无需取消 |
| 模型选择 | ✅ 当前模型 chip + 弹层模型列表 | ✅ 模型按钮 hover | ✅ active 模型高亮 | ❌ P1：键盘 focus 不明显 | N/A：模型切换本地完成 | ✅ unavailable 模型 disabled + reason title | N/A：无远程错误 | N/A：能力表兜底 GPT | ✅ 切换后 chip 更新 | N/A：即时本地操作无需取消 |
| 参考图上传 | ✅ 上传按钮、缩略 chip、删除 | ✅ 上传/删除按钮 hover 部分已有 | ✅ 删除 chip | ❌ P1：上传/删除 focus 不明显 | N/A：Object URL 本地即时 | ❌ P1：生成忙碌时仍能添加参考图，且无原因提示 | ✅ 非图片文件跳过提示 | N/A：无参考图是正常默认态 | ✅ chip 展示文件名 | N/A：上传本地即时；删除即取消 staged reference |
| mask 局部重绘入口与 overlay | ✅ 工具条入口、overlay 工具 / prompt | ✅ overlay 按钮 hover 部分已有 | ✅ 画刷/区域 active | ✅ prompt textarea focus；按钮 focus 一般 | ✅ submitting 状态由 overlay 接管 | ✅ 无选图入口 disabled + title | ✅ overlay 内错误提示 | ✅ 未选图时入口 title 引导 | ✅ 完成后 append notice + 衍生结果 | ✅ overlay 有取消；提交中也可由外层 cancel request abort。mask 三件套不改 |
| Eagle 素材抽屉 | ✅ source / folder / tag / masonry / lightbox | ✅ 卡片、菜单、按钮 hover | ✅ selected、多选、active tag | ❌ P1：masonry article role=button 缺少清晰 focus | ✅ skeleton + image loading placeholder | ✅ loading 时 sync / primary disabled | ✅ offline / image error empty-state | ✅ no assets / no tags / Pinterest preview | ✅ copy status、lightbox、add to canvas | N/A：API 同步短请求，当前无 abort；关闭抽屉即可脱离视图 |
| 画布节点选择 / 拖拽 | ✅ 节点、选区、handles | ✅ handles hover；节点主要靠 cursor | ✅ dragging cursor、selection outline | N/A：画布节点主要指针交互，不要求 Tab 到每个节点 | ✅ task node generating | ✅ locked node cursor / outline | ✅ failed node task UI | ✅ 空画布提示 | ✅ selected outline、drop target、snap guides | N/A：拖拽 pointerup 即结束，生成取消走对话/任务链路 |
| 底部工具条（CanvasToolDock） | ✅ 横排 dock、工具图标、flyout | ✅ hover | ✅ active tool | ❌ P1：工具按钮 focus ring 不明显 | N/A：工具切换本地即时 | ✅ 不可用工具 disabled；mask 无选图 title | N/A：工具切换无远程错误 | N/A：工具条固定存在 | ✅ active tool 高亮 | N/A：即时本地操作无需取消 |
| 生成任务队列（TaskQueue） | ✅ 最多 3 个任务、状态 icon | N/A：队列项无操作 | N/A：队列项无操作 | N/A：当前不可操作 | ✅ running spinner + progress bar | N/A：队列项无按钮 | ✅ failed icon + failed label | ✅ No active task | ✅ done icon + progress 100 | ❌ P2：任务队列没有独立取消按钮；聊天生成补取消后可覆盖主长耗时入口 |
| 衍生边 | ✅ 自动生成 locked arrow | N/A：衍生边是说明性图形 | N/A：默认不作为主动编辑对象 | N/A：说明性图形不参与键盘操作 | N/A：结果完成后出现 | ✅ locked / 只读 | N/A：失败时不生成边，由消息和 task error 表示 | ✅ 无衍生关系时不显示 | ✅ 生成 / edit 成功出现动态锚点连线 | N/A：图形自身无需取消 |

## 本轮补齐范围

本轮只补用户能明显感知的缺失：

1. P0：对话生成与增强阶段增加取消入口，并把 abort 传到 enhance / generate / edit 请求。
2. P1：忙碌时 composer 的输入、发送、参考图上传给出明确禁用原因。
3. P1：对话面板、参数弹层、工具条、Eagle 卡片等核心可交互元素补统一 `:focus-visible`。
4. P1：结果图加载失败显示明确错误态，不再只有空白或永久 skeleton。
5. P1：空画布提示从单字状态改为可行动引导。

暂不补的项：

- TaskQueue 独立取消按钮：当前生成取消主入口在对话消息内，队列是只读摘要；新增队列取消会引入任务和请求映射的额外状态，超出本轮克制边界。
- 衍生边 hover / focus / cancel：它是自动说明性连线且 locked，强行做可交互会改变已验收的 M10 行为。
- mask overlay 细节态：已有取消、错误、提交态，本轮硬边界要求 mask 三件套零改。
- Eagle API abort：素材抽屉已有 loading/error/empty，关闭抽屉或切回画布可以脱离视图；为同步短请求加 abort 的收益低于复杂度。
