/**
 * Gungnir — Responsive breakpoint hook.
 *
 * Aligne sur les breakpoints Tailwind par défaut :
 *   mobile  : < 768px  (md)
 *   tablet  : 768-1023px
 *   desktop : ≥ 1024px (lg)
 *
 * Utilise matchMedia pour réagir au resize sans polling. SSR-safe (renvoie
 * "desktop" si window n'existe pas, ce qui est le pire cas le moins
 * destructeur — l'app desktop est l'expérience par défaut).
 */
import { useEffect, useState } from 'react'

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

const MQ_MOBILE = '(max-width: 767px)'
const MQ_TABLET = '(min-width: 768px) and (max-width: 1023px)'

function detect(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'desktop'
  if (window.matchMedia(MQ_MOBILE).matches) return 'mobile'
  if (window.matchMedia(MQ_TABLET).matches) return 'tablet'
  return 'desktop'
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(detect)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mqM = window.matchMedia(MQ_MOBILE)
    const mqT = window.matchMedia(MQ_TABLET)
    const update = () => setBp(detect())
    // matchMedia.addEventListener est plus propre que onChange pour ne pas
    // perdre le listener en cas de re-render.
    mqM.addEventListener('change', update)
    mqT.addEventListener('change', update)
    return () => {
      mqM.removeEventListener('change', update)
      mqT.removeEventListener('change', update)
    }
  }, [])

  return bp
}

export function useIsMobile(): boolean {
  return useBreakpoint() === 'mobile'
}
