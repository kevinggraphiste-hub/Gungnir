/**
 * Gungnir — Disclaimer mobile.
 *
 * Affiché à la place du contenu d'un plugin "lourd" (Forge canvas,
 * SpearCode IDE) quand l'utilisateur est sous le breakpoint md (< 768
 * px). Ces interfaces ont une densité d'information / des interactions
 * (drag-drop nodes, multi-panels, code editor) qui ne se transposent
 * pas honnêtement sur un écran tactile étroit. Plutôt qu'une mauvaise
 * expérience tronquée, on annonce explicitement la limitation et on
 * laisse l'user revenir à son aise sur desktop.
 */
import { Monitor } from 'lucide-react'
import { useBreakpoint } from '../hooks/useBreakpoint'

interface Props {
  children: React.ReactNode
  pluginName: string
  reason?: string
}

export function MobileGate({ children, pluginName, reason }: Props) {
  const breakpoint = useBreakpoint()
  if (breakpoint !== 'mobile') return <>{children}</>

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="max-w-sm text-center">
        <div className="w-16 h-16 mx-auto mb-5 rounded-2xl flex items-center justify-center"
          style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary)' }}>
          <Monitor className="w-7 h-7" />
        </div>
        <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          {pluginName} — meilleur sur desktop
        </h2>
        <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
          {reason || `Ce plugin est conçu pour des écrans larges (≥ 1024 px) avec plusieurs panneaux côte à côte. Sur mobile l'expérience serait dégradée.`}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Reviens sur ordinateur ou tablette en mode paysage pour profiter de {pluginName}.
        </p>
      </div>
    </div>
  )
}
