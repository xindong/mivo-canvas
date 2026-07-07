// 从 ImageMaskEditOverlay 机械抽离(structure guard >900),行为不变
import { useCallback, useEffect, useRef, useState } from 'react'
import { boundsForRegions, type ImageMaskRegion } from './imageMaskGeometry'
import {
  anchorContextBlob,
  cropRegionBlob,
  describeRegionCrop,
  type RegionCandidate,
} from '../lib/regionDescribe'

// Per-anchor recognition state (Lovart-style multi-anchor). selectedIndex -1 =
// the custom-text option; otherwise an index into candidates.
export type AnchorRecognition = {
  candidates: RegionCandidate[]
  selectedIndex: number
  customLabel: string
  recognizing: boolean
}

// Selected label for one anchor's recognition ('' when none / not yet resolved).
export const recognitionLabel = (rec: AnchorRecognition | undefined): string => {
  if (!rec) return ''
  return (rec.selectedIndex >= 0 ? rec.candidates[rec.selectedIndex]?.label ?? '' : rec.customLabel).trim()
}

export function useMaskAnchorRecognition({
  regions,
  naturalSize,
  resolvedAssetUrl,
}: {
  regions: ImageMaskRegion[]
  naturalSize: { width: number; height: number }
  resolvedAssetUrl: string
}) {
  // Anchor semantics（Lovart 式多锚点）：每个锚点各自识别，返回「由粗到细」的候选
  // 列表（整体主体 … 具体部位）。每个锚点一个标签块内嵌进输入框（富文本式），点
  // 箭头展开自己的「已标记对象」卡切换/自定义。识别只是辅助，失败静默。
  // recognitions 按 regionKey 存每个锚点的识别态；ref 镜像供 effect 读取不触发重跑。
  const [recognitions, setRecognitions] = useState<Record<string, AnchorRecognition>>({})
  const recognitionsRef = useRef<Record<string, AnchorRecognition>>({})
  const writeRecognitions = useCallback(
    (updater: (current: Record<string, AnchorRecognition>) => Record<string, AnchorRecognition>) => {
      const next = updater(recognitionsRef.current)
      recognitionsRef.current = next
      setRecognitions(next)
    },
    [],
  )
  // 每个锚点识别请求的独立 AbortController，按 regionKey 存；只在卸载时全部中止。
  const recognitionAbortRef = useRef<Map<string, AbortController>>(new Map())
  // openChipKey：当前展开卡片的锚点 key；null 表示收起。
  const [openChipKey, setOpenChipKey] = useState<string | null>(null)

  // Stable per-anchor key from its rounded natural-pixel bounds — identity for
  // storing/looking up recognition state across immutable region-array updates.
  const regionKey = useCallback(
    (region: ImageMaskRegion): string => {
      const bounds = boundsForRegions([region], naturalSize)
      return bounds ? [bounds.x, bounds.y, bounds.width, bounds.height].map((v) => Math.round(v)).join(':') : ''
    },
    [naturalSize],
  )

  // Anchor semantics（多锚点）：每个新锚点落定 600ms 后各自裁剪送识别，结果按
  // regionKey 存进 recognitions。已识别过的锚点不重复调；单点锚点把锚点位置画进
  // 裁剪图（红圈），让识别只描述锚点指向的部位。识别只是提示，失败静默不阻塞。
  // 关键：每个锚点用【独立】AbortController。新增锚点导致 regions 变化时，effect
  // 清理只取消尚未触发的 debounce，绝不中止已在飞的请求——否则后放的锚点会把先放
  // 锚点的在途请求打断，令其永远停在「识别中」（服务端已返回但客户端丢弃）。
  useEffect(() => {
    if (!regions.length) return undefined
    const pending = regions
      .map((region) => ({ region, key: regionKey(region) }))
      .filter(({ key }) => key && !(key in recognitionsRef.current))
    if (!pending.length) return undefined

    const controllers = recognitionAbortRef.current
    const timer = window.setTimeout(() => {
      // 先给待识别锚点置 recognizing 占位，避免重复 kick + 让标签块显示「识别中」。
      writeRecognitions((current) => {
        const next = { ...current }
        for (const { key } of pending) {
          if (!(key in next)) next[key] = { candidates: [], selectedIndex: -1, customLabel: '', recognizing: true }
        }
        return next
      })
      for (const { region, key } of pending) {
        const controller = new AbortController()
        controllers.set(key, controller)
        void (async () => {
          const bounds = boundsForRegions([region], naturalSize)
          if (!bounds) return
          const marker =
            region.type === 'brush' && region.points.length === 1
              ? { x: region.points[0].x, y: region.points[0].y }
              : undefined
          // 双图识别:全图缩略(红圈标锚点位置)给全局归属,放大特写给细节 —— 修
          // 「点在衣服花纹上只认出图案、候选里没有衣服」的裁剪视野问题。
          const [crop, contextImage] = await Promise.all([
            cropRegionBlob(resolvedAssetUrl, naturalSize, bounds, controller.signal, marker),
            marker ? anchorContextBlob(resolvedAssetUrl, naturalSize, marker, controller.signal) : Promise.resolve(null),
          ])
          const list = crop ? await describeRegionCrop(crop, controller.signal, contextImage) : []
          controllers.delete(key)
          if (controller.signal.aborted) return
          writeRecognitions((current) => ({
            ...current,
            // 默认选最具体的部位（列表末位）；列表为空则留在自定义。
            [key]: {
              candidates: list,
              selectedIndex: list.length ? list.length - 1 : -1,
              customLabel: '',
              recognizing: false,
            },
          }))
        })()
      }
    }, 600)
    // 只清 debounce 定时器；在飞的各锚点请求让它们各自跑完（不 abort）。
    return () => window.clearTimeout(timer)
  }, [regions, naturalSize, resolvedAssetUrl, regionKey, writeRecognitions])

  // 组件卸载时统一中止所有在途识别请求（防卸载后 setState）。
  useEffect(() => {
    const controllers = recognitionAbortRef.current
    return () => {
      controllers.forEach((controller) => controller.abort())
      controllers.clear()
    }
  }, [])

  return {
    recognitions,
    recognitionsRef,
    writeRecognitions,
    recognitionAbortRef,
    openChipKey,
    setOpenChipKey,
    regionKey,
  }
}
