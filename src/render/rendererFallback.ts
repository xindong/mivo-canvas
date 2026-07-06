import type { RendererMode } from './rendererMode'

/**
 * 降级管道（PR-R1）：pixi 或 leafer 任一 init 失败（fallbackToDom=true）→
 * effectiveRendererMode 降到 'dom'，DOM 接管全部节点
 * （filterDomNodesForRendererSpike 在 'dom' 模式原样返回，非白屏）。
 *
 * 纯函数，不依赖 leafer-ui / pixi.js，可单测；与 usePixiSpikeRenderer 的
 * fallbackToDom 和 useLeaferSpikeRenderer 的 fallbackToDom 同口径。
 *
 * 两段式调用：先只看 pixi 算出 pixiEffectiveMode 喂给 leafer hook（leafer 在
 * pixi 已失败时不应再 init），再用 leafer 的 fallbackToDom 算最终 effectiveRendererMode。
 */
export const computeEffectiveRendererMode = (
  rendererMode: RendererMode,
  pixiFallbackToDom: boolean,
  leaferFallbackToDom: boolean,
): RendererMode => (pixiFallbackToDom || leaferFallbackToDom ? 'dom' : rendererMode)
