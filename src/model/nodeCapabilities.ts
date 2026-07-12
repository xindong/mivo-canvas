export type CanvasObjectCapability =
  | 'selectable'
  | 'movable'
  | 'resizable'
  | 'layerable'
  | 'groupable'
  | 'lockable'
  | 'hideable'
  | 'exportable'
  | 'downloadOriginal'
  | 'asset'
  | 'imageAsset'
  | 'text'
  | 'frame'
  | 'promptSource'
  | 'aiReference'
  | 'aiEditable'
  | 'videoAsset'
  | 'pdfAsset'
  | 'markdownDoc'
  | 'annotatable'
  | 'markup'
  | 'task'
  | 'aiSlot'
  | 'annotation'
  | 'aiResult'

export const baseObjectCapabilities: CanvasObjectCapability[] = [
  'selectable',
  'movable',
  'resizable',
  'layerable',
  'groupable',
  'lockable',
  'hideable',
  'exportable',
]

export const organizationCapabilities: CanvasObjectCapability[] = [
  'selectable',
  'lockable',
  'hideable',
]
