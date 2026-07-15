// src/canvas/actions/canvasSyncRuntimeTestFactories.ts
// Shared test factory for the canvasSyncRuntime test suite. Extracted so both the
// Block 3 主套件(canvasSyncRuntime.test.ts)与 Block 2 assetUrl-diff 套件
// (canvasSyncRuntime.asseturldiff.test.ts)能共用 imageNode/nodeRecord/loadRuntimeModule,
// 不重复 ~70 行 mock 装配(structure-guard 上限非 allowlist 文件 900 行,同 canvasCommandExecutorTestFactories 先例)。
// 非 test 文件(无 describe/it)—— 纯工厂模块,被两个套件 import。
//
// vi.resetModules()/vi.doMock 是运行时调用,工厂模块内调用与原 test 文件内调用语义一致;
// 各 test 文件仍各自保留文件级 vi.hoisted(localStorage shim)+ vi.mock(demoImages/remoteDebugReporter)
// ——vitest 的 hoisted mock 必须 per-file,不能下沉到工厂模块。

import { vi } from 'vitest'
import type { MivoCanvasNode } from '../../types/mivoCanvas'
import type { NodeRecord } from '../../kernel/records'
import type { CanvasChange, ChangeOutcome, CanvasSyncPort } from '../../lib/canvasSyncPort'

export const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 120,
  height: 80,
  status: 'ready',
  assetUrl: '/image.png',
  ...overrides,
})

export const nodeRecord = (overrides: Partial<NodeRecord> = {}): NodeRecord => ({
  id: 'n1',
  type: 'image',
  title: 'Image',
  revision: 0,
  transform: { x: 10, y: 20, width: 120, height: 80, rotation: 0 },
  fills: [],
  strokes: [],
  effects: [],
  relations: {},
  ...overrides,
})

export const loadRuntimeModule = async (
  options: {
    local?: boolean
    submitChangeImpl?: (canvasId: string, change: CanvasChange) => Promise<ChangeOutcome>
    abortPendingCreateImpl?: (port: CanvasSyncPort, canvasId: string, change: CanvasChange, detail: string) => boolean
  } = {},
) => {
  vi.resetModules()
  const submitChange = vi.fn(
    options.submitChangeImpl ??
      (async () => ({
        kind: 'accepted' as const,
        cursor: 'cursor' as never,
      })),
  )
  const abortPendingCreate = vi.fn(options.abortPendingCreateImpl ?? (() => false))
  // Block 3: mock assetAttachWiring —— 透传真 serverAssetIdFromUrl(URL 过滤逻辑走真路径),enqueueAssetAttach/Detach
  // 为 spy(验 submitChanges accepted 后的 enqueue 行为)。在 doMock persistMode 之后 import 真 assetAttachWiring,
  // 保证 persistBoot→canvasStore 链拿 mock persistMode。
  vi.doMock('../../lib/persistMode', () => ({
    isLocalPersist: options.local ?? false,
  }))
  vi.doMock('../../lib/canvasSyncPortClient', () => ({
    getCanvasSyncPort: () => ({ submitChange }),
    abortPendingCanvasSyncCreate: abortPendingCreate,
    persistMode: options.local ? 'local' : 'server',
  }))
  const realAssetWiring = await import('../../lib/assetAttachWiring')
  const enqueueAssetAttach = vi.fn()
  const enqueueAssetDetach = vi.fn()
  vi.doMock('../../lib/assetAttachWiring', () => ({
    serverAssetIdFromUrl: realAssetWiring.serverAssetIdFromUrl,
    enqueueAssetAttach,
    enqueueAssetDetach,
  }))
  const mod = await import('./canvasSyncRuntime')
  const { useCanvasStore } = await import('../../store/canvasStore')
  const { useDebugLogStore } = await import('../../store/debugLogStore')
  return { ...mod, useCanvasStore, useDebugLogStore, submitChange, abortPendingCreate, enqueueAssetAttach, enqueueAssetDetach }
}
