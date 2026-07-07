// 从 ImageMaskEditOverlay 机械抽离(structure guard >900),行为不变。
// 富文本编辑器:contentEditable DOM 的命令式 chip 维护 + 序列化 + 输入/粘贴/
// 键盘/点击处理 + chip 同步/选中态 effect。ref/闭包依赖通过参数进,函数体
// 逐字搬移;effect 依赖数组逐字保留。
import { useCallback, useEffect, useRef } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from 'react'
import type { ImageMaskRegion, PointAnchor } from './imageMaskGeometry'
import { recognitionLabel, type AnchorRecognition } from './useMaskAnchorRecognition'

type RegionsRef = { current: ImageMaskRegion[] }
type PointAnchorsRef = { current: PointAnchor[] }
type RecognitionsRef = { current: Record<string, AnchorRecognition> }
type WriteRecognitions = (updater: (current: Record<string, AnchorRecognition>) => Record<string, AnchorRecognition>) => void

const anchorKeyAttr = 'data-anchor-key'

export function useMaskRichEditor({
  regionsRef,
  pointAnchorsRef,
  regions,
  recognitions,
  recognitionsRef,
  regionKey,
  writeRecognitions,
  openChipKey,
  setOpenChipKey,
  onCancel,
  commitMaskState,
}: {
  regionsRef: RegionsRef
  pointAnchorsRef: PointAnchorsRef
  regions: ImageMaskRegion[]
  recognitions: Record<string, AnchorRecognition>
  recognitionsRef: RecognitionsRef
  regionKey: (region: ImageMaskRegion) => string
  writeRecognitions: WriteRecognitions
  openChipKey: string | null
  setOpenChipKey: Dispatch<SetStateAction<string | null>>
  onCancel: () => void
  commitMaskState: (nextRegions: ImageMaskRegion[], nextPointAnchors: PointAnchor[]) => void
}) {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const fieldRef = useRef<HTMLDivElement | null>(null)
  // 富文本编辑器序列化：走一遍 childNodes，chip → 当前标签、文本 → 原文，合起来
  // 即「编辑要求」正文（标签也是正文的一部分）；hasText 用于占位符显隐。
  const readEditor = useCallback((): { prompt: string; hasText: boolean } => {
    const editor = editorRef.current
    if (!editor) return { prompt: '', hasText: false }
    const tokens: string[] = []
    let textChars = ''
    editor.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ''
        tokens.push(text)
        textChars += text
      } else if (node instanceof HTMLElement && node.hasAttribute(anchorKeyAttr)) {
        tokens.push(recognitionLabel(recognitionsRef.current[node.getAttribute(anchorKeyAttr) as string]))
      } else if (node instanceof HTMLElement) {
        const text = node.textContent ?? ''
        tokens.push(text)
        textChars += text
      }
    })
    const prompt = tokens
      .map((token) => token.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { prompt, hasText: textChars.trim().length > 0 }
  }, [recognitionsRef, editorRef])

  const buildChipNode = useCallback((key: string, n: number, label: string): HTMLElement => {
    const chip = document.createElement('span')
    chip.className = 'image-mask-edit-chip'
    chip.setAttribute(anchorKeyAttr, key)
    chip.contentEditable = 'false'
    const idx = document.createElement('span')
    idx.className = 'image-mask-edit-chip-index'
    idx.textContent = String(n)
    const lbl = document.createElement('span')
    lbl.className = 'image-mask-edit-chip-label'
    lbl.textContent = label
    const caret = document.createElement('span')
    caret.className = 'image-mask-edit-chip-caret'
    caret.setAttribute('data-caret-key', key)
    caret.textContent = '⌄'
    chip.append(idx, lbl, caret)
    return chip
  }, [])

  // 增量维护 chip：已存在的就地更新序号/标签（绝不移动，避免在标签间打字时乱跳），
  // 新锚点插在「上一个锚点 chip 之后」，被删的锚点移除其 chip。光标/文本节点不受影响。
  const syncEditorChips = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const desired = regions.map((region, index) => ({
      key: regionKey(region),
      n: index + 1,
      label: recognitionLabel(recognitions[regionKey(region)]) || '识别中…',
    }))
    const desiredKeys = new Set(desired.map((item) => item.key))
    editor.querySelectorAll(`[${anchorKeyAttr}]`).forEach((node) => {
      if (!desiredKeys.has(node.getAttribute(anchorKeyAttr) as string)) node.remove()
    })
    let previousChip: HTMLElement | null = null
    for (const item of desired) {
      let chip = editor.querySelector(`[${anchorKeyAttr}="${item.key}"]`) as HTMLElement | null
      if (chip) {
        const idxEl = chip.querySelector('.image-mask-edit-chip-index')
        if (idxEl && idxEl.textContent !== String(item.n)) idxEl.textContent = String(item.n)
        const lblEl = chip.querySelector('.image-mask-edit-chip-label')
        if (lblEl && lblEl.textContent !== item.label) lblEl.textContent = item.label
      } else {
        chip = buildChipNode(item.key, item.n, item.label)
        if (previousChip && previousChip.parentNode === editor) {
          editor.insertBefore(chip, previousChip.nextSibling)
        } else {
          editor.insertBefore(chip, editor.firstChild)
        }
      }
      previousChip = chip
    }
  }, [regions, recognitions, regionKey, buildChipNode, editorRef])

  // 清洗 contenteditable DOM：浏览器会在输入/粘贴时自动塞 <br> 和 <div>/<p> 块级
  // 包装（空编辑框自带隐形 <br>），把 chip 和文字挤成多行，还会让序列化把包装里的
  // chip 误读成文字。这里把块级包装拆平、隐形 <br> 删掉、粘贴的样式包装转纯文本，
  // 保证内容始终是「顶层内联流」。文本节点原样保留（光标不丢）。
  const normalizeEditorDom = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    let changed = true
    while (changed) {
      changed = false
      for (const node of Array.from(editor.childNodes)) {
        if (!(node instanceof HTMLElement) || node.hasAttribute(anchorKeyAttr)) continue
        if (node.tagName === 'BR') {
          node.remove()
          changed = true
        } else if (node.tagName === 'DIV' || node.tagName === 'P') {
          while (node.firstChild) editor.insertBefore(node.firstChild, node)
          node.remove()
          changed = true
        } else if (node.querySelector(`[${anchorKeyAttr}]`)) {
          while (node.firstChild) editor.insertBefore(node.firstChild, node)
          node.remove()
          changed = true
        } else {
          editor.replaceChild(editor.ownerDocument.createTextNode(node.textContent ?? ''), node)
          changed = true
        }
      }
    }
  }, [editorRef])

  const handleEditorInput = () => {
    const editor = editorRef.current
    if (!editor) return
    normalizeEditorDom()
    // 删除 chip（Delete/Backspace）→ 同步移除对应锚点，画布 pin 一并消失，可撤销。
    const presentKeys = new Set(
      Array.from(editor.querySelectorAll(`[${anchorKeyAttr}]`)).map((node) => node.getAttribute(anchorKeyAttr)),
    )
    const surviving = regionsRef.current.filter((region) => presentKeys.has(regionKey(region)))
    if (surviving.length !== regionsRef.current.length) {
      const survivingKeys = new Set(surviving.map((region) => regionKey(region)))
      writeRecognitions((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => survivingKeys.has(key))),
      )
      commitMaskState(surviving, pointAnchorsRef.current)
    }
    editor.classList.toggle('is-empty-text', !readEditor().hasText)
  }

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Enter 拦掉：contenteditable 回车会插 <div>/<br> 块级包装，产生诡异换行且破坏
    // 序列化；正文不需要手动换行，长了自动折行。
    if (event.key === 'Enter') {
      event.preventDefault()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    // Escape 分级：候选卡开着先收卡，再按才退出局部重绘。
    if (openChipKey) {
      setOpenChipKey(null)
      return
    }
    onCancel()
  }

  // 点 chip 切换箭头 → 展开/收起该锚点的候选卡；点 chip 主体 → 整体选中（可复制/删除/粘贴调序）。
  const handleEditorClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    const caret = target?.closest('[data-caret-key]') as HTMLElement | null
    if (caret) {
      event.preventDefault()
      const key = caret.getAttribute('data-caret-key') as string
      setOpenChipKey((current) => (current === key ? null : key))
      return
    }
    const chip = target?.closest(`[${anchorKeyAttr}]`) as HTMLElement | null
    if (chip && editorRef.current?.contains(chip)) {
      event.preventDefault()
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        range.selectNode(chip)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  // chip 选中态：原生选区盖到 chip 上时打 is-selected。
  useEffect(() => {
    const handleSelectionChange = () => {
      const editor = editorRef.current
      if (!editor) return
      const selection = document.getSelection()
      editor.querySelectorAll(`[${anchorKeyAttr}]`).forEach((chip) => {
        const selected = Boolean(
          selection && selection.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(chip),
        )
        chip.classList.toggle('is-selected', selected)
      })
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [editorRef])

  // 粘贴：带我们的 chip → 「移动」语义（删原位重建，即复制粘贴调顺序）；普通内容降级纯文本。
  const handleEditorPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    if (!editor) return
    event.preventDefault()
    const html = event.clipboardData?.getData('text/html') || ''
    const text = event.clipboardData?.getData('text/plain') || ''
    const selection = editor.ownerDocument.getSelection()
    if (!selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const fragment = editor.ownerDocument.createDocumentFragment()
    if (html.includes(anchorKeyAttr)) {
      const validKeys = new Set(regionsRef.current.map((region) => regionKey(region)))
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent ?? ''
          if (value) fragment.appendChild(editor.ownerDocument.createTextNode(value))
          return
        }
        if (node instanceof HTMLElement && node.hasAttribute(anchorKeyAttr)) {
          const key = node.getAttribute(anchorKeyAttr) as string
          if (!validKeys.has(key)) return
          editor.querySelectorAll(`[${anchorKeyAttr}="${key}"]`).forEach((existing) => existing.remove())
          const index = regionsRef.current.findIndex((region) => regionKey(region) === key)
          fragment.appendChild(
            buildChipNode(key, index + 1, recognitionLabel(recognitionsRef.current[key]) || '识别中…'),
          )
          return
        }
        node.childNodes.forEach(walk)
      }
      parsed.body.childNodes.forEach(walk)
    } else if (text) {
      fragment.appendChild(editor.ownerDocument.createTextNode(text))
    }
    const lastInserted = fragment.lastChild
    range.insertNode(fragment)
    if (lastInserted) {
      range.setStartAfter(lastInserted)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    handleEditorInput()
  }

  // regions/recognitions 变化 → 同步 chip 到编辑器，并刷新占位符。先清洗（空
  // contenteditable 自带隐形 <br>，不清掉会把首批 chip 挤到第二行）。
  useEffect(() => {
    normalizeEditorDom()
    syncEditorChips()
    editorRef.current?.classList.toggle('is-empty-text', !readEditor().hasText)
  }, [normalizeEditorDom, syncEditorChips, readEditor, editorRef])

  return {
    editorRef,
    fieldRef,
    readEditor,
    buildChipNode,
    syncEditorChips,
    normalizeEditorDom,
    handleEditorInput,
    handleEditorKeyDown,
    handleEditorClick,
    handleEditorPaste,
  }
}
