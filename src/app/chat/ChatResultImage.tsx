import { useState } from 'react'
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
  const [failedUrl, setFailedUrl] = useState('')
  const imageError = Boolean(resolvedUrl && failedUrl === resolvedUrl)

  if (!resolvedUrl) {
    return <div className="chat-result-image-placeholder" aria-hidden="true" />
  }

  if (imageError) {
    return (
      <button
        type="button"
        className="chat-result-image-missing"
        onClick={onLocate}
        title="图片加载失败，点击定位到画布节点"
      >
        <span>结果图加载失败</span>
        <small>点击定位到画布节点</small>
      </button>
    )
  }

  return (
    <button
      type="button"
      className="chat-result-image-btn"
      onClick={onLocate}
      title="点击定位到画布节点"
    >
      <img
        src={resolvedUrl}
        alt="生成结果"
        className="chat-result-image"
        onError={() => setFailedUrl(resolvedUrl)}
      />
    </button>
  )
}
