/**
 * Gungnir — Nébuleuse : graphe interactif des interconnexions
 * outils/workflows/agents/MCP/channels/services dans le module Conscience.
 *
 * Spec user 2026-05-03. Backend : GET /api/plugins/consciousness/nebula
 * renvoie {nodes, edges, stats} déjà au format Cytoscape.
 *
 * Filtres par type, panel détails au survol, layout force-directed,
 * légende couleur cohérente avec backend nebula.py:_TOOL_CATEGORIES.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Network, RefreshCw, Eye, EyeOff } from 'lucide-react'
import cytoscape, { Core, ElementDefinition } from 'cytoscape'
import { apiFetch } from '../../core/services/api'

interface NebulaNode {
  id: string
  label: string
  type: string
  category: string
  color: string
  description?: string
  enabled?: boolean
  level?: number  // 0 = core, 1 = catégorie, 2 = feuille (tool/workflow/agent…)
}

interface NebulaEdge {
  source: string
  target: string
  label?: string
  color?: string
}

interface NebulaData {
  nodes: NebulaNode[]
  edges: NebulaEdge[]
  stats: Record<string, number>
}

const TYPE_LABELS: Record<string, string> = {
  core: 'Coeur',
  category: 'Catégories',
  tool: 'Outils',
  workflow: 'Workflows',
  subagent: 'Sous-agents',
  mcp: 'MCP Servers',
  channel: 'Canaux',
  service: 'Services',
}

const TYPE_COLORS: Record<string, string> = {
  core: '#06b6d4',
  category: '#94a3b8',
  tool: '#10b981',
  workflow: '#3b82f6',
  subagent: '#8b5cf6',
  mcp: '#ec4899',
  channel: '#f59e0b',
  service: '#06b6d4',
}

export default function NebulaTab() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  const [data, setData] = useState<NebulaData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string>('')
  const [hoveredNode, setHoveredNode] = useState<NebulaNode | null>(null)
  // 'core' et 'category' inclus par défaut — sans eux les edges
  // synthétiques category→tool sont filtrés et les tools paraissent
  // orphelins (bug rapporté user 2026-05-03).
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(
    new Set(['core', 'category', 'tool', 'workflow', 'subagent', 'mcp', 'channel', 'service'])
  )

  const fetchNebula = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const res = await apiFetch('/api/plugins/consciousness/nebula')
      if (!res.ok) {
        setErr(`HTTP ${res.status}`)
        return
      }
      const json = await res.json()
      setData(json)
    } catch (e: any) {
      setErr(e?.message || 'Erreur réseau')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch silencieux pour le polling auto : ne touche pas `loading` (pas
  // de spinner principal qui apparaît toutes les minutes), n'efface pas
  // les erreurs (un poll qui échoue ne masque pas une erreur affichée
  // par le fetch initial). Best-effort, ignore les erreurs réseau.
  const silentFetch = useCallback(async () => {
    try {
      const res = await apiFetch('/api/plugins/consciousness/nebula')
      if (!res.ok) return
      const json = await res.json()
      setData(json)
    } catch { /* polling silencieux : on ignore */ }
  }, [])

  // Fetch initial au mount + re-fetch au remount (= switch sur onglet
  // Nébuleuse, vu que le composant est démonté quand on quitte le tab).
  useEffect(() => { fetchNebula() }, [fetchNebula])

  // Polling 60s tant que le composant est monté (= onglet Nébuleuse
  // ouvert). Le cleanup au unmount stoppe automatiquement le timer →
  // pas de fetch en arrière-plan quand le user est sur un autre onglet.
  useEffect(() => {
    const interval = setInterval(silentFetch, 60_000)
    return () => clearInterval(interval)
  }, [silentFetch])

  // Construit les éléments Cytoscape filtrés par type activé. Reconstruit
  // le graphe à chaque changement de filtre — Cytoscape gère la diff
  // efficacement via `cy.json({elements: ...})`.
  const elements = useMemo<ElementDefinition[]>(() => {
    if (!data) return []
    const visibleNodes = data.nodes.filter(n => enabledTypes.has(n.type))
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id))
    const visibleEdges = data.edges.filter(
      e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    )
    return [
      ...visibleNodes.map(n => ({
        data: {
          id: n.id,
          label: n.label,
          type: n.type,
          category: n.category,
          color: n.color,
          description: n.description || '',
          enabled: n.enabled,
          level: n.level ?? 2,
        } as any,
      })),
      ...visibleEdges.map(e => ({
        data: {
          source: e.source,
          target: e.target,
          label: e.label || '',
          color: e.color || '#64748b',  // fallback gris si pas de color backend
        } as any,
      })),
    ]
  }, [data, enabledTypes])

  // Layout config réutilisable — extrait pour ne pas dupliquer entre l'init
  // et les re-renders (filter change, refresh).
  const runLayout = useCallback((animDuration: number) => {
    if (!cyRef.current) return
    cyRef.current.layout({
      name: 'cose',
      animate: true,
      animationDuration: animDuration,
      animationEasing: 'ease-out-cubic' as any,
      fit: true,
      padding: 120,
      // Plus d'espacement pour la lecture + halos "feu d'artifice" plus
      // larges qui demandent plus d'air autour (rapport user 2026-05-03) :
      // - nodeRepulsion ×1.6 (8500 → 14000) → écarte mieux les feuilles
      // - idealEdgeLength bumpées partout pour donner de l'air
      gravity: 0.4,
      gravityRange: 1.0,
      nodeRepulsion: () => 14000,
      idealEdgeLength: (edge: any) => {
        const src = edge.source().data('level')
        const tgt = edge.target().data('level')
        if (src === 0 || tgt === 0) return 130
        if (src === 1 || tgt === 1) return 200
        return 250
      },
      edgeElasticity: () => 60,
      numIter: 2000,
      coolingFactor: 0.97,
      randomize: true,
    } as any).run()
  }, [])

  // Initialise Cytoscape une fois que le container existe + les data sont là.
  // Pour les updates (filter / refresh) : remove + add (cy.json fuyait des
  // edges au refresh — bug user 2026-05-03 "le bouton rafraîchir détache
  // toutes les connexions"). Le remove+add reconstruit proprement.
  useEffect(() => {
    if (!containerRef.current || !data) return
    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: containerRef.current,
        elements,
        // Style "nébuleuse spatiale" hiérarchique : core gros au centre,
        // catégories en orbite proche, feuilles (tools/workflows/agents) en
        // orbite externe. Halos lumineux colorés pour effet "carte stellaire".
        style: [
          // ── Style de base (level 2 par défaut, le plus fréquent) ─────
          {
            selector: 'node',
            style: {
              'background-color': 'data(color)',
              'label': 'data(label)',
              'color': '#f8fafc',
              'font-size': '11px',
              'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              'font-weight': 500,
              'text-valign': 'bottom',
              'text-margin-y': 12,
              'text-max-width': '140px',
              'text-wrap': 'ellipsis',
              'text-background-color': '#0a0e1a',
              'text-background-opacity': 0.78,
              'text-background-padding': '5px',
              'text-background-shape': 'roundrectangle',
              'text-border-color': 'data(color)',
              'text-border-opacity': 0.45,
              'text-border-width': 1,
              'width': 18,
              'height': 18,
              // Halo interne flou via border colorée semi-transparente
              // (effet "couronne" autour du noyau lumineux). Combiné avec
              // shadow-blur très large, ça donne l'effet "feu d'artifice"
              // (rapport user 2026-05-03).
              'border-width': 8,
              'border-color': 'data(color)',
              'border-opacity': 0.35,
              'shadow-blur': 55,
              'shadow-color': 'data(color)',
              'shadow-opacity': 1,
              'shadow-offset-x': 0,
              'shadow-offset-y': 0,
              // Centre saturé : lift de luminosité pour effet "étincelle"
              // (vs couleur plate). Cytoscape "background-blacken"
              // négatif éclaircit la background-color.
              'background-blacken': -0.35,
              'transition-property': 'shadow-blur shadow-opacity width height border-width border-opacity',
              'transition-duration': 220,
            } as any,
          },
          // ── Level 1 : catégories — gros, halo très étendu ────────────
          {
            selector: 'node[level = 1]',
            style: {
              'width': 46,
              'height': 46,
              'font-size': '14px',
              'font-weight': 'bold',
              'text-margin-y': 14,
              'border-width': 14,
              'border-opacity': 0.32,
              'shadow-blur': 90,
              'shadow-opacity': 1,
              'background-blacken': -0.4,
            } as any,
          },
          // ── Level 0 : core — explosion centrale ──────────────────────
          {
            selector: 'node[level = 0]',
            style: {
              'width': 80,
              'height': 80,
              'font-size': '18px',
              'font-weight': 'bold',
              'text-valign': 'center',
              'text-halign': 'center',
              'color': '#fff',
              'text-margin-y': 0,
              'text-background-opacity': 0,
              'text-border-opacity': 0,
              'border-width': 24,
              'border-color': '#67e8f9',
              'border-opacity': 0.3,
              'shadow-blur': 140,
              'shadow-opacity': 1,
              'background-blacken': -0.45,
            } as any,
          },
          // ── Hover : l'étincelle "explose" (shadow + border bondissent)
          {
            selector: 'node:active, node:selected',
            style: {
              'shadow-blur': 100,
              'shadow-opacity': 1,
              'border-width': 16,
              'border-opacity': 0.6,
              'z-index': 10,
            } as any,
          },
          // ── Edges génériques : couleur héritée du target (cohérent
          // avec l'image de réf — chaque branche colorée selon sa
          // catégorie). ``data(targetColor)`` est posé côté backend lors
          // de la construction de l'edge. ─────────────────────────────
          {
            selector: 'edge',
            style: {
              'width': 1.5,
              'line-color': 'data(color)',
              'target-arrow-color': 'data(color)',
              'target-arrow-shape': 'none',  // pas de flèche, plus organique
              'curve-style': 'unbundled-bezier',
              'control-point-distances': [25],
              'control-point-weights': [0.5],
              'opacity': 0.55,
              'line-opacity': 0.55,
              // Glow léger sur les edges aussi pour cohérence avec les nœuds
              'shadow-blur': 6,
              'shadow-color': 'data(color)',
              'shadow-opacity': 0.5,
            } as any,
          },
          // ── Edges core → catégorie : plus larges et lumineux ─────────
          {
            selector: 'edge[source = "core:gungnir"]',
            style: {
              'width': 2.8,
              'opacity': 0.7,
              'control-point-distances': [50],
              'shadow-blur': 10,
              'shadow-opacity': 0.7,
            } as any,
          },
          // ── Edges catégorie → feuille : moyennement visibles ─────────
          {
            selector: 'edge[label = "contient"][source != "core:gungnir"]',
            style: {
              'width': 1.7,
              'opacity': 0.55,
            } as any,
          },
        ],
        // Layout cose force-directed : "étoile/nébuleuse" organique. Le
        // nœud le plus connecté (le core, qui a le plus haut degré via
        // ses 12+ edges vers les catégories) est attiré naturellement au
        // centre par la gravité combinée des forces. Les nœuds peu
        // connectés (tools degree=1) finissent en périphérie. Pas de
        // cercles imposés — disposition stellaire libre comme une vraie
        // nébuleuse (spec user 2026-05-03).
        layout: {
          name: 'cose',
          animate: true,
          animationDuration: 900,
          animationEasing: 'ease-out-quart' as any,
          fit: true,
          padding: 80,
          // Gravity forte → le centre de masse est tiré vers les nœuds
          // les plus connectés (= le core qui a 12+ edges sortants).
          gravity: 0.45,
          gravityRange: 1.0,
          // Repulsion adaptée : assez fort pour que les feuilles
          // s'écartent (rendu "étoile" non chevauché) sans exploser le
          // graphe.
          nodeRepulsion: () => 8500,
          idealEdgeLength: (edge: any) => {
            // Edges core→catégorie courts (rapproche les catégories du
            // centre), edges catégorie→feuille plus longs (étire les
            // tools vers la périphérie).
            const src = edge.source().data('level')
            const tgt = edge.target().data('level')
            if (src === 0 || tgt === 0) return 90
            if (src === 1 || tgt === 1) return 140
            return 180
          },
          edgeElasticity: () => 80,
          numIter: 2500,
          coolingFactor: 0.96,
          initialTemp: 200,
          // Pas de randomization → les nodes partent de positions
          // existantes (utile pour les re-layout après filter change).
          randomize: true,
        } as any,
        wheelSensitivity: 0.3,
        minZoom: 0.15,
        maxZoom: 4,
      })


      // Hover : update le panel droite
      cyRef.current.on('mouseover', 'node', (evt) => {
        const d = evt.target.data()
        setHoveredNode({
          id: d.id, label: d.label, type: d.type, category: d.category,
          color: d.color, description: d.description, enabled: d.enabled,
        })
      })
      cyRef.current.on('mouseout', 'node', () => setHoveredNode(null))

      // Post-layout : centrer la vue sur le core et zoomer fortement.
      // Avec ~80 nœuds, fit:true zoome très loin → nœuds illisibles.
      // Boost ×1.7 jusqu'à 2.5 max pour que le core + ses catégories
      // soient bien visibles d'emblée. Le user peut zoom out à la souris
      // pour la vue d'ensemble panoramique.
      cyRef.current.on('layoutstop', () => {
        if (!cyRef.current) return
        const core = cyRef.current.getElementById('core:gungnir')
        const z = cyRef.current.zoom()
        cyRef.current.zoom({
          level: Math.min(z * 1.7, 2.5),
          renderedPosition: { x: cyRef.current.width() / 2, y: cyRef.current.height() / 2 },
        })
        if (core && core.length > 0) {
          cyRef.current.center(core)
        }
      })
    } else {
      // Refresh / filter change : remove tous les éléments + add les
      // nouveaux. cy.json({elements}) fuyait des edges au refresh (bug
      // user 2026-05-03 "le bouton rafraîchir détache toutes les
      // connexions"). Le remove+add reconstruit proprement la structure.
      cyRef.current.elements().remove()
      cyRef.current.add(elements)
      runLayout(500)
    }
  }, [data, elements])

  // Cleanup à l'unmount
  useEffect(() => {
    return () => {
      if (cyRef.current) {
        cyRef.current.destroy()
        cyRef.current = null
      }
    }
  }, [])

  const toggleType = (t: string) => {
    setEnabledTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-muted)' }}>
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Chargement de la nébuleuse...
      </div>
    )
  }

  if (err) {
    return (
      <div className="p-4 rounded-lg" style={{ background: 'rgba(220,38,38,0.1)', color: '#ef4444' }}>
        Erreur : {err}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Network className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
          <h2 className="text-lg font-semibold">Nébuleuse</h2>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {data?.stats && Object.entries(data.stats).filter(([k]) => k !== 'edges').reduce((s, [, v]) => s + (v as number), 0)} nœuds / {data?.stats?.edges || 0} liens
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}
            title="Auto-sync : le graphe se rafraîchit toutes les 60s tant que cet onglet est ouvert">
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: '#10b981' }} />
            Auto-sync 60s
          </span>
          <button onClick={fetchNebula} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-50"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Rafraîchir
          </button>
        </div>
      </div>

      {/* Filtres par type */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(TYPE_LABELS).map(([type, label]) => {
          const count = data?.stats?.[type] || 0
          const active = enabledTypes.has(type)
          return (
            <button key={type} onClick={() => toggleType(type)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-opacity"
              style={{
                background: active ? `color-mix(in srgb, ${TYPE_COLORS[type]} 15%, transparent)` : 'var(--bg-tertiary)',
                color: active ? TYPE_COLORS[type] : 'var(--text-muted)',
                border: `1px solid ${active ? TYPE_COLORS[type] : 'var(--border)'}`,
                opacity: count === 0 ? 0.4 : 1,
              }}
              title={active ? 'Cacher' : 'Afficher'}>
              {active ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              <span>{label}</span>
              <span className="opacity-70">({count})</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {/* Graphe principal — fond spatial : dégradé radial sombre + grain
            de poussière d'étoiles via radial-gradients superposés (CSS pur,
            zéro asset). Donne la profondeur "espace" au glow Cytoscape
            qui ressort dessus. */}
        <div className="md:col-span-3 rounded-lg overflow-hidden relative"
          style={{
            background: `
              radial-gradient(1.5px 1.5px at 12% 18%, rgba(255,255,255,0.55), transparent 50%),
              radial-gradient(1px 1px at 23% 73%, rgba(255,255,255,0.35), transparent 60%),
              radial-gradient(1.5px 1.5px at 45% 38%, rgba(255,255,255,0.4), transparent 50%),
              radial-gradient(1px 1px at 67% 13%, rgba(255,255,255,0.3), transparent 60%),
              radial-gradient(1.5px 1.5px at 80% 60%, rgba(255,255,255,0.45), transparent 50%),
              radial-gradient(1px 1px at 33% 88%, rgba(255,255,255,0.25), transparent 60%),
              radial-gradient(1.5px 1.5px at 92% 92%, rgba(255,255,255,0.4), transparent 50%),
              radial-gradient(1px 1px at 58% 50%, rgba(255,255,255,0.3), transparent 60%),
              radial-gradient(circle at 50% 50%, #0d1224 0%, #050816 70%, #02030a 100%)
            `,
            border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, var(--border))',
            // Hauteur adaptative au viewport pour ne pas créer de double
            // scrollbar dans la page Conscience (bug user 2026-05-03).
            // 65vh = bonne lecture sans dépasser le contenant parent.
            height: '65vh',
            minHeight: 480,
            boxShadow: 'inset 0 0 60px rgba(0,0,0,0.6)',
          }}>
          <div ref={containerRef} className="w-full h-full" />
        </div>

        {/* Panel détails (survol) */}
        <div className="rounded-lg p-3 space-y-2"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
          {hoveredNode ? (
            <>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full"
                  style={{ background: hoveredNode.color }} />
                <span className="text-xs font-semibold uppercase tracking-wide"
                  style={{ color: hoveredNode.color }}>
                  {TYPE_LABELS[hoveredNode.type] || hoveredNode.type}
                </span>
              </div>
              <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {hoveredNode.label}
              </div>
              {hoveredNode.category && hoveredNode.category !== hoveredNode.type && (
                <div className="text-[10px] uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}>
                  Catégorie : {hoveredNode.category}
                </div>
              )}
              {hoveredNode.enabled === false && (
                <div className="text-[10px] px-1.5 py-0.5 rounded inline-block"
                  style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                  désactivé
                </div>
              )}
              {hoveredNode.description && (
                <div className="text-xs mt-2 leading-relaxed"
                  style={{ color: 'var(--text-secondary)' }}>
                  {hoveredNode.description}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Survole un nœud du graphe pour voir ses détails.
              <div className="mt-3 space-y-1.5">
                {Object.entries(TYPE_LABELS).map(([t, l]) => (
                  <div key={t} className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full"
                      style={{ background: TYPE_COLORS[t] }} />
                    <span className="text-[11px]">{l}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
