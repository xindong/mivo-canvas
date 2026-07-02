import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { ImagePlus, Send, Settings2, X } from 'lucide-react'
import { useChatStore } from '../../store/chatStore'
import { useCanvasStore } from '../../store/canvasStore'
import { ComposerParamsPopover } from './ComposerParamsPopover'

type ReferenceFile = {
  id: string
  file: File
  previewUrl: string
}

type ChatComposerProps = {
  sceneId: string
  focusRequestId?: number
  onEsc?: () => void
}

export type ChatComposerHandle = {
  focus: () => void
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(
  function ChatComposer({ sceneId, focusRequestId = 0, onEsc }, ref) {
    const [text, setText] = useState('')
    const [referenceFiles, setReferenceFiles] = useState<ReferenceFile[]>([])
    const [referenceError, setReferenceError] = useState('')
    const [paramsOpen, setParamsOpen] = useState(false)

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const referenceFilesRef = useRef<ReferenceFile[]>([])

    const sendMessage = useChatStore((s) => s.sendMessage)
    const isBusy = useChatStore((s) => s.isBusy)
    const selectedModel = useChatStore((s) => s.selectedModel)
    const paramOverrides = useChatStore((s) => s.paramOverrides)

    const selectedNodeId = useCanvasStore((s) => s.selectedNodeId)
    const nodes = useCanvasStore((s) => s.nodes)
    const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : undefined

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
    }))

    useEffect(() => {
      referenceFilesRef.current = referenceFiles
    }, [referenceFiles])

    useEffect(() => {
      if (!focusRequestId) return
      textareaRef.current?.focus()
    }, [focusRequestId])

    useEffect(
      () => () => {
        referenceFilesRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl))
      },
      [],
    )

    const addFiles = (files: FileList | File[] | null | undefined) => {
      if (isBusy) {
        setReferenceError('生成中，完成或取消后再添加参考图')
        return
      }
      const incoming = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
      const rejected = Array.from(files ?? []).length - incoming.length
      setReferenceError(rejected ? `已跳过 ${rejected} 个非图片文件` : '')
      if (!incoming.length) return
      setReferenceFiles((cur) => [
        ...cur,
        ...incoming.map((f) => ({
          id: `${f.name}-${f.lastModified}-${Math.random().toString(16).slice(2)}`,
          file: f,
          previewUrl: URL.createObjectURL(f),
        })),
      ])
    }

    const removeFile = (id: string) => {
      setReferenceFiles((cur) => {
        const removed = cur.find((f) => f.id === id)
        if (removed) URL.revokeObjectURL(removed.previewUrl)
        return cur.filter((f) => f.id !== id)
      })
    }

    const handleSend = useCallback(async () => {
      const trimmed = text.trim()
      if (!trimmed || isBusy) return
      const filesToSend = referenceFiles.map((f) => f.file)
      referenceFiles.forEach((f) => URL.revokeObjectURL(f.previewUrl))
      setText('')
      setReferenceFiles([])
      setReferenceError('')
      await sendMessage({
        sceneId,
        text: trimmed,
        selectedNodeId: selectedNode?.id,
        selectedNodeType: selectedNode?.type,
        referenceFiles: filesToSend,
      })
    }, [text, isBusy, sendMessage, sceneId, selectedNode, referenceFiles])

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        onEsc?.()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSend()
      }
    }

    const handleDrop = (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      addFiles(e.dataTransfer.files)
    }

    const handlePaste = (e: ClipboardEvent<HTMLElement>) => {
      addFiles(Array.from(e.clipboardData.files))
    }

    const modelLabel = selectedModel.replace('gpt-image-2', 'GPT').replace('gemini-3-pro-image', 'Gemini')
    const hasOverride = paramOverrides.imgRatio !== 'auto' || paramOverrides.quality !== 'auto'
    const canSend = Boolean(text.trim()) && !isBusy
    const busyReason = '正在生成，完成或取消后可继续编辑'
    const sendTitle = isBusy ? busyReason : text.trim() ? '发送' : '先输入描述'
    const referenceTitle = isBusy ? '生成中，完成或取消后再上传参考图' : '上传参考图'

    return (
      <div
        className={`chat-composer ${isBusy ? 'is-busy' : ''}`}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onPaste={handlePaste}
        aria-busy={isBusy}
      >
        {referenceFiles.length > 0 && (
          <div className="chat-ref-chips">
            {referenceFiles.map((f) => (
              <div key={f.id} className="chat-ref-chip">
                <img src={f.previewUrl} alt="" className="chat-ref-thumb" />
                <span title={f.file.name}>{f.file.name}</span>
                <button
                  type="button"
                  className="chat-ref-remove"
                  onClick={() => removeFile(f.id)}
                  aria-label={`Remove ${f.file.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {referenceError && <p className="chat-ref-error">{referenceError}</p>}

        <textarea
          ref={textareaRef}
          className="chat-composer-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="描述画面、风格、内容… (Enter 发送)"
          rows={3}
          disabled={isBusy}
          aria-label="Chat input"
          title={isBusy ? busyReason : undefined}
        />

        <div className="chat-composer-actions">
          <span className="chat-model-chip">{modelLabel}</span>

          <button
            type="button"
            className={`chat-action-btn ${hasOverride ? 'active' : ''}`}
            onClick={() => setParamsOpen((v) => !v)}
            aria-label="生成参数"
            title={isBusy ? '生成参数（影响下一次生成）' : '生成参数'}
          >
            <Settings2 size={16} />
          </button>

          <button
            type="button"
            className="chat-action-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            aria-label="上传参考图"
            title={referenceTitle}
          >
            <ImagePlus size={16} />
          </button>

          <button
            type="button"
            className="chat-send-btn"
            onClick={() => void handleSend()}
            disabled={!canSend}
            aria-label={isBusy ? '正在生成' : '发送'}
            title={sendTitle}
          >
            <Send size={15} />
          </button>
        </div>

        {paramsOpen && (
          <ComposerParamsPopover onClose={() => setParamsOpen(false)} />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={isBusy}
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
          hidden
        />
      </div>
    )
  },
)
