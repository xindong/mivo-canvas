import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  FolderOpen,
  Image,
  Link2,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Unlink,
  X,
} from 'lucide-react'
import { importImageUrlToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'
import {
  assetMatchesQuery,
  dimensionsLabel,
  flattenEagleFolders,
  formatBytes,
  thumbnailUrlFor,
  type AssetItem,
  type AssetSourceId,
  type CanvasAssetClipboardItem,
  type EagleAssetsResponse,
  type EagleFolder,
  type EagleFoldersResponse,
  type EagleStatus,
  type EagleTagItem,
  type EagleTagsResponse,
  type LocalAssetResponse,
  type PinterestStatus,
} from './assetLibraryModel'

type LibraryWorkspaceProps = {
  type: 'assets' | 'plugins' | 'skills'
  variant?: 'workspace' | 'canvas-drawer'
  onOpenCanvas?: () => void
}

const localAssetDragType = 'application/x-mivo-local-asset'

const localAssetFromApi = (asset: LocalAssetResponse['assets'][number]): AssetItem => ({
  ...asset,
  sourceId: 'local',
  sourceLabel: 'Local folders',
})

const eagleAssetFromApi = (asset: EagleAssetsResponse['assets'][number]): AssetItem => ({
  ...asset,
  sourceId: 'eagle',
  sourceLabel: 'Eagle libraries',
})

const formatAssetDate = (timestamp: number) => {
  if (!timestamp) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

const assetClipboardItemFrom = (asset: AssetItem): CanvasAssetClipboardItem => ({
  id: asset.id,
  sourceId: asset.sourceId,
  name: asset.name,
  title: asset.title,
  url: asset.url,
  thumbnailUrl: asset.thumbnailUrl,
  width: asset.width,
  height: asset.height,
  sourcePath: asset.sourcePath,
  tags: asset.tags,
})

const tagMatches = (assetTag: string, selectedTag: string) =>
  assetTag.trim().toLowerCase() === selectedTag.trim().toLowerCase()

type ImageLoadState = 'loading' | 'ready' | 'error'

const fallbackToOriginalAssetImage = (asset: AssetItem, image: HTMLImageElement) => {
  if (image.dataset.fallbackSource === 'original') return false
  image.dataset.fallbackSource = 'original'
  image.src = asset.url
  return true
}

const pluginRows = [
  {
    label: 'Character Consistency',
    description: 'Keep identity, outfit, and silhouette stable across variants.',
    type: 'Workflow',
    status: 'Enabled',
  },
  {
    label: 'Eagle Connector',
    description: 'Browse Eagle libraries and drag references into a canvas.',
    type: 'Connector',
    status: 'Configure',
  },
  {
    label: 'Pinterest Connector',
    description: 'Import boards as linked inspiration sources with attribution.',
    type: 'Connector',
    status: 'Connect',
  },
  {
    label: 'Batch Variant Runner',
    description: 'Generate and compare larger batches from a selected reference.',
    type: 'Tool',
    status: 'Enabled',
  },
  {
    label: 'Product Image Presets',
    description: 'Reusable settings for hero, PDP, social, and banner images.',
    type: 'Preset',
    status: 'Enabled',
  },
]

const skillRows = [
  {
    label: 'Character Reference SOP',
    description: 'Gives agents a repeatable flow for collecting, scoring, and reusing character references.',
    type: 'Workflow',
    status: 'Enabled',
  },
  {
    label: 'Prompt Critic',
    description: 'Reviews image prompts for missing subject, style, camera, ratio, and constraint details.',
    type: 'Review',
    status: 'Enabled',
  },
  {
    label: 'Asset Intake',
    description: 'Lets agents normalize imported assets with source, usage rights, tags, and project notes.',
    type: 'Ingestion',
    status: 'Configure',
  },
  {
    label: 'Variant Planner',
    description: 'Plans controlled image variations before generation so batches stay comparable.',
    type: 'Planning',
    status: 'Enabled',
  },
]

export function LibraryWorkspace({ type, variant = 'workspace', onOpenCanvas }: LibraryWorkspaceProps) {
  const isAssets = type === 'assets'
  const isSkills = type === 'skills'
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const copyAssetsToClipboard = useCanvasStore((state) => state.copyAssetsToClipboard)
  const [query, setQuery] = useState('')
  const [localAssetRoot, setLocalAssetRoot] = useState('~/Desktop/images')
  const [localAssets, setLocalAssets] = useState<AssetItem[]>([])
  const [eagleAssets, setEagleAssets] = useState<AssetItem[]>([])
  const [eagleFolders, setEagleFolders] = useState<EagleFolder[]>([])
  const [eagleTags, setEagleTags] = useState<EagleTagItem[]>([])
  const [eagleStatus, setEagleStatus] = useState<EagleStatus>({ connected: false })
  const [pinterestStatus, setPinterestStatus] = useState<PinterestStatus>()
  const [pinterestSettingsOpen, setPinterestSettingsOpen] = useState(false)
  const [pinterestPrototypeConnected, setPinterestPrototypeConnected] = useState(false)
  const [pinterestSettingsMessage, setPinterestSettingsMessage] = useState('')
  const [activeAssetSource, setActiveAssetSource] = useState<AssetSourceId>('local')
  const [selectedEagleFolderId, setSelectedEagleFolderId] = useState<string>()
  const [selectedEagleTag, setSelectedEagleTag] = useState<string>()
  const [selectedAsset, setSelectedAsset] = useState<AssetItem>()
  const [previewAsset, setPreviewAsset] = useState<AssetItem>()
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [lastSelectedAssetId, setLastSelectedAssetId] = useState<string>()
  const [assetCardMenu, setAssetCardMenu] = useState<{ assetId: string; x: number; y: number }>()
  const [assetLoadState, setAssetLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [eagleLoadState, setEagleLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [eagleTagLoadState, setEagleTagLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [assetDimensions, setAssetDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const [imageLoadStateByAssetId, setImageLoadStateByAssetId] = useState<Record<string, ImageLoadState>>({})
  const [previewImageState, setPreviewImageState] = useState<ImageLoadState>('loading')
  const [copyStatus, setCopyStatus] = useState('')
  const title = isAssets ? 'Assets' : isSkills ? 'Skills' : 'Plugins'
  const kicker = isAssets ? 'Library' : isSkills ? 'Agent capabilities' : 'Extensions'
  const description = isAssets
    ? 'Manage generated images, local folders, Eagle libraries, and online inspiration sources.'
    : isSkills
      ? 'Manage reusable agent skills, review routines, project SOPs, and generation planning behaviors.'
      : 'Manage Mivo tools, connectors, workflow presets, and model defaults for the canvas.'
  const searchPlaceholder = isAssets
    ? 'Search assets, folders, tags, prompts'
    : isSkills
      ? 'Search agent skills, SOPs, review flows'
      : 'Search tools, connectors, presets'
  const actionLabel = isAssets ? 'Add source' : isSkills ? 'Add skill' : 'Add plugin'
  const activeRows = isSkills ? skillRows : pluginRows
  const rootClassName = [
    'library-workspace',
    variant === 'canvas-drawer' ? 'asset-library-drawer' : '',
  ].filter(Boolean).join(' ')
  const activeAssets = useMemo(
    () => (activeAssetSource === 'eagle' ? eagleAssets : activeAssetSource === 'local' ? localAssets : []),
    [activeAssetSource, eagleAssets, localAssets],
  )
  const filteredAssets = useMemo(() => {
    if (activeAssetSource === 'eagle') {
      if (!selectedEagleTag) return activeAssets
      return activeAssets.filter((asset) => asset.tags?.some((tag) => tagMatches(tag, selectedEagleTag)))
    }
    return activeAssets.filter((asset) => assetMatchesQuery(asset, query))
  }, [activeAssetSource, activeAssets, query, selectedEagleTag])
  const flatEagleFolders = useMemo(() => flattenEagleFolders(eagleFolders), [eagleFolders])
  const fallbackEagleTags = useMemo<EagleTagItem[]>(() => {
    const tagNames = Array.from(new Set(eagleAssets.flatMap((asset) => asset.tags || [])))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
    return tagNames.map((name) => ({ id: name, name }))
  }, [eagleAssets])
  const eagleTagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    eagleAssets.forEach((asset) => {
      for (const tag of asset.tags || []) {
        const key = tag.trim().toLowerCase()
        if (!key) continue
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    })
    return counts
  }, [eagleAssets])
  const activeEagleTags = useMemo(() => {
    const sourceTags = eagleTags.length ? eagleTags : fallbackEagleTags
    return sourceTags
      .map((tag) => {
        const count = eagleTagCounts.get(tag.name.trim().toLowerCase()) || 0
        return { ...tag, count }
      })
      .filter((tag) => tag.count > 0)
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  }, [eagleTagCounts, eagleTags, fallbackEagleTags])
  const selectedEagleFolder = useMemo(
    () => flatEagleFolders.find((folder) => folder.id === selectedEagleFolderId),
    [flatEagleFolders, selectedEagleFolderId],
  )
  const selectedAssets = useMemo(() => {
    const selected = new Set(selectedAssetIds)
    return filteredAssets.filter((asset) => selected.has(asset.id))
  }, [filteredAssets, selectedAssetIds])
  const contextMenuAsset = useMemo(
    () => filteredAssets.find((asset) => asset.id === assetCardMenu?.assetId),
    [assetCardMenu?.assetId, filteredAssets],
  )
  const activeLoadState = activeAssetSource === 'eagle' ? eagleLoadState : assetLoadState
  const selectedAssetDimensions = selectedAsset
    ? assetDimensions[selectedAsset.id] ||
      (selectedAsset.width && selectedAsset.height
        ? {
            width: selectedAsset.width,
            height: selectedAsset.height,
          }
        : undefined)
    : undefined
  const assetSources = useMemo(
    () => [
      {
        id: 'local' as const,
        label: 'Local folders',
        description: 'Index local image folders without changing originals.',
        meta: localAssetRoot,
        status:
          assetLoadState === 'loading'
            ? 'Syncing'
            : assetLoadState === 'error'
              ? 'Offline'
              : `${localAssets.length} files`,
        icon: FolderOpen,
      },
      {
        id: 'eagle' as const,
        label: 'Eagle libraries',
        description: 'Read folders, tags, ratings, notes, and original files.',
        meta: eagleStatus.connected
          ? eagleStatus.libraryPath || `Eagle ${eagleStatus.version || ''}`.trim()
          : 'Open Eagle to connect',
        status:
          eagleLoadState === 'loading'
            ? 'Syncing'
            : eagleStatus.connected
              ? `${eagleAssets.length} items`
              : 'Offline',
        icon: Database,
      },
      {
        id: 'pinterest' as const,
        label: 'Pinterest boards',
        description: 'Use online boards as linked inspiration references.',
        meta: pinterestPrototypeConnected || pinterestStatus?.connected ? 'OAuth connected' : 'OAuth sign-in preview',
        status: pinterestPrototypeConnected || pinterestStatus?.connected ? 'Connected' : 'Preview',
        icon: Link2,
      },
    ],
    [
      assetLoadState,
      eagleAssets.length,
      eagleLoadState,
      eagleStatus,
      localAssetRoot,
      localAssets.length,
      pinterestPrototypeConnected,
      pinterestStatus,
    ],
  )

  const loadLocalAssets = useCallback(async () => {
    if (!isAssets) return

    setAssetLoadState('loading')
    try {
      const response = await fetch('/api/mivo/local-assets')
      if (!response.ok) throw new Error(`Local asset API failed with ${response.status}`)
      const payload = (await response.json()) as LocalAssetResponse
      setLocalAssetRoot(payload.root)
      setLocalAssets(payload.assets.map(localAssetFromApi))
      setAssetLoadState('ready')
    } catch {
      setLocalAssets([])
      setAssetLoadState('error')
    }
  }, [isAssets])

  const loadEagleTags = useCallback(async () => {
    if (!isAssets) return

    setEagleTagLoadState('loading')
    try {
      const response = await fetch('/api/mivo/eagle/tags')
      if (!response.ok) throw new Error(`Eagle tags failed with ${response.status}`)
      const payload = (await response.json()) as EagleTagsResponse
      setEagleTags(payload.tags)
      setEagleTagLoadState('ready')
    } catch {
      setEagleTags([])
      setEagleTagLoadState('error')
    }
  }, [isAssets])

  const loadEagleAssets = useCallback(async () => {
    if (!isAssets) return

    setEagleLoadState('loading')
    try {
      const searchParams = new URLSearchParams({ limit: '120', offset: '0' })
      if (selectedEagleFolderId) searchParams.set('folderId', selectedEagleFolderId)
      const [statusResponse, foldersResponse, assetsResponse] = await Promise.all([
        fetch('/api/mivo/eagle/status'),
        fetch('/api/mivo/eagle/folders'),
        fetch(`/api/mivo/eagle/assets?${searchParams.toString()}`),
      ])
      const statusPayload = (await statusResponse.json()) as EagleStatus
      setEagleStatus(statusPayload)
      if (foldersResponse.ok) {
        const foldersPayload = (await foldersResponse.json()) as EagleFoldersResponse
        setEagleFolders(foldersPayload.folders)
      }

      if (!assetsResponse.ok) throw new Error(`Eagle assets failed with ${assetsResponse.status}`)
      const assetsPayload = (await assetsResponse.json()) as EagleAssetsResponse
      setEagleAssets(assetsPayload.assets.map(eagleAssetFromApi))
      setEagleLoadState(statusPayload.connected ? 'ready' : 'error')
    } catch {
      setEagleStatus({ connected: false })
      setEagleAssets([])
      setEagleFolders([])
      setEagleLoadState('error')
    }
  }, [isAssets, selectedEagleFolderId])

  const loadPinterestStatus = useCallback(async () => {
    if (!isAssets) return

    try {
      const response = await fetch('/api/mivo/pinterest/status')
      if (!response.ok) throw new Error(`Pinterest status failed with ${response.status}`)
      setPinterestStatus((await response.json()) as PinterestStatus)
    } catch {
      setPinterestStatus(undefined)
    }
  }, [isAssets])

  const loadPinterestSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/mivo/pinterest/status')
      if (!response.ok) throw new Error(await response.text())
      setPinterestStatus((await response.json()) as PinterestStatus)
    } catch {
      setPinterestStatus({ connected: false, mode: 'prototype' })
    }
  }, [])

  const openPinterestSettings = useCallback(() => {
    setPinterestSettingsOpen(true)
    void loadPinterestSettings()
  }, [loadPinterestSettings])

  const startPinterestOAuth = useCallback(() => {
    setPinterestPrototypeConnected(true)
    setPinterestSettingsMessage('Pinterest authorization is a layout prototype for now. Once Mivo has account services, this button will open Pinterest and return here after approval.')
  }, [])

  const disconnectPinterest = useCallback(() => {
    setPinterestPrototypeConnected(false)
    setPinterestSettingsMessage('Pinterest prototype connection cleared.')
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadLocalAssets()
      void loadEagleTags()
      void loadEagleAssets()
      void loadPinterestStatus()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadEagleAssets, loadEagleTags, loadLocalAssets, loadPinterestStatus])

  useEffect(() => {
    setSelectedAssetIds((current) => {
      const visibleIds = new Set(filteredAssets.map((asset) => asset.id))
      const nextIds = current.filter((assetId) => visibleIds.has(assetId))
      return nextIds.length === current.length ? current : nextIds
    })
  }, [filteredAssets])

  useEffect(() => {
    if (!selectedEagleTag || eagleLoadState !== 'ready') return
    if (!activeEagleTags.some((tag) => tagMatches(tag.name, selectedEagleTag))) {
      setSelectedEagleTag(undefined)
    }
  }, [activeEagleTags, eagleLoadState, selectedEagleTag])

  useEffect(() => {
    if (!previewAsset) return
    setPreviewImageState('loading')
  }, [previewAsset])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (previewAsset) {
        event.preventDefault()
        setPreviewAsset(undefined)
      }
      if (assetCardMenu) {
        event.preventDefault()
        setAssetCardMenu(undefined)
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.asset-card-context-menu')) {
        setAssetCardMenu(undefined)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [assetCardMenu, previewAsset])

  const addAssetToCanvas = useCallback(
    async (asset: AssetItem) => {
      await importImageUrlToCanvas(asset.url, asset.name, { x: 0, y: 0 }, addImportedImage)
      setSelectedAsset(undefined)
      setPreviewAsset(undefined)
      onOpenCanvas?.()
    },
    [addImportedImage, onOpenCanvas],
  )

  const copyAssetsToInternalClipboard = useCallback(
    (assets: AssetItem[]) => {
      if (!assets.length) return
      copyAssetsToClipboard(assets.map(assetClipboardItemFrom))
      setCopyStatus(`已复制 ${assets.length} 张，可在画布粘贴。`)
      setAssetCardMenu(undefined)
    },
    [copyAssetsToClipboard],
  )

  const writeSingleAssetToOsClipboard = useCallback(async (asset: AssetItem) => {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return

    const response = await fetch(asset.url)
    if (!response.ok) throw new Error(`Asset fetch failed with ${response.status}`)
    const sourceBlob = await response.blob()
    const bitmap = await createImageBitmap(sourceBlob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context unavailable')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Unable to encode clipboard PNG'))
      }, 'image/png')
    })

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
  }, [])

  const copyOneAsset = useCallback(
    (asset: AssetItem) => {
      copyAssetsToInternalClipboard([asset])
      void writeSingleAssetToOsClipboard(asset).catch((error) => {
        setCopyStatus(
          error instanceof Error
            ? `已写入 MivoCanvas 内部剪贴板；系统剪贴板写入失败：${error.message}`
            : '已写入 MivoCanvas 内部剪贴板；系统剪贴板写入失败。',
        )
      })
    },
    [copyAssetsToInternalClipboard, writeSingleAssetToOsClipboard],
  )

  const copySelectedAssets = useCallback(() => {
    copyAssetsToInternalClipboard(selectedAssets)
  }, [copyAssetsToInternalClipboard, selectedAssets])

  const copyAssetSource = useCallback((asset: AssetItem) => {
    void navigator.clipboard?.writeText(asset.sourceUrl || asset.sourcePath || asset.name)
    setCopyStatus('素材来源已复制。')
  }, [])

  const beginAssetDrag = useCallback((asset: AssetItem, event: ReactDragEvent<HTMLElement>) => {
    const payload = JSON.stringify({
      id: asset.id,
      name: asset.name,
      title: asset.title,
      url: asset.url,
      sourcePath: asset.sourcePath,
      tags: asset.tags,
      width: asset.width,
      height: asset.height,
    })

    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(localAssetDragType, payload)
    event.dataTransfer.setData('text/plain', asset.name)
  }, [])

  const toggleEagleTag = useCallback(
    (tagName?: string) => {
      setSelectedEagleTag((current) => (current && tagName && tagMatches(current, tagName) ? undefined : tagName))
      setSelectedAsset(undefined)
      setPreviewAsset(undefined)
      setSelectedAssetIds([])
      setLastSelectedAssetId(undefined)
    },
    [],
  )

  const toggleAssetSelection = useCallback((assetId: string) => {
    setSelectedAssetIds((current) =>
      current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId],
    )
    setLastSelectedAssetId(assetId)
  }, [])

  const selectAssetRange = useCallback(
    (assetId: string) => {
      const startIndex = lastSelectedAssetId
        ? filteredAssets.findIndex((asset) => asset.id === lastSelectedAssetId)
        : -1
      const endIndex = filteredAssets.findIndex((asset) => asset.id === assetId)
      if (startIndex < 0 || endIndex < 0) {
        toggleAssetSelection(assetId)
        return
      }

      const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
      const rangeIds = filteredAssets.slice(from, to + 1).map((asset) => asset.id)
      setSelectedAssetIds((current) => Array.from(new Set([...current, ...rangeIds])))
      setLastSelectedAssetId(assetId)
    },
    [filteredAssets, lastSelectedAssetId, toggleAssetSelection],
  )

  const handleAssetCardClick = useCallback(
    (asset: AssetItem, event: ReactMouseEvent<HTMLElement>) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault()
        toggleAssetSelection(asset.id)
        return
      }

      if (event.shiftKey) {
        event.preventDefault()
        selectAssetRange(asset.id)
        return
      }

      setPreviewAsset(asset)
    },
    [selectAssetRange, toggleAssetSelection],
  )

  const handleAssetCardKeyDown = useCallback(
    (asset: AssetItem, event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      setPreviewAsset(asset)
    },
    [],
  )

  const syncActiveSource = useCallback(() => {
    if (activeAssetSource === 'eagle') {
      void loadEagleTags()
      void loadEagleAssets()
      return
    }

    if (activeAssetSource === 'pinterest') {
      void loadPinterestStatus()
      return
    }

    void loadLocalAssets()
  }, [activeAssetSource, loadEagleAssets, loadEagleTags, loadLocalAssets, loadPinterestStatus])

  const connectActiveSource = useCallback(() => {
    if (activeAssetSource === 'pinterest') {
      openPinterestSettings()
      return
    }

    syncActiveSource()
  }, [activeAssetSource, openPinterestSettings, syncActiveSource])

  const rememberDimensions = useCallback((assetId: string, image: HTMLImageElement) => {
    if (!image.naturalWidth || !image.naturalHeight) return

    setAssetDimensions((current) =>
      current[assetId]?.width === image.naturalWidth && current[assetId]?.height === image.naturalHeight
        ? current
        : {
            ...current,
            [assetId]: {
              width: image.naturalWidth,
              height: image.naturalHeight,
            },
          },
    )
  }, [])

  const markImageLoadState = useCallback((assetId: string, state: ImageLoadState) => {
    setImageLoadStateByAssetId((current) => (current[assetId] === state ? current : { ...current, [assetId]: state }))
  }, [])

  const handleAssetImageLoad = useCallback(
    (assetId: string, image: HTMLImageElement) => {
      rememberDimensions(assetId, image)
      markImageLoadState(assetId, 'ready')
    },
    [markImageLoadState, rememberDimensions],
  )

  const handleAssetImageError = useCallback(
    (asset: AssetItem, image: HTMLImageElement) => {
      if (fallbackToOriginalAssetImage(asset, image)) return
      markImageLoadState(asset.id, 'error')
    },
    [markImageLoadState],
  )

  return (
    <section className={rootClassName} aria-label={`${title} workspace`}>
      <header className="library-header">
        <div>
          <span className="library-kicker">{kicker}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="library-actions">
          <button type="button" onClick={syncActiveSource} disabled={activeLoadState === 'loading'}>
            <RefreshCw size={16} />
            Sync
          </button>
          <button type="button" className="primary" onClick={connectActiveSource} disabled={activeLoadState === 'loading'}>
            {isAssets ? <FolderOpen size={16} /> : isSkills ? <Sparkles size={16} /> : <Plug size={16} />}
            {actionLabel}
          </button>
        </div>
      </header>

      {!isAssets ? (
        <div className="library-searchbar">
          <Search size={16} />
          <input
            value={query}
            placeholder={searchPlaceholder}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setSelectedAsset(undefined)
            }}
          />
        </div>
      ) : null}

      {isAssets ? (
        <div className="library-layout assets-layout">
          <aside className="source-list" aria-label="Asset sources">
            {assetSources.map(({ id, label, description, meta, status, icon: Icon }) => (
              <button
                key={label}
                type="button"
                className={activeAssetSource === id ? 'source-row active' : 'source-row'}
                disabled={id === activeAssetSource && activeLoadState === 'loading'}
                onClick={() => {
                  setActiveAssetSource(id)
                  setSelectedAsset(undefined)
                  setPreviewAsset(undefined)
                  setAssetCardMenu(undefined)
                  setSelectedAssetIds([])
                  setLastSelectedAssetId(undefined)
                  if (id !== 'eagle') setSelectedEagleTag(undefined)
                }}
              >
                <Icon size={18} />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <em>{status}</em>
                <i>{meta}</i>
              </button>
            ))}
            {activeAssetSource === 'eagle' ? (
              <div className="eagle-folder-list" aria-label="Eagle folders">
                <button
                  type="button"
                  className={!selectedEagleFolderId ? 'eagle-folder-row active' : 'eagle-folder-row'}
                  onClick={() => {
                    setSelectedEagleFolderId(undefined)
                    setSelectedAsset(undefined)
                    setSelectedAssetIds([])
                    setLastSelectedAssetId(undefined)
                  }}
                >
                  All Eagle assets
                </button>
                {flatEagleFolders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    className={selectedEagleFolderId === folder.id ? 'eagle-folder-row active' : 'eagle-folder-row'}
                    style={{ paddingLeft: 10 + folder.depth * 14 }}
                    onClick={() => {
                      setSelectedEagleFolderId(folder.id)
                      setSelectedAsset(undefined)
                      setSelectedAssetIds([])
                      setLastSelectedAssetId(undefined)
                    }}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            ) : null}
            {activeAssetSource === 'eagle' ? (
              <div className="eagle-tag-directory" aria-label="Eagle tag directory">
                <div className="eagle-tag-directory-header">
                  <strong>Tags</strong>
                  <span>
                    {eagleTagLoadState === 'loading'
                      ? 'Loading'
                      : eagleTagLoadState === 'error'
                        ? 'Fallback'
                        : `${activeEagleTags.length} tags`}
                  </span>
                </div>
                <button
                  type="button"
                  className={!selectedEagleTag ? 'eagle-tag-row active' : 'eagle-tag-row'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleEagleTag(undefined)
                  }}
                >
                  <span>All</span>
                  <em>{eagleAssets.length}</em>
                </button>
                {activeEagleTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={selectedEagleTag && tagMatches(tag.name, selectedEagleTag) ? 'eagle-tag-row active' : 'eagle-tag-row'}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleEagleTag(tag.name)
                    }}
                  >
                    <span>{tag.name}</span>
                    {tag.count !== undefined ? <em>{tag.count}</em> : null}
                  </button>
                ))}
                {activeEagleTags.length === 0 ? (
                  <span className="eagle-tag-empty">No Eagle tags found</span>
                ) : null}
              </div>
            ) : null}
          </aside>

          <section className="asset-browser" aria-label="Asset browser">
            <div className="library-section-heading">
              <div>
                <strong>
                  {activeAssetSource === 'eagle'
                    ? selectedEagleTag
                      ? `Tag: ${selectedEagleTag}`
                      : selectedEagleFolder
                        ? selectedEagleFolder.name
                        : 'All Eagle assets'
                    : activeAssetSource === 'pinterest'
                      ? 'Pinterest boards'
                      : 'Recent assets'}
                </strong>
                <span>
                  {activeAssetSource === 'pinterest'
                    ? 'Connect Pinterest OAuth before boards and pins can appear here.'
                    : activeAssetSource === 'eagle'
                      ? `${filteredAssets.length} image${filteredAssets.length === 1 ? '' : 's'}${selectedEagleTag ? ' in this tag' : ''}`
                      : 'Drag any asset into a canvas as a reference or image node.'}
                </span>
              </div>
              <div className="library-section-actions">
                {activeAssetSource === 'eagle' && selectedAssetIds.length ? (
                  <>
                    <span>{selectedAssetIds.length} selected</span>
                    <button type="button" className="primary" onClick={copySelectedAssets}>
                      <Copy size={15} />
                      Copy selected
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAssetIds([])
                        setLastSelectedAssetId(undefined)
                      }}
                    >
                      Clear
                    </button>
                  </>
                ) : null}
                {activeAssetSource === 'eagle' && copyStatus ? (
                  <span className="asset-copy-status">{copyStatus}</span>
                ) : null}
                {activeAssetSource === 'eagle' && selectedEagleTag ? (
                  <button type="button" onClick={() => toggleEagleTag(undefined)}>
                    <X size={15} />
                    Clear tag
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={activeAssetSource === 'pinterest' ? openPinterestSettings : undefined}
                  disabled={activeLoadState === 'loading'}
                >
                  <Image size={15} />
                  {activeAssetSource === 'eagle' && eagleLoadState === 'loading'
                    ? 'Syncing'
                    : activeAssetSource === 'pinterest'
                      ? 'Preview'
                      : assetLoadState === 'loading'
                        ? 'Syncing'
                        : 'View all'}
                </button>
              </div>
            </div>
            <div className={selectedAsset && activeAssetSource !== 'eagle' ? 'asset-browser-content has-detail' : 'asset-browser-content'}>
              <div className={activeAssetSource === 'eagle' ? 'asset-masonry' : 'asset-grid'}>
                {activeLoadState === 'loading'
                  ? Array.from({ length: activeAssetSource === 'eagle' ? 8 : 6 }).map((_, index) => (
                      <div
                        key={`asset-skeleton-${index}`}
                        className={activeAssetSource === 'eagle' ? 'asset-masonry-card skeleton' : 'asset-tile skeleton'}
                        aria-hidden="true"
                      >
                        <span className="asset-image-placeholder loading">加载中...</span>
                        <span>
                          <strong />
                          <small />
                        </span>
                      </div>
                    ))
                  : filteredAssets.map((asset) => {
                  const dimensions = assetDimensions[asset.id] || (asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined)
                  const isSelected = selectedAssetIds.includes(asset.id)
                  const imageState = imageLoadStateByAssetId[asset.id] || 'loading'

                  if (activeAssetSource === 'eagle') {
                    return (
                      <article
                        key={asset.id}
                        role="button"
                        tabIndex={0}
                        className={isSelected ? 'asset-masonry-card selected' : 'asset-masonry-card'}
                        draggable
                        onClick={(event) => handleAssetCardClick(asset, event)}
                        onKeyDown={(event) => handleAssetCardKeyDown(asset, event)}
                        onDoubleClick={() => void addAssetToCanvas(asset)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setAssetCardMenu({ assetId: asset.id, x: event.clientX, y: event.clientY })
                        }}
                        onDragStart={(event) => beginAssetDrag(asset, event)}
                      >
                        <label className="asset-select-check" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleAssetSelection(asset.id)}
                            aria-label={`Select ${asset.title}`}
                          />
                        </label>
                        <div className="asset-card-image-frame">
                          {imageState === 'error' ? (
                            <span className="asset-image-placeholder error">图片不可用</span>
                          ) : (
                            <>
                              {imageState === 'loading' ? <span className="asset-image-placeholder loading">加载中...</span> : null}
                              <img
                                src={thumbnailUrlFor(asset)}
                                alt=""
                                onLoad={(event) => handleAssetImageLoad(asset.id, event.currentTarget)}
                                onError={(event) => handleAssetImageError(asset, event.currentTarget)}
                              />
                            </>
                          )}
                        </div>
                        <span>
                          <strong>{asset.title}</strong>
                          <small>
                            {asset.format || 'Image'} · {dimensionsLabel(dimensions)} · {formatBytes(asset.sizeBytes)}
                          </small>
                        </span>
                      </article>
                    )
                  }

                  return (
                    <button
                      key={asset.id}
                      type="button"
                      className={selectedAsset?.id === asset.id ? 'asset-tile selected' : 'asset-tile'}
                      draggable
                      onClick={() => setSelectedAsset(asset)}
                      onDoubleClick={() => void addAssetToCanvas(asset)}
                      onDragStart={(event) => beginAssetDrag(asset, event)}
                    >
                      <div className="asset-card-image-frame">
                        {imageState === 'error' ? (
                          <span className="asset-image-placeholder error">图片不可用</span>
                        ) : (
                          <>
                            {imageState === 'loading' ? <span className="asset-image-placeholder loading">加载中...</span> : null}
                            <img
                              src={thumbnailUrlFor(asset)}
                              alt=""
                              onLoad={(event) => handleAssetImageLoad(asset.id, event.currentTarget)}
                              onError={(event) => handleAssetImageError(asset, event.currentTarget)}
                            />
                          </>
                        )}
                      </div>
                      <span>
                        <strong>{asset.title}</strong>
                        <small>
                          {asset.format} · {dimensionsLabel(dimensions)} · {formatBytes(asset.sizeBytes)}
                        </small>
                      </span>
                    </button>
                  )
                })}
                {activeLoadState === 'ready' && filteredAssets.length === 0 ? (
                  <div className="asset-empty-state">
                    <Image size={18} />
                    <strong>
                      {activeAssetSource === 'eagle'
                        ? eagleStatus.connected
                          ? selectedEagleTag
                            ? `No assets indexed with ${selectedEagleTag}`
                            : 'No Eagle images found'
                          : 'Eagle is offline'
                        : activeAssetSource === 'pinterest'
                          ? 'Pinterest preview'
                          : 'No local images found'}
                    </strong>
                    <span>
                      {activeAssetSource === 'eagle'
                        ? selectedEagleTag
                          ? 'Clear the tag or choose another category.'
                          : eagleStatus.message || 'Open Eagle and keep its local API available.'
                        : activeAssetSource === 'pinterest'
                          ? 'Pinterest boards will appear here after the real connector is wired to Mivo account services.'
                          : localAssetRoot}
                    </span>
                  </div>
                ) : null}
                {activeLoadState === 'error' ? (
                  <div className="asset-empty-state">
                    <FolderOpen size={18} />
                    <strong>{activeAssetSource === 'eagle' ? 'Eagle unavailable' : 'Local folder unavailable'}</strong>
                    <span>{activeAssetSource === 'eagle' ? eagleStatus.message || 'Open Eagle and sync again.' : localAssetRoot}</span>
                  </div>
                ) : null}
              </div>
              {selectedAsset && activeAssetSource !== 'eagle' ? (
                <aside className="asset-detail-panel" aria-label="Asset details">
                  <div className="asset-detail-header">
                    <span className="library-kicker">{selectedAsset.sourceLabel}</span>
                    <button type="button" onClick={() => setSelectedAsset(undefined)} aria-label="Close asset details">
                      <X size={16} />
                    </button>
                  </div>
                  <div className="asset-detail-preview">
                    <img
                      src={thumbnailUrlFor(selectedAsset)}
                      alt=""
                      onError={(event) => fallbackToOriginalAssetImage(selectedAsset, event.currentTarget)}
                    />
                  </div>
                  <div className="asset-detail-copy">
                    <h2>{selectedAsset.title}</h2>
                    <div className="asset-detail-stats" aria-label="Asset summary">
                      <span>
                        <strong>{selectedAsset.format || 'Image'}</strong>
                        <small>Format</small>
                      </span>
                      <span>
                        <strong>{dimensionsLabel(selectedAssetDimensions)}</strong>
                        <small>Dimensions</small>
                      </span>
                      <span>
                        <strong>{formatBytes(selectedAsset.sizeBytes)}</strong>
                        <small>File size</small>
                      </span>
                    </div>
                    <dl className="asset-detail-meta">
                      <div>
                        <dt>Updated</dt>
                        <dd>{formatAssetDate(selectedAsset.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>{selectedAsset.sourcePath}</dd>
                      </div>
                      {selectedAsset.sourceUrl ? (
                        <div>
                          <dt>URL</dt>
                          <dd>{selectedAsset.sourceUrl}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <div className="asset-detail-actions">
                      <button type="button" className="primary" onClick={() => void addAssetToCanvas(selectedAsset)}>
                        <Image size={15} />
                        Add to canvas
                      </button>
                      <button type="button" onClick={() => copyAssetSource(selectedAsset)}>
                        <Copy size={15} />
                        Copy source
                      </button>
                      {selectedAsset.sourceUrl ? (
                        <button type="button" onClick={() => window.open(selectedAsset.sourceUrl, '_blank', 'noopener,noreferrer')}>
                          <ExternalLink size={15} />
                          Open URL
                        </button>
                      ) : null}
                    </div>
                    <p>Double-click a tile to add it to the canvas. Dragging still places it where you drop.</p>
                  </div>
                </aside>
              ) : null}
            </div>
          </section>
        </div>
      ) : (
        <div className="library-layout plugins-layout">
          <section className="plugin-table" aria-label={`${title} list`}>
            <div className="library-section-heading">
              <div>
                <strong>{isSkills ? 'Agent-ready skills' : 'Installed and available'}</strong>
                <span>
                  {isSkills
                    ? 'Skills shape how agents reason, review, plan, and operate inside a canvas.'
                    : 'Plugins add product tools, source connectors, presets, and canvas actions.'}
                </span>
              </div>
              <button type="button">
                <Settings2 size={15} />
                Settings
              </button>
            </div>
            <div className="plugin-list">
              {activeRows.map((plugin) => (
                <button key={plugin.label} type="button" className="plugin-row">
                  <span className="plugin-icon">
                    {plugin.type === 'Connector' ? <Link2 size={17} /> : <Sparkles size={17} />}
                  </span>
                  <span>
                    <strong>{plugin.label}</strong>
                    <small>{plugin.description}</small>
                  </span>
                  <em>{plugin.type}</em>
                  <b className={plugin.status === 'Enabled' ? 'enabled' : ''}>
                    {plugin.status === 'Enabled' ? <CheckCircle2 size={14} /> : null}
                    {plugin.status}
                  </b>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {assetCardMenu && contextMenuAsset ? (
        <div
          className="asset-card-context-menu"
          role="menu"
          style={{ left: assetCardMenu.x, top: assetCardMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => copyOneAsset(contextMenuAsset)}>
            <Copy size={14} />
            Copy
          </button>
        </div>
      ) : null}
      {previewAsset ? (
        <div
          className="asset-lightbox-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPreviewAsset(undefined)
          }}
        >
          <section className="asset-lightbox-panel" role="dialog" aria-modal="true" aria-label="Asset preview">
            <button
              type="button"
              className="asset-lightbox-close"
              aria-label="Close asset preview"
              onClick={() => setPreviewAsset(undefined)}
            >
              <X size={18} />
            </button>
            <div className={`asset-lightbox-image ${previewImageState}`}>
              {previewImageState === 'error' ? (
                <span className="asset-image-placeholder error">图片不可用</span>
              ) : (
                <>
                  {previewImageState === 'loading' ? <span className="asset-image-placeholder loading">加载中...</span> : null}
                  <img
                    src={previewAsset.url || thumbnailUrlFor(previewAsset)}
                    alt=""
                    onLoad={(event) => {
                      rememberDimensions(previewAsset.id, event.currentTarget)
                      setPreviewImageState('ready')
                    }}
                    onError={() => setPreviewImageState('error')}
                  />
                </>
              )}
            </div>
            <div className="asset-lightbox-copy">
              <span className="library-kicker">{previewAsset.sourceLabel}</span>
              <h2>{previewAsset.title}</h2>
              <p>
                {previewAsset.format || 'Image'} · {dimensionsLabel(
                  assetDimensions[previewAsset.id] ||
                    (previewAsset.width && previewAsset.height
                      ? { width: previewAsset.width, height: previewAsset.height }
                      : undefined),
                )} · {formatBytes(previewAsset.sizeBytes)}
              </p>
              <div className="asset-lightbox-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void addAssetToCanvas(previewAsset)}
                  disabled={previewImageState === 'error'}
                >
                  <Image size={15} />
                  Add to canvas
                </button>
                <button type="button" onClick={() => copyOneAsset(previewAsset)} disabled={previewImageState === 'error'}>
                  <Copy size={15} />
                  Copy
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {pinterestSettingsOpen ? (
        <div className="source-settings-backdrop" role="presentation">
          <div className="source-settings-dialog" role="dialog" aria-modal="true" aria-label="Pinterest settings">
            <header className="source-settings-header">
              <div>
                <span className="library-kicker">Pinterest source</span>
                <h2>Connect Pinterest</h2>
                <p>Use Pinterest's official OAuth page. Mivo never asks for your Pinterest password.</p>
              </div>
              <button type="button" className="source-settings-close" aria-label="Close Pinterest settings" onClick={() => setPinterestSettingsOpen(false)}>
                <X size={17} />
              </button>
            </header>

            <div className="source-settings-status">
              <span className={pinterestPrototypeConnected || pinterestStatus?.connected ? 'ready' : ''}>
                <Link2 size={15} />
                {pinterestPrototypeConnected || pinterestStatus?.connected ? 'Account connected' : 'Account not connected'}
              </span>
              <span>
                <ExternalLink size={15} />
                OAuth preview
              </span>
            </div>

            <section className="source-connect-card">
              <div className="source-connect-icon">
                <ExternalLink size={20} />
              </div>
              <div>
                <h3>{pinterestPrototypeConnected || pinterestStatus?.connected ? 'Pinterest is connected' : 'Authorize with Pinterest'}</h3>
                <p>
                  {pinterestPrototypeConnected || pinterestStatus?.connected
                    ? 'Mivo can use your Pinterest authorization token on this device.'
                    : 'Sign in on Pinterest.com and approve Mivo. Your Pinterest password stays with Pinterest.'}
                </p>
              </div>
            </section>

            {pinterestSettingsMessage ? (
              <p className="source-settings-message">{pinterestSettingsMessage}</p>
            ) : null}

            <footer className="source-settings-actions source-auth-actions">
              <button type="button" className="primary" onClick={startPinterestOAuth}>
                <ExternalLink size={15} />
                {pinterestPrototypeConnected || pinterestStatus?.connected ? 'Reconnect Pinterest' : 'Connect Pinterest'}
              </button>
              <button type="button" onClick={() => void loadPinterestSettings()}>
                <RefreshCw size={15} />
                Refresh
              </button>
              <button type="button" onClick={disconnectPinterest} disabled={!pinterestPrototypeConnected && !pinterestStatus?.connected}>
                <Unlink size={15} />
                Disconnect
              </button>
            </footer>

            <p className="source-settings-dev-note">
              This is a product interaction mock. The real connector will use Mivo account services, so users will not
              need to manage App IDs, secrets, scopes, or redirect URLs.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
