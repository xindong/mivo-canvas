import {
  CheckCircle2,
  Database,
  FolderOpen,
  Image,
  Link2,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react'

type LibraryWorkspaceProps = {
  type: 'assets' | 'plugins' | 'skills'
}

const assetSources = [
  {
    label: 'Local folders',
    description: 'Index local image folders without copying files.',
    meta: '~/Desktop/images',
    status: 'Connected',
    icon: FolderOpen,
  },
  {
    label: 'Eagle libraries',
    description: 'Read folders, tags, ratings, notes, and original paths.',
    meta: 'Creative references',
    status: 'Connect',
    icon: Database,
  },
  {
    label: 'Pinterest boards',
    description: 'Use online boards as linked inspiration references.',
    meta: 'Source URLs preserved',
    status: 'Connect',
    icon: Link2,
  },
]

const assetItems = [
  { title: 'Courage Study 01', source: 'Generated', src: '/demo-assets/courage-1.jpg' },
  { title: 'Courage Study 02', source: 'Local folder', src: '/demo-assets/courage-2.jpg' },
  { title: 'Courage Study 03', source: 'Eagle draft', src: '/demo-assets/courage-3.jpg' },
]

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

export function LibraryWorkspace({ type }: LibraryWorkspaceProps) {
  const isAssets = type === 'assets'
  const isSkills = type === 'skills'
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

  return (
    <section className="library-workspace" aria-label={`${title} workspace`}>
      <header className="library-header">
        <div>
          <span className="library-kicker">{kicker}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="library-actions">
          <button type="button">
            <RefreshCw size={16} />
            Sync
          </button>
          <button type="button" className="primary">
            {isAssets ? <FolderOpen size={16} /> : isSkills ? <Sparkles size={16} /> : <Plug size={16} />}
            {actionLabel}
          </button>
        </div>
      </header>

      <div className="library-searchbar">
        <Search size={16} />
        <input placeholder={searchPlaceholder} />
      </div>

      {isAssets ? (
        <div className="library-layout assets-layout">
          <aside className="source-list" aria-label="Asset sources">
            {assetSources.map(({ label, description, meta, status, icon: Icon }) => (
              <button key={label} type="button" className={status === 'Connected' ? 'source-row active' : 'source-row'}>
                <Icon size={18} />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <em>{status}</em>
                <i>{meta}</i>
              </button>
            ))}
          </aside>

          <section className="asset-browser" aria-label="Asset browser">
            <div className="library-section-heading">
              <div>
                <strong>Recent assets</strong>
                <span>Drag any asset into a canvas as a reference or image node.</span>
              </div>
              <button type="button">
                <Image size={15} />
                View all
              </button>
            </div>
            <div className="asset-grid">
              {assetItems.map((asset) => (
                <button key={asset.title} type="button" className="asset-tile">
                  <img src={asset.src} alt="" />
                  <span>
                    <strong>{asset.title}</strong>
                    <small>{asset.source}</small>
                  </span>
                </button>
              ))}
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
    </section>
  )
}
