// src/canvas/useNodeTransform.contract.test.ts
// FU-2: beginNodeMoveFromShell 的 captureTarget 契约 + shellRef.current null 安全。
//
// 1b-4 shell dispatch 把 per-node pointerdown 改为 shell → resolveCanvasHit → onNodePointerDown
// → beginNodeMoveFromShell。move 流程的 pointer capture 必须落在 shellRef.current 上(节点
// .dom-node 是 pointer-events:none,事件不回流),否则拖出节点 bbox 后 pointermove 丢失。
// beginNodeMoveFromShell 的签名 `(nodeId, event, captureTarget?)` 允许调用方显式传 capture
// target,默认 fallback 到 shellRef.current;captureTarget?.setPointerCapture 的 optional
// chaining 保证 shellRef.current 为 null(测试/未挂载场景)时不崩溃。
//
// 为什么源码契约(非 runtime render test):项目无 React hook render harness(无
// @testing-library/react、无 jsdom/happy-dom,见 scene-reset.contract.test.ts 说明)。
// 源码契约验证 capture fallback 表达式 + null 安全结构,防回潮:未来若有人把 `?? shellRef.current`
// 误删、或把 `?.` 改回 `.`,本测试 fail。

import { describe, expect, it } from 'vitest'
import useNodeTransformSource from './useNodeTransform.ts?raw'
import canvasToolHandlersSource from './canvasToolHandlers.ts?raw'

describe('beginNodeMoveFromShell capture contract (FU-2)', () => {
  it('shell dispatch 入口默认 captureTarget = shellRef.current(fallback)', () => {
    // beginNodeMoveFromShell(nodeId, event, captureTarget?) →
    //   beginNodeMoveWithCapture(nodeId, event, captureTarget ?? shellRef.current)
    // 调用方不传 captureTarget 时( canvasToolHandlers 的默认路径)走 shellRef.current,
    // 让 move 流程的 pointer capture 落在 shell 上,pointer 出节点 bbox 不丢 pointermove。
    expect(useNodeTransformSource).toContain('captureTarget ?? shellRef.current')
    expect(useNodeTransformSource).toMatch(/beginNodeMoveFromShell[\s\S]*captureTarget \?\? shellRef\.current/)
  })

  it('setPointerCapture 用 optional chaining —— shellRef.current null 不崩溃', () => {
    // captureTarget?.setPointerCapture(event.pointerId):shellRef.current 为 null(测试
    // mock / shell 未挂载 / ref 还没赋值)时 captureTarget 为 null,?. 跳过 setPointerCapture,
    // 不抛 TypeError。这是 "shellRef.current null 路径" 的结构保证。
    expect(useNodeTransformSource).toContain('captureTarget?.setPointerCapture')
    // 确保 没有 裸 captureTarget.setPointerCapture(无 ?. 的旧写法回潮会 fail)
    expect(useNodeTransformSource).not.toMatch(/[^?]captureTarget\.setPointerCapture/)
  })

  it('per-node 入口 beginNodeMove 仍用 event.currentTarget(非 shellRef)', () => {
    // beginNodeMove 是 per-node dispatch 旧入口(节点自己的 onPointerDown),captureTarget
    // = event.currentTarget(节点 DOM 本身)。1b-4 不能误改成 shellRef——per-node 入口
    // 的 DOM 还在,capture 该落节点自己。
    expect(useNodeTransformSource).toContain('beginNodeMoveWithCapture(nodeId, event, event.currentTarget)')
  })

  it('canvasToolHandlers 的 select/text/frame onNodePointerDown 切到 beginNodeMoveFromShell', () => {
    // 详设 1b-4:select/text/frame 的 onNodePointerDown 调 beginNodeMoveFromShell(不是
    // beginNodeMove)。验证三处调用都切了(shell dispatch 路径),防回退到 per-node beginNodeMove。
    const matches = canvasToolHandlersSource.match(/beginNodeMoveFromShell/g)
    expect(matches, 'expected ≥3 beginNodeMoveFromShell calls (select/text/frame + type sig)').not.toBeNull()
    expect((matches as string[]).length).toBeGreaterThanOrEqual(4)
    // 同时确保没有 onNodePointerDown 误调旧 beginNodeMove(per-node 入口)
    expect(canvasToolHandlersSource).not.toMatch(/onNodePointerDown[\s\S]{0,400}context\.beginNodeMove\b(?!FromShell)/)
  })
})
