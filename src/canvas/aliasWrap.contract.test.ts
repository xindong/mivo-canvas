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

  it('useTextAnnotation.ts: addTextNode(复合 lambda:create+条件 resize)+addFrameNode/addMarkupNode 经 wrapMutation', () => {
    // F1[复审]:addTextNode 拖拽创建 = create + 条件 resize 同一 wrapMutation 复合 lambda(after-snapshot
    //   捕获最终几何;旧版 resize 在 wrap 外裸调致 server 捕获默认几何 96×42+textAutoWidth=true)。
    expect(textAnnotationSource).toContain('wrapMutation(() => {')
    expect(textAnnotationSource).toContain('addTextNode({ x, y })') // create 在 lambda 内(合法)
    expect(textAnnotationSource).toContain('resizeTextNode(nodeId, x, width, height)') // resize 在 lambda 内
    expect(textAnnotationSource).toContain('return nodeId')
    // addTextNode( 唯一出现 = 复合 lambda 内那 1 处;wrap 外裸调会成第 2 处 → count>1 FAIL
    //   (允许 lambda 内合法、拦截 wrap 外裸调——#247 教训:直调正则防不住别名,但 count=1 钉死唯一合法位)。
    expect((textAnnotationSource.match(/addTextNode\(/g) || []).length).toBe(1)
    // addFrameNode/addMarkupNode:直包(取参),非裸调。
    expect(textAnnotationSource).toContain('wrapMutation(addFrameNode)')
    expect(textAnnotationSource).toContain('wrapMutation(addMarkupNode)')
    expect(textAnnotationSource).not.toMatch(/addFrameNode\(/)
    expect(textAnnotationSource).not.toMatch(/addMarkupNode\(/)
  })

  it('useCanvasInteractionController.ts: deleteNode(空文本节点自动删)经 wrapMutation,非裸别名调用', () => {
    expect(interactionControllerSource).toContain('wrapMutation(deleteNode)')
    expect(interactionControllerSource).not.toMatch(/deleteNode\(/)
  })
})
