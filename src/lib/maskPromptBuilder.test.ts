// src/lib/maskPromptBuilder.test.ts
// 外壳包裹 + 锚点方位计算单测（逐条编辑要求由 LLM 整理，不在此模块）。
import { describe, it, expect } from 'vitest'
import { anchorPositions, buildDualImagePrompt } from './maskPromptBuilder'
import type { ImageMaskBounds } from '../canvas/imageMaskGeometry'

const b = (x: number, y: number): ImageMaskBounds => ({ x, y, width: 100, height: 100 })

describe('buildDualImagePrompt — 图1/图2 结构外壳', () => {
  it('把整理后的逐条正文包进固定头尾', () => {
    const prompt = buildDualImagePrompt(
      '1.务必只去除图2中1号红圈（最左侧）范围内的蓝色烟雾。画面中其他蓝色烟雾一律保留，不要误删其他蓝色烟雾。\n2.将图2中2号红圈范围内的左眼改成红色。',
    )
    expect(prompt).toContain('帮我对图1进行优化修改')
    expect(prompt).toContain('我在图2上圈出了编辑的具体位置')
    expect(prompt).toContain('编辑要求：')
    expect(prompt).toContain('1.务必只去除图2中1号红圈（最左侧）范围内的蓝色烟雾')
    expect(prompt).toContain('2.将图2中2号红圈范围内的左眼改成红色')
    expect(prompt).toContain('务必每一条都严格执行并复查。')
  })

  it('去除正文首尾空白', () => {
    expect(buildDualImagePrompt('  去除蓝色烟雾  ')).toContain('编辑要求：\n去除蓝色烟雾\n')
  })
})

describe('anchorPositions — 极端位置词', () => {
  it('单圈无位置词', () => {
    expect(anchorPositions([b(0, 0)])).toEqual([undefined])
  })

  it('横向分布 → 最左侧/最右侧，中间为 undefined', () => {
    expect(anchorPositions([b(50, 400), b(500, 400), b(900, 400)])).toEqual(['最左侧', undefined, '最右侧'])
  })

  it('纵向分布 → 最上方/最下方', () => {
    expect(anchorPositions([b(500, 100), b(510, 1500)])).toEqual(['最上方', '最下方'])
  })
})
