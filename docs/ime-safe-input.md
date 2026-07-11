# IME 安全输入约定（Enter 守卫）

## 问题

输入法（中文/日文等）在选候选词期间，键盘的 Enter 是用来**确认候选文字**的。如果输入框的 `onKeyDown` 只判 `key === 'Enter'` 就触发动作（发送提示词 / 生成 / 保存 / 关卡片），那么用户还没确认候选就会被误当成"提交"——把半成品的拼音/未确认文字直接发出去。

正确行为：**输入法激活（合成态）时按 Enter 只确认候选，不触发动作；候选确认完毕后再按 Enter 才提交。**

## 约定（MANDATORY）

任何在 **Enter 上提交或触发动作**的提示词/文本输入框（`<textarea>` / `<input>` / `contenteditable`），在 `preventDefault` / 提交之前，**必须先过 `isImeComposing()` 守卫并早退**：

```ts
import { isImeComposing } from '@/lib/imeSafeEnter' // 相对路径按所在目录调整

const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
  if (isImeComposing(e)) return          // ← 合成态早退，让 Enter 用于确认候选
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void submit()
  }
}
```

守卫实现见 `src/lib/imeSafeEnter.ts`：判 `nativeEvent.isComposing`（现代浏览器标准标志）+ `nativeEvent.keyCode === 229`（部分浏览器/输入法合成态未置位 isComposing 但 keyCode=229 的兜底）。

## 为什么是共享守卫而不是逐个写

- 出图/修图工具链的输入框会持续新增（局部重绘、区域描述、未来的新工具链）。逐个手写 `isComposing` 判断迟早漏一个，且写法会分叉。
- 单一 `isImeComposing()` 让所有输入框（现有 + 未来）走同一套判定，新输入框接一行即合规。

## 当前已接入的输入点

- `src/app/chat/ChatComposer.tsx` — 主聊天输入框（Enter 发送）
- `src/canvas/AnchorOverlay.tsx` — 锚点指令框（Enter→生成）
- `src/canvas/useMaskRichEditor.ts` — 局部重绘富文本框（Enter 拦截块级换行）
- `src/canvas/ImageMaskEditOverlay.tsx` — 局部重绘"已标记对象"卡（容器级 Enter 关卡片）
- `src/app/settings/GatewayKeyDialog.tsx` / `MivoKeyDialog.tsx` — 密钥输入框（Enter 保存）

**新增出图/修图工具链输入框时，请把它加进上面列表并接入守卫。**
