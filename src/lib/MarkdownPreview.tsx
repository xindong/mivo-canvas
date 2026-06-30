import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MarkdownPreviewProps = {
  text?: string
  density?: 'canvas' | 'details'
}

export function MarkdownPreview({ text, density = 'canvas' }: MarkdownPreviewProps) {
  const source = text?.trim() || '_Empty Markdown document_'

  return (
    <div className={`markdown-preview ${density}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}
