/**
 * Gungnir — InfoButton
 *
 * Small clickable "i" that opens a pedagogical popover on click. The popover
 * is rendered in a React portal on document.body so it escapes every parent
 * with overflow:hidden; its position is computed from the trigger's bounding
 * rect and clamped inside the viewport (with an upward flip when there's no
 * room below). Click anywhere outside to dismiss.
 *
 * Usage:
 *   import InfoButton from '@core/components/InfoButton'
 *   <label>Intervalle <InfoButton>Explication détaillée…</InfoButton></label>
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

const POPOVER_WIDTH = 288 // matches w-72
const POPOVER_MARGIN = 12

interface InfoButtonProps {
  children: React.ReactNode
  /** Optional accessible label override. Defaults to "Plus d'informations". */
  ariaLabel?: string
  /** Optional class override on the trigger button (keeps default icon sizing). */
  className?: string
}

export default function InfoButton({ children, ariaLabel, className }: InfoButtonProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number; flip: boolean } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const recompute = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    // Horizontal: align on the button's left, clamp inside viewport
    let left = rect.left
    if (left + POPOVER_WIDTH > viewportW - POPOVER_MARGIN) {
      left = viewportW - POPOVER_WIDTH - POPOVER_MARGIN
    }
    if (left < POPOVER_MARGIN) left = POPOVER_MARGIN

    // Vertical: below the button by default, flip above if no room
    const estimatedH = 200 // rough upper bound for these popovers
    const spaceBelow = viewportH - rect.bottom
    const flip = spaceBelow < estimatedH + POPOVER_MARGIN
    const top = flip ? rect.top - 6 : rect.bottom + 6
    setCoords({ top, left, flip })
  }, [])

  useEffect(() => {
    if (!open) return
    recompute()
    const onScroll = () => recompute()
    const onResize = () => recompute()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, recompute])

  return (
    <span className="relative inline-block align-middle ml-1">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        className={
          className ??
          'inline-flex items-center justify-center w-4 h-4 rounded-full transition-opacity hover:opacity-100'
        }
        style={{ background: 'transparent', color: 'var(--text-muted)', opacity: 0.7 }}
        aria-label={ariaLabel || "Plus d'informations"}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && coords && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[61] p-3 rounded-lg text-[11px] leading-relaxed shadow-xl"
            style={{
              top: coords.top,
              left: coords.left,
              width: POPOVER_WIDTH,
              transform: coords.flip ? 'translateY(-100%)' : undefined,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
            }}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </span>
  )
}
