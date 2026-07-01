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
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import type { MivoImageQuality, MivoImageRatio } from '../types/generation'

type AIToolPanelProps = {
  open: boolean
  onToggle: () => void
  focusRequestId?: number
}

type ReferenceFile = {
  id: string
  file: File
  previewUrl: string
}

const ratioOptions: MivoImageRatio[] = ['1:1', '3:2', '2:3', '16:9', '9:16']
const qualityOptions: MivoImageQuality[] = ['low', 'medium', 'high']

export function AIToolPanel({ open, onToggle, focusRequestId = 0 }: AIToolPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const referenceFilesRef = useRef<ReferenceFile[]>([])
  const nodes = useCanvasStore((state) => state.nodes)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds)
  const selectedNode = nodes.find((node) => node.id === selectedNodeId)
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
  const [referenceFiles, setReferenceFiles] = useState<ReferenceFile[]>([])
  const [imgRatio, setImgRatio] = useState<MivoImageRatio>('1:1')
  const [quality, setQuality] = useState<MivoImageQuality>('medium')
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationError, setGenerationError] = useState('')
  const promptValue = selectedNode
    ? selectedNode.type === 'annotation'
      ? selectedNode.text ?? selectedNode.generation?.prompt ?? ''
      : selectedNode.generation?.prompt ?? ''
    : unboundPrompt

  useEffect(() => {
    referenceFilesRef.current = referenceFiles
  }, [referenceFiles])

  useEffect(() => {
    if (!open || !focusRequestId) return
    promptRef.current?.focus()
  }, [focusRequestId, open])

  useEffect(
    () => () => {
      referenceFilesRef.current.forEach((reference) => URL.revokeObjectURL(reference.previewUrl))
    },
    [],
  )

  const addReferenceFiles = (files: FileList | File[] | undefined | null) => {
    const nextFiles = Array.from(files || []).filter((file) => file.type.startsWith('image/'))
    if (!nextFiles.length) return

    setGenerationError('')
    setReferenceFiles((current) => [
      ...current,
      ...nextFiles.map((file) => ({
        id: `${file.name}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ])
  }

  const removeReferenceFile = (id: string) => {
    setReferenceFiles((current) => {
      const removed = current.find((reference) => reference.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((reference) => reference.id !== id)
    })
  }

  const clearReferenceFiles = () => {
    referenceFilesRef.current.forEach((reference) => URL.revokeObjectURL(reference.previewUrl))
    setReferenceFiles([])
  }

  const handlePromptChange = (prompt: string) => {
    setGenerationError('')
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
    return addAiSlotNode({ x, y }, { width: 320, height: 320 }, promptValue)
  }

  const runPrimaryGeneration = async () => {
    const prompt = promptValue.trim()
    if (!prompt) {
      setGenerationError('请输入提示词。')
      return
    }

    setGenerationError('')
    setIsGenerating(true)
    const options = {
      imgRatio,
      quality,
      referenceFiles: referenceFiles.map((reference) => reference.file),
    }

    try {
      if (selectedNode?.type === 'ai-slot') {
        await generateIntoAiSlot(selectedNode.id, prompt, options)
      } else if (selectedNode?.type === 'annotation') {
        generateFromAnnotation(selectedNode.id)
      } else if (selectedNode) {
        await generateBesideNode(selectedNode.id, prompt, options)
      } else {
        const slotId = createSlotNearSelection()
        await generateIntoAiSlot(slotId, prompt, options)
      }
      clearReferenceFiles()
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : '生成失败。')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    addReferenceFiles(event.dataTransfer.files)
  }

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    addReferenceFiles(Array.from(event.clipboardData.files))
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
          onClick={() => void runPrimaryGeneration()}
          disabled={isGenerating}
          aria-label="Generate"
          title="Generate"
        >
          <Sparkles size={19} />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(event) => {
            addReferenceFiles(event.target.files)
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
              ref={promptRef}
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
          <button
            type="button"
            className="ai-dropzone"
            onClick={() => inputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={(event) => event.preventDefault()}
            onPaste={handlePaste}
          >
            <ImagePlus size={22} />
            <span>粘贴 / 点击 / 拖拽上传</span>
            <em>从历史记录选择</em>
          </button>
          {referenceFiles.length ? (
            <div className="ai-reference-list" aria-label="Staged reference images">
              {referenceFiles.map((reference) => (
                <div className="ai-reference-chip" key={reference.id}>
                  <img className="ai-reference-thumb" src={reference.previewUrl} alt="" />
                  <span title={reference.file.name}>{reference.file.name}</span>
                  <button
                    type="button"
                    className="ai-reference-remove"
                    onClick={() => removeReferenceFile(reference.id)}
                    aria-label={`Remove ${reference.file.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
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
              onClick={() =>
                void generateIntoAiSlot(selectedNode?.id, promptValue, {
                  imgRatio,
                  quality,
                  referenceFiles: referenceFiles.map((reference) => reference.file),
                })
              }
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
            <button
              type="button"
              onClick={() =>
                selectedNode &&
                void generateBesideNode(selectedNode.id, promptValue, {
                  imgRatio,
                  quality,
                  referenceFiles: referenceFiles.map((reference) => reference.file),
                })
              }
              disabled={!selectedNode}
            >
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
          <button type="button" disabled>
            <span>1张</span>
          </button>
          {ratioOptions.map((ratio) => (
            <button
              type="button"
              key={ratio}
              className={imgRatio === ratio ? 'active' : undefined}
              onClick={() => setImgRatio(ratio)}
            >
              <span>{ratio}</span>
            </button>
          ))}
          {qualityOptions.map((item) => (
            <button
              type="button"
              key={item}
              className={quality === item ? 'active' : undefined}
              onClick={() => setQuality(item)}
            >
              <span>{item}</span>
            </button>
          ))}
        </div>
        {generationError ? <div className="ai-generation-error">{generationError}</div> : null}
        <button
          type="button"
          className="ai-generate"
          onClick={() => void runPrimaryGeneration()}
          disabled={isGenerating}
        >
          <Upload size={17} />
          {isGenerating ? '生成中...' : '立即生成'}
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(event) => {
          addReferenceFiles(event.target.files)
          event.target.value = ''
        }}
        hidden
      />
    </aside>
  )
}
