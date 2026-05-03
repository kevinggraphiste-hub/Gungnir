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
}

interface NebulaData {
  nodes: NebulaNode[]
  edges: NebulaEdge[]
  stats: Record<string, number>
}

const TYPE_LABELS: Record<string, string> = {
  tool: 'Outils',
  workflow: 'Workflows',
  subagent: 'Sous-agents',
  mcp: 'MCP Servers',
  channel: 'Canaux',
  service: 'Services',
}

const TYPE_COLORS: Record<string, string> = {
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
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(
    new Set(['tool', 'workflow', 'subagent', 'mcp', 'channel', 'service'])
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

  useEffect(() => { fetchNebula() }, [fetchNebula])

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
        data: { source: e.source, target: e.target, label: e.label || '' } as any,
      })),
    ]
  }, [data, enabledTypes])

  // Initialise Cytoscape une fois que le container existe + les data sont là.
  // Reuse l'instance et update via cy.json() pour ne pas perdre la position
  // des nodes quand on filtre.
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
              'color': '#f1f5f9',
              'font-size': '11px',
              'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              'font-weight': 500,
              'text-valign': 'bottom',
              'text-margin-y': 8,
              'text-outline-color': '#000',
              'text-outline-width': 2.5,
              'text-outline-opacity': 0.85,
              'text-max-width': '120px',
              'text-wrap': 'ellipsis',
              'width': 22,
              'height': 22,
              'border-width': 0,
              'shadow-blur': 26,
              'shadow-color': 'data(color)',
              'shadow-opacity': 0.85,
              'shadow-offset-x': 0,
              'shadow-offset-y': 0,
              'background-blacken': -0.15,
              'transition-property': 'shadow-blur shadow-opacity width height',
              'transition-duration': 200,
            } as any,
          },
          // ── Level 1 : catégories — gros nœuds en orbite proche ───────
          {
            selector: 'node[level = 1]',
            style: {
              'width': 50,
              'height': 50,
              'font-size': '14px',
              'font-weight': 'bold',
              'text-margin-y': 10,
              'shadow-blur': 50,
              'shadow-opacity': 0.95,
              'background-blacken': -0.25,
            } as any,
          },
          // ── Level 0 : core — énorme au centre, halo cyan vif ─────────
          {
            selector: 'node[level = 0]',
            style: {
              'width': 90,
              'height': 90,
              'font-size': '18px',
              'font-weight': 'bold',
              'text-valign': 'center',
              'text-halign': 'center',
              'color': '#fff',
              'text-margin-y': 0,
              'shadow-blur': 80,
              'shadow-opacity': 1,
              'background-blacken': -0.3,
              'border-width': 3,
              'border-color': '#67e8f9',
              'border-opacity': 0.8,
            } as any,
          },
          // ── Hover ────────────────────────────────────────────────────
          {
            selector: 'node:active, node:selected',
            style: {
              'shadow-blur': 60,
              'shadow-opacity': 1,
              'border-width': 2,
              'border-color': '#fff',
              'border-opacity': 0.9,
              'z-index': 10,
            } as any,
          },
          // ── Edges ────────────────────────────────────────────────────
          {
            selector: 'edge',
            style: {
              'width': 1.2,
              'line-color': '#64748b',
              'target-arrow-color': '#64748b',
              'target-arrow-shape': 'none',  // pas de flèche, plus organique
              'curve-style': 'unbundled-bezier',
              'control-point-distances': [20],
              'control-point-weights': [0.5],
              'opacity': 0.4,
              'line-opacity': 0.4,
            } as any,
          },
          // ── Edges core → catégorie : plus visibles, plus larges ──────
          {
            selector: 'edge[source = "core:gungnir"]',
            style: {
              'width': 2.5,
              'line-color': '#06b6d4',
              'opacity': 0.6,
              'curve-style': 'unbundled-bezier',
              'control-point-distances': [40],
            } as any,
          },
          // ── Edges catégorie → feuille : couleur de la catégorie ──────
          {
            selector: 'edge[label = "contient"]',
            style: {
              'width': 1.5,
              'line-color': '#475569',
              'opacity': 0.45,
            } as any,
          },
        ],
        // Layout concentric : level 0 au centre, level 1 en orbite proche,
        // level 2 en orbite externe. Cohérent avec la spec user "core
        // central + tout gravite autour" et l'image de référence.
        layout: {
          name: 'concentric',
          animate: true,
          animationDuration: 900,
          animationEasing: 'ease-out-quart' as any,
          fit: true,
          padding: 60,
          // Plus le level est petit (= plus proche du core), plus la
          // concentricity est élevée → orbite plus proche du centre.
          concentric: (node: any) => 10 - (node.data('level') ?? 2),
          levelWidth: () => 1,
          minNodeSpacing: 25,
          spacingFactor: 1.3,
          startAngle: -Math.PI / 2,  // commence en haut pour symétrie
          // Avoid overlap au sein d'une même orbite
          avoidOverlap: true,
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

      // Zoom-in après le layout : `fit: true` zoom out pour faire tenir
      // tout le graphe → avec 60+ nœuds en orbite externe ça donne un
      // rendu minuscule. On fait un zoom factor 1.3 post-layout pour
      // que les nœuds soient lisibles d'emblée. Le user peut zoom out
      // à la souris pour la vue d'ensemble.
      cyRef.current.one('layoutstop', () => {
        if (!cyRef.current) return
        const z = cyRef.current.zoom()
        cyRef.current.zoom({ level: Math.min(z * 1.4, 2.5), renderedPosition: { x: cyRef.current.width() / 2, y: cyRef.current.height() / 2 } })
      })
    } else {
      // Update les éléments en gardant la structure orbitale ; ré-applique
      // concentric pour reflow après filter change.
      cyRef.current.json({ elements })
      cyRef.current.layout({
        name: 'concentric',
        animate: true,
        animationDuration: 500,
        animationEasing: 'ease-out-cubic' as any,
        fit: true,
        padding: 60,
        concentric: (node: any) => 10 - (node.data('level') ?? 2),
        levelWidth: () => 1,
        minNodeSpacing: 25,
        spacingFactor: 1.3,
        startAngle: -Math.PI / 2,
        avoidOverlap: true,
      } as any).run()
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
        <button onClick={fetchNebula} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-50"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Rafraîchir
        </button>
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
            height: 760,
            minHeight: 500,
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
