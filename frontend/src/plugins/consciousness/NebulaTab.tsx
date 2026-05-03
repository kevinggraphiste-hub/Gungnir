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
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(color)',
              'label': 'data(label)',
              'color': '#e5e7eb',
              'font-size': '10px',
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-outline-color': '#0a0a0a',
              'text-outline-width': 2,
              'width': 18,
              'height': 18,
              'border-width': 1,
              'border-color': '#1f1f1f',
              'border-opacity': 0.6,
            },
          },
          {
            // Workflows / sous-agents plus gros pour les distinguer
            selector: 'node[type = "workflow"], node[type = "subagent"]',
            style: { 'width': 28, 'height': 28, 'font-size': '11px', 'font-weight': 'bold' as any },
          },
          {
            selector: 'node[type = "mcp"], node[type = "channel"], node[type = "service"]',
            style: { 'width': 24, 'height': 24, 'font-size': '11px' },
          },
          {
            selector: 'edge',
            style: {
              'width': 1.2,
              'line-color': '#3a3a3a',
              'target-arrow-color': '#3a3a3a',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              'opacity': 0.6,
            },
          },
          {
            selector: 'node:selected',
            style: {
              'border-width': 3,
              'border-color': '#fff',
              'border-opacity': 1,
            },
          },
        ],
        layout: {
          name: 'cose',
          // Force-directed avec gravité douce. animate=false pour rendu
          // immédiat plutôt qu'animation qui lag à grand graphe.
          animate: false,
          fit: true,
          padding: 30,
          nodeRepulsion: () => 4500,
          idealEdgeLength: () => 80,
          gravity: 0.25,
        } as any,
        wheelSensitivity: 0.2,
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
    } else {
      // Update les éléments en gardant les positions
      cyRef.current.json({ elements })
      cyRef.current.layout({
        name: 'cose', animate: false, fit: true, padding: 30,
        nodeRepulsion: () => 4500, idealEdgeLength: () => 80, gravity: 0.25,
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
        {/* Graphe principal */}
        <div className="md:col-span-3 rounded-lg overflow-hidden"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-subtle)',
            height: 600,
            minHeight: 400,
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
