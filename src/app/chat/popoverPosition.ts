import { useLayoutEffect, useState, type RefObject } from 'react'

type PopoverPosition = {
  left: number
  top: number
}

export const useAnchoredPopoverPosition = (
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
) => {
  const [position, setPosition] = useState<PopoverPosition>({ left: 12, top: 12 })

  useLayoutEffect(() => {
    if (!open) return

    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return

      const rect = anchor.getBoundingClientRect()
      const margin = 12
      const left = Math.min(
        Math.max(rect.left, margin),
        Math.max(margin, window.innerWidth - width - margin),
      )
      setPosition({
        left,
        top: Math.max(margin, rect.top - 8),
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)

    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, open, width])

  return position
}
