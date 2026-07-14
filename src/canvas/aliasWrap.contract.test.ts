// src/canvas/aliasWrap.contract.test.ts
// A2 alias:别名形态(selector 取 action 存变量再调用)call site 经 wrapMutation 源码契约。
// 教训(#247 审查官反馈):直调正则 `store\.X\(` 防不住别名形态(`const X = useCanvasStore(s => s.X); X(...)`)。
// alias-aware regex:用 `X\(`(name + open-paren,**无 store. 前缀**)——catch 直接+别名 bare call;
// wrap 版 `wrapMutation(X)(` 是 `X)`(close-paren),`X\(` 不匹配(防回归改回裸别名调用)。
import { describe, expect, it } from 'vitest'
import mivoCanvasSource from './MivoCanvas.tsx?raw'
import textAnnotationSource from './useTextAnnotation.ts?raw'
import interactionControllerSource from './useCanvasInteractionController.ts?raw'

describe('A2 alias: 别名形态 call site 经 wrapMutation(源码契约,alias-aware regex)', () => {
  it('MivoCanvas.tsx: addTextNode/addFrameNode 经 wrapMutation,非裸别名调用', () => {
    expect(mivoCanvasSource).toContain('wrapMutation(addTextNode)')
    expect(mivoCanvasSource).toContain('wrapMutation(addFrameNode)')
    // alias-aware:无 store. 前缀,catch 别名 `addTextNode(...)` 直调;wrap 版 `addTextNode)` 不匹配。
    expect(mivoCanvasSource).not.toMatch(/addTextNode\(/)
    expect(mivoCanvasSource).not.toMatch(/addFrameNode\(/)
  })

  it('useTextAnnotation.ts: addTextNode/addFrameNode/addMarkupNode(pointer-end tryEnd handler)经 wrapMutation', () => {
    expect(textAnnotationSource).toContain('wrapMutation(addTextNode)')
    expect(textAnnotationSource).toContain('wrapMutation(addFrameNode)')
    expect(textAnnotationSource).toContain('wrapMutation(addMarkupNode)')
    expect(textAnnotationSource).not.toMatch(/addTextNode\(/)
    expect(textAnnotationSource).not.toMatch(/addFrameNode\(/)
    expect(textAnnotationSource).not.toMatch(/addMarkupNode\(/)
  })

  it('useCanvasInteractionController.ts: deleteNode(空文本节点自动删)经 wrapMutation,非裸别名调用', () => {
    expect(interactionControllerSource).toContain('wrapMutation(deleteNode)')
    expect(interactionControllerSource).not.toMatch(/deleteNode\(/)
  })
})
