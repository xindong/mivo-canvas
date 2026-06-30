import { useCallback, useEffect, useMemo, useState, type DragEvent as ReactDragEvent } from 'react'
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
  type EagleAssetsResponse,
  type EagleFolder,
  type EagleFoldersResponse,
  type EagleStatus,
  type LocalAssetResponse,
  type PinterestStatus,
} from './assetLibraryModel'

type LibraryWorkspaceProps = {
  type: 'assets' | 'plugins' | 'skills'
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

export function LibraryWorkspace({ type, onOpenCanvas }: LibraryWorkspaceProps) {
  const isAssets = type === 'assets'
  const isSkills = type === 'skills'
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const [query, setQuery] = useState('')
  const [localAssetRoot, setLocalAssetRoot] = useState('~/Desktop/images')
  const [localAssets, setLocalAssets] = useState<AssetItem[]>([])
  const [eagleAssets, setEagleAssets] = useState<AssetItem[]>([])
  const [eagleFolders, setEagleFolders] = useState<EagleFolder[]>([])
  const [eagleStatus, setEagleStatus] = useState<EagleStatus>({ connected: false })
  const [pinterestStatus, setPinterestStatus] = useState<PinterestStatus>()
  const [pinterestSettingsOpen, setPinterestSettingsOpen] = useState(false)
  const [pinterestPrototypeConnected, setPinterestPrototypeConnected] = useState(false)
  const [pinterestSettingsMessage, setPinterestSettingsMessage] = useState('')
  const [activeAssetSource, setActiveAssetSource] = useState<AssetSourceId>('local')
  const [selectedEagleFolderId, setSelectedEagleFolderId] = useState<string>()
  const [selectedAsset, setSelectedAsset] = useState<AssetItem>()
  const [assetLoadState, setAssetLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [eagleLoadState, setEagleLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [assetDimensions, setAssetDimensions] = useState<Record<string, { width: number; height: number }>>({})
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
  const activeAssets = useMemo(
    () => (activeAssetSource === 'eagle' ? eagleAssets : activeAssetSource === 'local' ? localAssets : []),
    [activeAssetSource, eagleAssets, localAssets],
  )
  const filteredAssets = useMemo(() => {
    if (activeAssetSource === 'eagle') return activeAssets
    return activeAssets.filter((asset) => assetMatchesQuery(asset, query))
  }, [activeAssetSource, activeAssets, query])
  const flatEagleFolders = useMemo(() => flattenEagleFolders(eagleFolders), [eagleFolders])
  const selectedEagleFolder = useMemo(
    () => flatEagleFolders.find((folder) => folder.id === selectedEagleFolderId),
    [flatEagleFolders, selectedEagleFolderId],
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

  const loadEagleAssets = useCallback(async () => {
    if (!isAssets) return

    setEagleLoadState('loading')
    try {
      const searchParams = new URLSearchParams({ limit: '80' })
      if (selectedEagleFolderId) searchParams.set('folderId', selectedEagleFolderId)
      if (query.trim()) searchParams.set('q', query.trim())
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
  }, [isAssets, query, selectedEagleFolderId])

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
      void loadEagleAssets()
      void loadPinterestStatus()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadEagleAssets, loadLocalAssets, loadPinterestStatus])

  const addAssetToCanvas = useCallback(
    async (asset: AssetItem) => {
      await importImageUrlToCanvas(asset.url, asset.name, { x: 0, y: 0 }, addImportedImage)
      setSelectedAsset(undefined)
      onOpenCanvas?.()
    },
    [addImportedImage, onOpenCanvas],
  )

  const copyAssetSource = useCallback((asset: AssetItem) => {
    void navigator.clipboard?.writeText(asset.sourceUrl || asset.sourcePath || asset.name)
  }, [])

  const beginAssetDrag = useCallback((asset: AssetItem, event: ReactDragEvent<HTMLElement>) => {
    const payload = JSON.stringify({
      id: asset.id,
      name: asset.name,
      title: asset.title,
      url: asset.url,
      sourcePath: asset.sourcePath,
    })

    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(localAssetDragType, payload)
    event.dataTransfer.setData('text/plain', asset.name)
  }, [])

  const syncActiveSource = useCallback(() => {
    if (activeAssetSource === 'eagle') {
      void loadEagleAssets()
      return
    }

    if (activeAssetSource === 'pinterest') {
      void loadPinterestStatus()
      return
    }

    void loadLocalAssets()
  }, [activeAssetSource, loadEagleAssets, loadLocalAssets, loadPinterestStatus])

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

  return (
    <section className="library-workspace" aria-label={`${title} workspace`}>
      <header className="library-header">
        <div>
          <span className="library-kicker">{kicker}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="library-actions">
          <button type="button" onClick={syncActiveSource}>
            <RefreshCw size={16} />
            Sync
          </button>
          <button type="button" className="primary" onClick={connectActiveSource}>
            {isAssets ? <FolderOpen size={16} /> : isSkills ? <Sparkles size={16} /> : <Plug size={16} />}
            {actionLabel}
          </button>
        </div>
      </header>

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

      {isAssets ? (
        <div className="library-layout assets-layout">
          <aside className="source-list" aria-label="Asset sources">
            {assetSources.map(({ id, label, description, meta, status, icon: Icon }) => (
              <button
                key={label}
                type="button"
                className={activeAssetSource === id ? 'source-row active' : 'source-row'}
                onClick={() => {
                  setActiveAssetSource(id)
                  setSelectedAsset(undefined)
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
                    }}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            ) : null}
          </aside>

          <section className="asset-browser" aria-label="Asset browser">
            <div className="library-section-heading">
              <div>
                <strong>
                  {activeAssetSource === 'eagle'
                    ? selectedEagleFolder
                      ? selectedEagleFolder.name
                      : 'Eagle assets'
                    : activeAssetSource === 'pinterest'
                      ? 'Pinterest boards'
                      : 'Recent assets'}
                </strong>
                <span>
                  {activeAssetSource === 'pinterest'
                    ? 'Connect Pinterest OAuth before boards and pins can appear here.'
                    : 'Drag any asset into a canvas as a reference or image node.'}
                </span>
              </div>
              <button
                type="button"
                onClick={activeAssetSource === 'pinterest' ? openPinterestSettings : undefined}
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
            <div className={selectedAsset ? 'asset-browser-content has-detail' : 'asset-browser-content'}>
              <div className="asset-grid">
                {filteredAssets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className={selectedAsset?.id === asset.id ? 'asset-tile selected' : 'asset-tile'}
                    draggable
                    onClick={() => setSelectedAsset(asset)}
                    onDoubleClick={() => void addAssetToCanvas(asset)}
                    onDragStart={(event) => beginAssetDrag(asset, event)}
                  >
                    <img
                      src={thumbnailUrlFor(asset)}
                      alt=""
                      onLoad={(event) => rememberDimensions(asset.id, event.currentTarget)}
                    />
                    <span>
                      <strong>{asset.title}</strong>
                      <small>
                        {asset.format} · {dimensionsLabel(assetDimensions[asset.id] || (asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined))} · {formatBytes(asset.sizeBytes)}
                      </small>
                    </span>
                  </button>
                ))}
                {activeLoadState === 'ready' && filteredAssets.length === 0 ? (
                  <div className="asset-empty-state">
                    <Image size={18} />
                    <strong>
                      {activeAssetSource === 'eagle'
                        ? eagleStatus.connected
                          ? 'No Eagle images found'
                          : 'Eagle is offline'
                        : activeAssetSource === 'pinterest'
                          ? 'Pinterest preview'
                          : 'No local images found'}
                    </strong>
                    <span>
                      {activeAssetSource === 'eagle'
                        ? eagleStatus.message || 'Open Eagle and keep its local API available.'
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
              {selectedAsset ? (
                <aside className="asset-detail-panel" aria-label="Asset details">
                  <div className="asset-detail-header">
                    <span className="library-kicker">{selectedAsset.sourceLabel}</span>
                    <button type="button" onClick={() => setSelectedAsset(undefined)} aria-label="Close asset details">
                      <X size={16} />
                    </button>
                  </div>
                  <div className="asset-detail-preview">
                    <img src={thumbnailUrlFor(selectedAsset)} alt="" />
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
                    {selectedAsset.tags?.length ? (
                      <div className="asset-detail-tags" aria-label="Asset tags">
                        <small>Tags: {selectedAsset.tags.slice(0, 10).join(', ')}</small>
                        {selectedAsset.tags.slice(0, 10).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    ) : null}
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
