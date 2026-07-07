// @vitest-environment node
// server/__tests__/maskRegion.test.ts
// Unit tests for the instruction-based mask-edit spatial clause builder —
// 现在只覆盖「无 markedImage」的文字回退路径（双图主路径的提示词由前端
// src/lib/maskPromptBuilder.ts 拼装，单测在 src/lib/maskPromptBuilder.test.ts）。
import { describe, it, expect } from 'vitest'
import { maskRegionPromptClause, maskSubjectsPromptClause, withMaskRegionClause } from '../lib/maskRegion'

const size = JSON.stringify({ width: 400, height: 200 })

describe('maskRegionPromptClause — single subject (fallback, 中文)', () => {
  it('leads with the subject label and forbids drawing a box', () => {
    const clause = maskRegionPromptClause(JSON.stringify({ x: 100, y: 50, width: 200, height: 100 }), size, '蓝色云朵')
    expect(clause).toContain('只修改位于图片')
    expect(clause).toContain('的蓝色云朵')
    expect(clause).toContain('不要在图上画出任何矩形')
  })

  it('falls back to a generic clause when bounds are missing', () => {
    const clause = maskRegionPromptClause(undefined, size, '')
    expect(clause).toContain('只修改用户选中的区域')
    expect(clause).toContain('不要在图上画出任何矩形')
  })
})

describe('maskSubjectsPromptClause — multi-anchor (fallback, 中文)', () => {
  it('returns undefined when there are no usable subjects', () => {
    expect(maskSubjectsPromptClause(undefined, size)).toBeUndefined()
    expect(maskSubjectsPromptClause(JSON.stringify([]), size)).toBeUndefined()
    expect(maskSubjectsPromptClause(JSON.stringify([{ label: 'x' }]), size)).toBeUndefined() // no bounds
  })

  it('single subject in the array reads like the single-region clause', () => {
    const clause = maskSubjectsPromptClause(
      JSON.stringify([{ label: '眼睛', bounds: { x: 40, y: 20, width: 40, height: 20 } }]),
      size,
    )
    expect(clause).toBeTruthy()
    expect(clause).toContain('只修改位于图片')
    expect(clause).toContain('的眼睛')
    expect(clause).not.toContain('标记区域')
  })

  it('multiple subjects produce a numbered list of all labels', () => {
    const clause = maskSubjectsPromptClause(
      JSON.stringify([
        { label: '眼睛', bounds: { x: 40, y: 20, width: 40, height: 20 } },
        { label: '头发', bounds: { x: 10, y: 5, width: 120, height: 60 } },
      ]),
      size,
    )
    expect(clause).toBeTruthy()
    expect(clause).toContain('以下 2 个标记区域')
    expect(clause).toContain('(1) 位于图片')
    expect(clause).toContain('的眼睛')
    expect(clause).toContain('(2) 位于图片')
    expect(clause).toContain('的头发')
    expect(clause).toContain('不要在图上画出任何矩形')
  })

  it('drops subjects with empty/invalid bounds but keeps valid ones', () => {
    const clause = maskSubjectsPromptClause(
      JSON.stringify([
        { label: '眼睛', bounds: { x: 40, y: 20, width: 40, height: 20 } },
        { label: '坏的', bounds: { x: 0, y: 0, width: 0, height: 0 } },
      ]),
      size,
    )
    // Only one valid subject remains → single-region phrasing, no list.
    expect(clause).toContain('的眼睛')
    expect(clause).not.toContain('标记区域')
  })
})

describe('withMaskRegionClause — dispatch precedence (fallback path)', () => {
  it('prefers the subjects list over the single subjectLabel', () => {
    const prompt = withMaskRegionClause(
      '把它们变红',
      JSON.stringify({ x: 100, y: 50, width: 200, height: 100 }),
      size,
      '蓝色云朵', // legacy single — should be ignored when subjects present
      JSON.stringify([
        { label: '眼睛', bounds: { x: 40, y: 20, width: 40, height: 20 } },
        { label: '头发', bounds: { x: 10, y: 5, width: 120, height: 60 } },
      ]),
    )
    expect(prompt).toContain('把它们变红')
    expect(prompt).toContain('以下 2 个标记区域')
    expect(prompt).not.toContain('蓝色云朵')
  })

  it('falls back to the single subjectLabel clause when no subjects', () => {
    const prompt = withMaskRegionClause(
      '把它变红',
      JSON.stringify({ x: 100, y: 50, width: 200, height: 100 }),
      size,
      '蓝色云朵',
    )
    expect(prompt).toContain('的蓝色云朵')
  })
})
