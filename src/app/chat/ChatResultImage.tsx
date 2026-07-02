import { useCanvasStore } from '../../store/canvasStore'
import { useResolvedAssetUrl } from '../../lib/useResolvedAssetUrl'

type ChatResultImageProps = {
  nodeId: string
  onLocate: () => void
}

export function ChatResultImage({ nodeId, onLocate }: ChatResultImageProps) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId))
  const assetUrl = node?.type === 'image' ? (node as { assetUrl?: string }).assetUrl : undefined
  const resolvedUrl = useResolvedAssetUrl(assetUrl)

  if (!resolvedUrl) {
    return <div className="chat-result-image-placeholder" aria-hidden="true" />
  }

  return (
    <button
      type="button"
      className="chat-result-image-btn"
      onClick={onLocate}
      title="点击定位到画布节点"
    >
      <img src={resolvedUrl} alt="生成结果" className="chat-result-image" />
    </button>
  )
}
