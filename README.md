# Mivo Canvas

AI-native 的无限画布交互 Demo:以桌面级无限画布为基座,面向视觉创作、评审与素材工作流。原始素材永不破坏,生成结果保留在画布语义中,画布内容对 AI Agent 可读。

> 目前处于 Demo / 架构验证阶段,尚非生产产品。

## 功能

- **无限画布**:平移缩放、框选、吸附对齐、行/列/网格排布、Section 分区、编组、undo/redo
- **绘图标注**:画笔(marker / 荧光笔 / 橡皮擦,基于 perfect-freehand 的压感笔迹)、箭头/形状/便签、可绑定对象的连接线、FigJam 式印章
- **资源节点**:图片 / Markdown / PDF / 视频,原始文件存 IndexedDB,支持非破坏性裁剪;资源库对接 Local 文件夹与 Eagle
- **AI 能力**:文生图 / 图生图、mask 局部重绘、生成结果与源图的衍生关系、AI 可读的画布快照
- **归档**:Mivo JSON 导入/导出,内嵌本地资源

## 快速开始

```bash
npm install
npm run dev        # http://127.0.0.1:5173/
```

AI 生图为可选功能:在 `.env.local` 中配置 `MIVO_IMAGE_API_KEY`(仅 dev server 使用,不会进入前端)。

其他命令:

```bash
npm run build          # 类型检查 + 构建
npm run lint           # ESLint
npm run test:unit      # 单元测试(Vitest)
npm run test:e2e       # 冒烟测试(Playwright)
```

## 技术栈

React 19 · TypeScript · Vite · Zustand · perfect-freehand · react-markdown

## 文档

- [产品与架构笔记](docs/product-notes.md)
- [数据模型 v2](docs/mivo-data-model-v2.md)
- [Debug Log 与反馈规则](docs/development-logging.md)
- [开发决策记录](docs/development-record.md)
