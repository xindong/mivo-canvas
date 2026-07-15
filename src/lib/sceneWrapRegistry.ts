// sceneWrapRegistry — T2.2 Block 3 (A2-S4) scene-scoped server-wire 注入注册表(C 方案)。
//
// 背景:documentSlice / generationSlice / nodeCreationSlice 由 canvasStore 组合;若它们
// 静态 import canvas/actions/canvasSyncRuntime,会构成 store → canvas → store 环
// (canvasSyncRuntime 反向 import useCanvasStore / documentFor 等 store 内核)——
// structure-guard 红线 + A 方案判死的原因。本注册表是无环中转点:
//   - canvasSyncRuntime(canvas 层)在模块顶层 side-effect 调 registerSceneWrap,
//     注册 wrapMutationForScene 的执行适配(canvas → lib 方向合法,海量先例)。
//   - store 层消费点(documentSlice.commitGenerationResult set 段 / nodeCreationSlice
//     addImportedFileNode / generationSlice 失败槽位)从 getSceneWrap() 取,不经静态环。
//
// fail-visible(硬要求①):server-persist 模式下若注册表为空还被消费(注册未跑),
// 不静默 passthrough 吞掉同步——留 debugLogger.error 痕迹后仍 mutate(本地态照更新,
// 但 server 不知,可观测地暴露)。local 模式 passthrough 正常(与 wrapMutationForScene
// 的 isLocalPersist gate 对称:local 无 server port,mutate 即可,无需 submit)。
//
//   说明:预检记「零 import」,但 fail-visible 需在默认 passthrough 内区分 local/server
//   并留痕 → 必须读 isLocalPersist + 调 debugLogger。两者皆 leaf(persistMode 只引
//   debugLogStore;debugLogStore 只引 remoteDebugReporter),不构成 store→canvas→store 环,
//   structure-guard 也不扫 src/lib。故将「零 import」让位于硬要求①,只引两 leaf,集中
//   fail-visible 于注册表默认 passthrough,消费点零签名改动(只调 getSceneWrap())。
//
// boot 时序(硬要求②):canvasSyncRuntime 经 generationFacade(chatStore 静态 import 它)
// 进入 useStoreHydration 的模块求值链;reconcileExpiredChatTasks 在 useStoreHydration 的
// useEffect 内跑(渲染期所有组件模块已求值),注册必先于消费,无需 boot 装配处显式 import。
//
// 两函数:registerSceneWrap / getSceneWrap。消费点零签名改动,只调 getSceneWrap()。

import { isLocalPersist } from './persistMode'
import { debugLogger } from '../store/debugLogStore'

const SOURCE = 'Scene Wrap Registry'

/**
 * scene-scoped mutation wrap 契约:(sceneId, mutate) → 同步执行 mutate 并在 server-persist
 * 模式下把 before/after diff 经 submitChange 落 server(由注册的 wrapMutationForScene 实现)。
 * 与 canvasStateTypes.SceneScopedMutate 同形(generationSlice 的 onSceneMutation 注入点)。
 */
export type SceneWrap = (sceneId: string, mutate: () => void) => void

// 默认 passthrough:registry 未注册时的兜底。
// - local 模式:mutate() 即可(无 server port,与 wrapMutationForScene 的 isLocalPersist gate 对称)。
// - server-persist 模式:注册表空 = 注册未跑(boot 链断 / 测试未注入)→ 不静默吞同步,留 error
//   痕迹后仍 mutate(本地态更新,server 不知 —— fail-visible,可观测)。
const passthrough: SceneWrap = (sceneId, mutate) => {
  if (!isLocalPersist) {
    debugLogger.error(
      SOURCE,
      `registry empty in server-persist mode; sync swallowed for scene ${sceneId} (registerSceneWrap not called — canvasSyncRuntime side-effect not evaluated at boot?)`,
    )
  }
  mutate()
}

let registered: SceneWrap | null = null

/** canvasSyncRuntime 模块顶层 side-effect 调用,注册 wrapMutationForScene 执行适配。 */
export const registerSceneWrap = (fn: SceneWrap): void => {
  registered = fn
}

/** 消费点取 wrap:已注册 → wrapMutationForScene 适配;未注册 → fail-visible passthrough。 */
export const getSceneWrap = (): SceneWrap => registered ?? passthrough
