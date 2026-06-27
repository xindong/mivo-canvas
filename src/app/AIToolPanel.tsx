import {
  ChevronDown,
  ImagePlus,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  SquareDashed,
  Upload,
  Wand2,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { saveImportedAsset } from '../lib/assetStorage'
import { useCanvasStore } from '../store/canvasStore'

type AIToolPanelProps = {
  open: boolean
  onToggle: () => void
}

export function AIToolPanel({ open, onToggle }: AIToolPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const nodes = useCanvasStore((state) => state.nodes)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds)
  const selectedNode = nodes.find((node) => node.id === selectedNodeId)
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const addAiSlotNode = useCanvasStore((state) => state.addAiSlotNode)
  const addAnnotationNode = useCanvasStore((state) => state.addAnnotationNode)
  const generateBesideNode = useCanvasStore((state) => state.generateBesideNode)
  const generateIntoAiSlot = useCanvasStore((state) => state.generateIntoAiSlot)
  const generateFromAnnotation = useCanvasStore((state) => state.generateFromAnnotation)
  const updatePrompt = useCanvasStore((state) => state.updatePrompt)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const getAiContextSnapshot = useCanvasStore((state) => state.getAiContextSnapshot)
  const [unboundPrompt, setUnboundPrompt] = useState('')
  const [contextPreview, setContextPreview] = useState('')
  const promptValue = selectedNode
    ? selectedNode.type === 'annotation'
      ? selectedNode.text ?? selectedNode.generation?.prompt ?? ''
      : selectedNode.generation?.prompt ?? ''
    : unboundPrompt

  const handleFile = async (file?: File) => {
    if (!file) return
    const asset = await saveImportedAsset(file)
    addImportedImage(asset.assetUrl, asset.title, asset.size, undefined, asset)
  }

  const handlePromptChange = (prompt: string) => {
    if (selectedNode) {
      if (selectedNode.type === 'annotation') {
        updateTextNode(selectedNode.id, prompt)
      }
      updatePrompt(selectedNode.id, prompt)
    } else {
      setUnboundPrompt(prompt)
    }
  }

  const createSlotNearSelection = () => {
    const x = selectedNode ? selectedNode.x + selectedNode.width + 56 : -160 + nodes.length * 18
    const y = selectedNode ? selectedNode.y : -160 + nodes.length * 18
    addAiSlotNode({ x, y }, { width: 320, height: 320 }, promptValue)
  }

  const runPrimaryGeneration = () => {
    if (selectedNode?.type === 'ai-slot') {
      generateIntoAiSlot(selectedNode.id, promptValue)
      return
    }

    if (selectedNode?.type === 'annotation') {
      generateFromAnnotation(selectedNode.id)
      return
    }

    if (selectedNode) {
      generateBesideNode(selectedNode.id, promptValue)
      return
    }

    createSlotNearSelection()
  }

  const showAiContext = () => {
    const snapshot = getAiContextSnapshot()
    setContextPreview(JSON.stringify(snapshot, null, 2))
  }

  if (!open) {
    return (
      <aside className="ai-panel collapsed" aria-label="AI tool panel">
        <button type="button" className="ai-compact-toggle" onClick={onToggle} aria-label="Open AI panel">
          <PanelRightOpen size={18} />
        </button>
        <button type="button" className="ai-compact-icon active" aria-label="AI generation" title="AI generation">
          <Wand2 size={19} />
        </button>
        <button
          type="button"
          className="ai-compact-icon"
          onClick={() => inputRef.current?.click()}
          aria-label="Upload reference image"
          title="Upload reference image"
        >
          <ImagePlus size={19} />
        </button>
        <button
          type="button"
          className="ai-compact-icon"
          onClick={runPrimaryGeneration}
          aria-label="Generate"
          title="Generate"
        >
          <Sparkles size={19} />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            void handleFile(event.target.files?.[0])
            event.target.value = ''
          }}
          hidden
        />
      </aside>
    )
  }

  return (
    <aside className="ai-panel" aria-label="AI tool panel">
      <div className="ai-panel-header">
        <div>
          <span>AI 工具</span>
          <strong>生成参数</strong>
        </div>
        <button type="button" className="ai-panel-toggle" onClick={onToggle} aria-label="Collapse AI panel">
          <PanelRightClose size={18} />
        </button>
      </div>

      <div className="ai-panel-scroll">
        <div className="ai-field">
          <div className="ai-field-title">
            <span>模型</span>
            <button type="button">
              <Sparkles size={14} />
              实践范例
            </button>
          </div>
          <button type="button" className="ai-select">
            <span>GPT</span>
            <ChevronDown size={18} />
          </button>
        </div>

        <div className="ai-field">
          <span className="ai-label">版本</span>
          <button type="button" className="ai-select">
            <span>{selectedNode?.generation?.model || 'image 2.0'}</span>
            <ChevronDown size={18} />
          </button>
        </div>

        <label className="ai-field">
          <span className="ai-label">提示词</span>
          <div className="ai-prompt-box">
            <textarea
              value={promptValue}
              onChange={(event) => handlePromptChange(event.target.value)}
              placeholder="描述画面、角色、风格、构图..."
              rows={6}
            />
            <div className="ai-prompt-actions">
              <button type="button">风格转变</button>
              <button type="button">表情包</button>
            </div>
          </div>
        </label>

        <div className="ai-field">
          <span className="ai-label">上传参考图</span>
          <button type="button" className="ai-dropzone" onClick={() => inputRef.current?.click()}>
            <ImagePlus size={22} />
            <span>粘贴 / 点击 / 拖拽上传</span>
            <em>从历史记录选择</em>
          </button>
        </div>

        <div className="ai-field compact-metrics">
          <span className="ai-label">当前上下文</span>
          <div className="context-pills">
            <span>{nodes.length} nodes</span>
            <span>{selectedNodeIds.length} selected</span>
            <span>{nodes.filter((node) => node.type === 'ai-slot').length} slots</span>
            <span>{nodes.filter((node) => node.type === 'annotation').length} notes</span>
            <span>{selectedNode ? selectedNode.title : 'No selection'}</span>
          </div>
        </div>

        <div className="ai-field">
          <span className="ai-label">AI 工作流</span>
          <div className="ai-workflow-actions">
            <button type="button" onClick={createSlotNearSelection}>
              <SquareDashed size={16} />
              新建生成槽位
            </button>
            <button
              type="button"
              onClick={() => generateIntoAiSlot(selectedNode?.id, promptValue)}
              disabled={selectedNode?.type !== 'ai-slot'}
            >
              <ImagePlus size={16} />
              生成到槽位
            </button>
            <button type="button" onClick={() => selectedNode && addAnnotationNode(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'ai-slot'}>
              <MessageSquareText size={16} />
              添加批注修图
            </button>
            <button
              type="button"
              onClick={() => generateFromAnnotation(selectedNode?.id)}
              disabled={selectedNode?.type !== 'annotation'}
            >
              <Sparkles size={16} />
              从批注生成
            </button>
            <button type="button" onClick={() => selectedNode && generateBesideNode(selectedNode.id, promptValue)} disabled={!selectedNode}>
              <Sparkles size={16} />
              旁边生成
            </button>
            <button type="button" onClick={showAiContext}>
              <Wand2 size={16} />
              查看 AI 上下文
            </button>
          </div>
          {contextPreview ? <pre className="ai-context-preview">{contextPreview}</pre> : null}
        </div>
      </div>

      <div className="ai-runner">
        <div className="ai-run-options">
          <button type="button">
            <span>1张</span>
            <ChevronDown size={17} />
          </button>
          <button type="button">
            <span>1:1</span>
            <ChevronDown size={17} />
          </button>
          <button type="button">
            <span>medium</span>
            <ChevronDown size={17} />
          </button>
        </div>
        <button
          type="button"
          className="ai-generate"
          onClick={runPrimaryGeneration}
        >
          <Upload size={17} />
          立即生成
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          void handleFile(event.target.files?.[0])
          event.target.value = ''
        }}
        hidden
      />
    </aside>
  )
}
