/**
 * Forge — Canvas visuel (React Flow).
 *
 * Édite un workflow comme un graphe de nodes (= steps) connectés par
 * des edges (= ordre d'exécution). Chaque node enveloppe un wolf_tool ;
 * cliquer un node ouvre un panel d'édition pour les arguments.
 *
 * Source of truth = le YAML stocké dans `forge_workflows.yaml_def`. Le
 * canvas n'est qu'une vue alternative qui parse/sérialise vers le même
 * YAML. Aucun drift possible : on convertit dans les deux sens à chaque
 * switch de vue, et la sauvegarde envoie toujours le YAML final.
 *
 * MVP : steps séquentiels uniquement. Les `parallel:` et `if:` du YAML
 * sont préservés (round-trip safe) mais pas encore éditables visuellement
 * — un avertissement s'affiche dans le node correspondant.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  Handle, Position, MarkerType,
  type Node, type Edge, type Connection, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import yaml from 'js-yaml'
import { Plus, Search, Trash2, Wand2, AlertTriangle, ChevronDown, ChevronRight, MoveDown, MoveRight } from 'lucide-react'
import { humanizeTool, groupByCategory } from './toolLabels'

// ── Types ────────────────────────────────────────────────────────────────

export interface ForgeTool {
  name: string
  description: string
  params: Array<{ name: string; type: string; description: string; required: boolean }>
}

type LayoutDirection = 'vertical' | 'horizontal'

interface StepData {
  // Source de vérité du step : on stocke le step YAML brut dans le node
  // (tool, args, optional id/if/parallel) et on régénère le YAML au save.
  step: Record<string, any>
  tool: ForgeTool | null
  // Flag : true si le step contient des features non éditables visuellement
  // (parallel, if conditionnel) — affiche un warning dans le node.
  unsupported: boolean
  // Orientation du canvas — propagée au node pour positionner ses handles
  // (top/bottom en vertical, left/right en horizontal).
  direction: LayoutDirection
}

// React Flow exige que `data` étende Record<string,unknown>.
type StepNode = Node<StepData & Record<string, unknown>>

// ── YAML <-> nodes ───────────────────────────────────────────────────────

// Vertical : pile colonne (ancien comportement). Horizontal : ligne.
// Les écarts sont calibrés pour que les nodes (~280px de large) ne se
// chevauchent pas et restent lisibles.
const NODE_GAP_VERTICAL = 130
const NODE_GAP_HORIZONTAL = 320

function nodePositionFor(direction: LayoutDirection, index: number): { x: number; y: number } {
  if (direction === 'horizontal') {
    return { x: 60 + index * NODE_GAP_HORIZONTAL, y: 80 }
  }
  return { x: 80, y: 60 + index * NODE_GAP_VERTICAL }
}

interface ParseResult {
  nodes: StepNode[]
  edges: Edge[]
  meta: { name?: string; description?: string; inputs?: any }
}

export function yamlToNodes(yamlText: string, tools: ForgeTool[],
                            direction: LayoutDirection = 'vertical'): ParseResult {
  let parsed: any = {}
  try {
    parsed = yaml.load(yamlText) || {}
  } catch {
    return { nodes: [], edges: [], meta: {} }
  }
  const steps: any[] = Array.isArray(parsed.steps) ? parsed.steps : []
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const nodes: StepNode[] = []
  const edges: Edge[] = []
  steps.forEach((step, i) => {
    const id = String(step.id || `step_${i + 1}`)
    const isParallel = !!step.parallel
    const hasIf = !!step.if
    const tool = step.tool ? (toolMap.get(step.tool) || null) : null
    nodes.push({
      id,
      type: 'forgeStep',
      position: nodePositionFor(direction, i),
      data: { step: { ...step, id }, tool, unsupported: isParallel || hasIf, direction },
    })
    if (i > 0) {
      const prev = nodes[i - 1]
      edges.push({
        id: `e-${prev.id}-${id}`, source: prev.id, target: id,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#dc2626' },
        style: { stroke: '#dc2626', strokeWidth: 2 },
      })
    }
  })
  return {
    nodes, edges,
    meta: {
      name: parsed.name, description: parsed.description, inputs: parsed.inputs,
    },
  }
}

export function nodesToYaml(nodes: StepNode[], edges: Edge[],
                            meta: ParseResult['meta']): string {
  // On dérive l'ordre depuis les edges : trouve le node racine (sans
  // edge entrant), puis suit les edges sortants. Si le graphe est
  // dégénéré (boucles, non connecté), fallback sur l'ordre vertical (y).
  const incoming = new Map<string, number>()
  for (const e of edges) {
    incoming.set(e.target, (incoming.get(e.target) || 0) + 1)
  }
  const outMap = new Map<string, string[]>()
  for (const e of edges) {
    const arr = outMap.get(e.source) || []
    arr.push(e.target)
    outMap.set(e.source, arr)
  }
  // Roots = nodes sans incoming.
  const roots = nodes.filter(n => !incoming.get(n.id))
  let order: StepNode[] = []
  if (roots.length === 1) {
    const visited = new Set<string>()
    const walk = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const n = nodes.find(nn => nn.id === id)
      if (n) order.push(n)
      for (const nxt of outMap.get(id) || []) walk(nxt)
    }
    walk(roots[0].id)
    // Fallback si le walk n'a pas tout couvert (graph déconnecté).
    if (order.length < nodes.length) {
      for (const n of nodes) if (!visited.has(n.id)) order.push(n)
    }
  } else {
    // Multi-roots ou pas d'edges : fallback ordre vertical (position.y).
    order = [...nodes].sort((a, b) => a.position.y - b.position.y)
  }
  const out: any = {}
  if (meta.name) out.name = meta.name
  if (meta.description) out.description = meta.description
  if (meta.inputs && Object.keys(meta.inputs).length > 0) out.inputs = meta.inputs
  out.steps = order.map(n => {
    const s = { ...n.data.step }
    s.id = n.id  // toujours synchroniser avec l'id du node
    return s
  })
  return yaml.dump(out, { lineWidth: 120, noRefs: true })
}

// ── Custom node component ────────────────────────────────────────────────

function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const { step, tool, unsupported, direction } = data
  const isParallel = !!step.parallel
  // Titre humain dérivé de la description backend (1ère phrase) +
  // catégorie pour le bandeau couleur. Fallback au nom technique si
  // l'outil n'est pas dans le catalogue (ex: name introuvable).
  // Si l'outil correspond à un service connu, on utilise le logo de
  // marque (Slack, GitHub, Notion…) au lieu de l'icône lucide générique.
  const lbl = tool ? humanizeTool(tool) : null
  const BrandLogo = lbl?.brandIcon
  const CatIcon = lbl?.icon
  const accent = lbl?.brandColor || lbl?.color || '#737373'
  // Position des handles : top/bottom en vertical (le flow descend),
  // left/right en horizontal (le flow va de gauche à droite).
  const inPos = direction === 'horizontal' ? Position.Left : Position.Top
  const outPos = direction === 'horizontal' ? Position.Right : Position.Bottom
  return (
    <div style={{
      minWidth: 240, maxWidth: 320,
      background: 'var(--bg-secondary)',
      border: `1.5px solid ${selected ? 'var(--scarlet)' : 'var(--border)'}`,
      borderRadius: 8, padding: 0, overflow: 'hidden',
      fontFamily: 'system-ui, sans-serif', fontSize: 11,
      boxShadow: selected ? '0 0 0 3px rgba(220,38,38,0.18)' : 'none',
      transition: 'box-shadow 0.12s',
    }}>
      <Handle type="target" position={inPos} style={{ background: '#dc2626', border: 'none', width: 8, height: 8 }} />
      {/* Bandeau catégorie + step id */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderBottom: '1px solid var(--border)', background: `${accent}15` }}>
        {CatIcon && <CatIcon size={10} style={{ color: accent, flexShrink: 0 }} />}
        <span style={{ fontSize: 8, fontWeight: 700, color: accent, letterSpacing: 0.5, textTransform: 'uppercase' }}>{lbl?.category || 'Outil'}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 8, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>#{step.id || '?'}</span>
        {unsupported && (
          <span title="Step contient un bloc parallel ou if — édition limitée au YAML pour l'instant"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 8, color: '#f59e0b', padding: '1px 5px', borderRadius: 3, background: 'rgba(245,158,11,0.18)' }}>
            <AlertTriangle size={9} />
            {isParallel ? 'parallel' : 'if'}
          </span>
        )}
      </div>
      {/* Corps : logo brand (si dispo) + titre humain + nom technique + preview args */}
      <div style={{ padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {BrandLogo && (
          <div style={{
            flexShrink: 0, width: 36, height: 36, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${accent}1A`,
          }}>
            <BrandLogo size={22} color={accent} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3, marginBottom: 2 }}>
          {lbl?.title || step.tool || (isParallel ? 'Parallèle' : 'Step')}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {step.tool || (isParallel ? 'parallel' : '—')}
        </div>
        {step.args && Object.keys(step.args).length > 0 && (
          <div style={{ marginTop: 6, padding: '4px 6px', background: 'var(--bg-tertiary)', borderRadius: 4, fontSize: 9, fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', maxHeight: 60, overflow: 'hidden' }}>
            {Object.keys(step.args).slice(0, 3).map(k => (
              <div key={k} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: accent }}>{k}</span>: {String(step.args[k]).slice(0, 50)}
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
      <Handle type="source" position={outPos} style={{ background: '#dc2626', border: 'none', width: 8, height: 8 }} />
    </div>
  )
}

const nodeTypes = { forgeStep: StepNodeView }

// ── Tool palette (sidebar gauche) ────────────────────────────────────────

function ToolPalette({ tools, onAdd, onAddControl }: {
  tools: ForgeTool[]
  onAdd: (tool: ForgeTool) => void
  onAddControl: (kind: 'parallel' | 'if' | 'subworkflow' | 'foreach' | 'wait') => void
}) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Filtre + groupage par catégorie. Si l'user tape une recherche, on
  // déplie tout pour ne pas masquer des résultats potentiels.
  const filtered = useMemo(() => {
    const s = q.toLowerCase().trim()
    if (!s) return tools
    return tools.filter(t => {
      const lbl = humanizeTool(t)
      return t.name.toLowerCase().includes(s)
          || t.description.toLowerCase().includes(s)
          || lbl.title.toLowerCase().includes(s)
          || lbl.category.toLowerCase().includes(s)
    })
  }, [tools, q])
  const groups = useMemo(() => groupByCategory(filtered), [filtered])
  const isSearching = !!q.trim()
  return (
    <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={12} style={{ color: 'var(--text-muted)' }} />
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder={`Chercher dans ${tools.length} outils…`}
          style={{ flex: 1, padding: '4px 6px', fontSize: 11, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Section "Contrôle de flow" — toujours visible en haut, indépendante
            de la recherche (les pseudo-blocs ne sont pas dans la liste tools
            backend mais générés côté UI). */}
        {!isSearching && (
          <div>
            <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 5, background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)' }}>
              <Wand2 size={12} style={{ color: '#dc2626' }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>Contrôle de flow</span>
            </div>
            {[
              { key: 'parallel' as const, title: 'Bloc parallèle', desc: 'Exécute plusieurs steps en simultané', tag: '⫿ parallel' },
              { key: 'foreach' as const, title: 'Boucle (for_each)', desc: 'Itère sur une liste, un sub-step par item', tag: 'for_each:' },
              { key: 'if' as const, title: 'Condition', desc: 'Saute le step si la condition est fausse', tag: 'if:' },
              { key: 'wait' as const, title: 'Attente', desc: 'Pause de N secondes entre deux steps', tag: 'wait_seconds' },
              { key: 'subworkflow' as const, title: 'Sous-workflow', desc: 'Appelle un autre workflow Forge', tag: 'forge_run_workflow' },
            ].map(it => (
              <div key={it.key} onClick={() => onAddControl(it.key)}
                style={{ padding: '7px 10px 7px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', transition: 'background 0.08s' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(220,38,38,0.10)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{it.title}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>{it.tag}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{it.desc}</div>
              </div>
            ))}
          </div>
        )}
        {groups.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Aucun outil ne correspond.</div>
        )}
        {groups.map(group => {
          const isCollapsed = !isSearching && collapsed[group.category]
          const Icon = group.icon
          return (
            <div key={group.category}>
              {/* Header catégorie cliquable pour collapse */}
              <div
                onClick={() => setCollapsed(prev => ({ ...prev, [group.category]: !prev[group.category] }))}
                style={{
                  padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 5,
                  cursor: 'pointer', userSelect: 'none',
                  background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)',
                  position: 'sticky', top: 0, zIndex: 1,
                }}>
                {isCollapsed ? <ChevronRight size={11} style={{ color: 'var(--text-muted)' }} />
                             : <ChevronDown size={11} style={{ color: 'var(--text-muted)' }} />}
                <Icon size={12} style={{ color: group.color }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{group.category}</span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>{group.tools.length}</span>
              </div>
              {!isCollapsed && group.tools.map(t => {
                const lbl = humanizeTool(t)
                const Brand = lbl.brandIcon
                const accent = lbl.brandColor || lbl.color
                return (
                  <div key={t.name} onClick={() => onAdd(t)}
                    title={t.description}
                    style={{ padding: '7px 10px 7px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', transition: 'background 0.08s', display: 'flex', alignItems: 'center', gap: 8 }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${accent}1A`)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {Brand && (
                      <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 4, background: `${accent}1A`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Brand size={14} color={accent} />
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{lbl.title}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{t.name}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Step inspector (panel droit, édition d'un node) ──────────────────────

function StepInspector({ node, tool, onChange, onDelete }: {
  node: StepNode
  tool: ForgeTool | null
  onChange: (next: Partial<StepData['step']> & { id?: string }) => void
  onDelete: () => void
}) {
  const step = node.data.step
  const args: Record<string, any> = (step.args || {}) as Record<string, any>
  return (
    <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>STEP ID</div>
        <input
          value={node.id}
          onChange={e => onChange({ id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60) })}
          style={{ width: '100%', padding: '4px 8px', fontSize: 12, fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>OUTIL</div>
        <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: 'var(--scarlet)', marginBottom: 6 }}>
          {step.tool || <span style={{ color: 'var(--text-muted)' }}>—</span>}
        </div>
        {tool?.description && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 12 }}>{tool.description}</div>
        )}

        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>ARGUMENTS</div>
        {tool && tool.params.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tool.params.map(p => {
              const val = args[p.name]
              return (
                <div key={p.name}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{p.name}</span>
                    {p.required && <span style={{ color: 'var(--scarlet)', fontSize: 9 }}>*</span>}
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>({p.type})</span>
                  </div>
                  {p.type === 'boolean' ? (
                    <select
                      value={val === undefined ? '' : String(val)}
                      onChange={e => {
                        const v = e.target.value
                        const next = { ...args }
                        if (v === '') delete next[p.name]
                        else next[p.name] = v === 'true'
                        onChange({ args: next })
                      }}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 11, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }}>
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      value={val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val))}
                      placeholder={p.description || (p.type === 'integer' ? '0' : p.type === 'array' ? '[…]' : '')}
                      onChange={e => {
                        const raw = e.target.value
                        const next = { ...args }
                        if (raw === '') {
                          delete next[p.name]
                        } else if (p.type === 'integer' || p.type === 'number') {
                          const n = Number(raw)
                          next[p.name] = Number.isFinite(n) ? n : raw
                        } else if (p.type === 'array' || p.type === 'object') {
                          // Si l'user a tapé du JSON, on parse ; sinon string brut.
                          try { next[p.name] = JSON.parse(raw) }
                          catch { next[p.name] = raw }
                        } else {
                          next[p.name] = raw
                        }
                        onChange({ args: next })
                      }}
                      style={{ width: '100%', padding: '4px 6px', fontSize: 11, fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }}
                    />
                  )}
                  {p.description && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{p.description}</div>}
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>Pas d'arguments documentés.</div>
        )}

        <div style={{ marginTop: 16, fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>CONDITION (if)</div>
        <input
          value={String(step.if || '')}
          placeholder="ex: {{ steps.fetch.ok }}"
          onChange={e => onChange({ if: e.target.value || undefined })}
          style={{ width: '100%', padding: '4px 6px', fontSize: 11, fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }}
        />

        {/* Retry policy : count + délai. 0 = pas de retry. */}
        <div style={{ marginTop: 12, fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 4 }}>RETRY POLICY</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>count</div>
            <input
              type="number" min={0} max={10}
              value={Number((step.retry || {}).count || 0)}
              onChange={e => {
                const c = Math.max(0, Math.min(10, parseInt(e.target.value) || 0))
                const r = { ...(step.retry || {}), count: c }
                onChange({ retry: c > 0 ? r : undefined })
              }}
              style={{ width: '100%', padding: '4px 6px', fontSize: 11, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>delay (ms)</div>
            <input
              type="number" min={0}
              value={Number((step.retry || {}).delay_ms || 1000)}
              onChange={e => {
                const d = Math.max(0, parseInt(e.target.value) || 0)
                const cur = step.retry || {}
                if (!cur.count) return  // ignore si pas de retry actif
                onChange({ retry: { ...cur, delay_ms: d } })
              }}
              disabled={!(step.retry || {}).count}
              style={{ width: '100%', padding: '4px 6px', fontSize: 11, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none', opacity: (step.retry || {}).count ? 1 : 0.5 }}
            />
          </div>
        </div>

        {/* Continue on error : si activé, l'échec ne stoppe pas le workflow */}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox" id="coe"
            checked={!!step.continue_on_error}
            onChange={e => onChange({ continue_on_error: e.target.checked || undefined })}
          />
          <label htmlFor="coe" style={{ fontSize: 10, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Continuer si ce step échoue
          </label>
        </div>
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
        <button onClick={onDelete}
          style={{ width: '100%', padding: '6px 10px', fontSize: 11, fontWeight: 600, background: 'rgba(220,38,38,0.12)', color: 'var(--scarlet)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Trash2 size={12} /> Supprimer ce step
        </button>
      </div>
    </div>
  )
}

// ── Canvas principal ─────────────────────────────────────────────────────

export interface ForgeCanvasProps {
  yamlValue: string
  tools: ForgeTool[]
  onChange: (yaml: string) => void
}

export function ForgeCanvas({ yamlValue, tools, onChange }: ForgeCanvasProps) {
  const toolMap = useMemo(() => new Map(tools.map(t => [t.name, t])), [tools])

  // Orientation du canvas — préférence persistée, propagée à chaque node
  // pour que ses handles se positionnent correctement.
  const [direction, setDirection] = useState<LayoutDirection>(() => {
    try { return localStorage.getItem('forge_canvas_direction') === 'horizontal' ? 'horizontal' : 'vertical' }
    catch { return 'vertical' }
  })
  useEffect(() => {
    try { localStorage.setItem('forge_canvas_direction', direction) } catch { /* ignore */ }
  }, [direction])

  // Parse initial.
  const initial = useMemo(() => yamlToNodes(yamlValue, tools, direction), [/* once */])  // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [meta, setMeta] = useState<ParseResult['meta']>(initial.meta)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Quand le YAML externe change (ex: switch de workflow), on re-parse.
  // On compare via une stringification stable du couple (steps,) pour
  // éviter de regénérer pendant qu'on édite.
  useEffect(() => {
    const r = yamlToNodes(yamlValue, tools, direction)
    setNodes(r.nodes)
    setEdges(r.edges)
    setMeta(r.meta)
    setSelectedId(null)
    // On veut re-syncer quand le yaml CHANGE de l'extérieur (workflow
    // switché par l'user) ; pas pendant nos propres édits puisque
    // celles-ci passent par onChange→parent→yamlValue (boucle évitée
    // car parent met à jour son draft.yaml_def via la sérialisation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yamlValue])

  // Switch de direction : on relayoute proprement les nodes existants
  // dans le nouveau sens et on propage la nouvelle direction à chaque
  // node (pour que ses handles changent de position).
  useEffect(() => {
    setNodes(prev => {
      // On garde l'ordre topologique courant pour reproduire le même
      // enchaînement dans la nouvelle direction.
      const incoming = new Map<string, number>()
      for (const e of edges) incoming.set(e.target, (incoming.get(e.target) || 0) + 1)
      const outMap = new Map<string, string[]>()
      for (const e of edges) {
        const arr = outMap.get(e.source) || []
        arr.push(e.target); outMap.set(e.source, arr)
      }
      const ordered: string[] = []
      const visited = new Set<string>()
      const roots = prev.filter(n => !incoming.get(n.id)).map(n => n.id)
      const walk = (id: string) => {
        if (visited.has(id)) return
        visited.add(id); ordered.push(id)
        for (const nxt of outMap.get(id) || []) walk(nxt)
      }
      roots.forEach(walk)
      prev.forEach(n => walk(n.id))
      return prev.map(n => {
        const idx = ordered.indexOf(n.id)
        return {
          ...n,
          position: nodePositionFor(direction, idx),
          data: { ...n.data, direction },
        }
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction])

  // Push YAML au parent à chaque modif locale.
  const pushYaml = useCallback((nextNodes: StepNode[], nextEdges: Edge[]) => {
    const out = nodesToYaml(nextNodes, nextEdges, meta)
    onChange(out)
  }, [meta, onChange])

  // Connections manuelles via drag depuis un handle.
  const onConnect = useCallback((conn: Connection) => {
    setEdges(prev => {
      const next = addEdge({
        ...conn,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#dc2626' },
        style: { stroke: '#dc2626', strokeWidth: 2 },
      } as Edge, prev)
      pushYaml(nodes, next)
      return next
    })
  }, [setEdges, nodes, pushYaml])

  // Ajout d'un step depuis la palette : nouveau node connecté au dernier
  // (selon la direction courante) si possible, sinon en orphelin.
  const handleAdd = useCallback((tool: ForgeTool) => {
    setNodes(prev => {
      // Trouve l'ID le plus haut pour générer un nom unique.
      const used = new Set(prev.map(n => n.id))
      let baseId = tool.name.replace(/^[^_]*_/, '').slice(0, 20) || 'step'
      let id = baseId, i = 1
      while (used.has(id)) { i += 1; id = `${baseId}_${i}` }
      // "Dernier" = le plus loin dans la direction du flow.
      const last = prev.length > 0
        ? [...prev].sort((a, b) => direction === 'horizontal'
            ? b.position.x - a.position.x
            : b.position.y - a.position.y)[0]
        : null
      const offset = direction === 'horizontal'
        ? { x: NODE_GAP_HORIZONTAL, y: 0 }
        : { x: 0, y: NODE_GAP_VERTICAL }
      const newNode: StepNode = {
        id, type: 'forgeStep',
        position: last
          ? { x: last.position.x + offset.x, y: last.position.y + offset.y }
          : nodePositionFor(direction, 0),
        data: {
          step: { id, tool: tool.name, args: {} },
          tool, unsupported: false, direction,
        },
      }
      const next = [...prev, newNode]
      if (last) {
        setEdges(prevEdges => {
          const nextEdges = [...prevEdges, {
            id: `e-${last.id}-${id}`, source: last.id, target: id,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#dc2626' },
            style: { stroke: '#dc2626', strokeWidth: 2 },
          } as Edge]
          pushYaml(next, nextEdges)
          return nextEdges
        })
      } else {
        pushYaml(next, edges)
      }
      return next
    })
  }, [setNodes, setEdges, edges, pushYaml, direction])

  // Ajout d'un step "spécial" (contrôle de flow) depuis la palette.
  // - parallel : crée un step avec 2 sub-steps web_fetch (template à éditer)
  // - if : crée un step avec un `if:` placeholder qu'on a juste à remplir
  // - subworkflow : crée un step `tool: forge_run_workflow` (l'user choisira
  //   le workflow_id dans l'inspector via un input integer)
  const handleAddControl = useCallback((kind: 'parallel' | 'if' | 'subworkflow' | 'foreach' | 'wait') => {
    setNodes(prev => {
      const used = new Set(prev.map(n => n.id))
      const baseIdMap: Record<string, string> = { parallel: 'parallel', if: 'condition', subworkflow: 'subwf', foreach: 'foreach', wait: 'wait' }
      const baseId = baseIdMap[kind]
      let id: string = baseId, i = 1
      while (used.has(id)) { i += 1; id = `${baseId}_${i}` }
      const last = prev.length > 0
        ? [...prev].sort((a, b) => direction === 'horizontal'
            ? b.position.x - a.position.x
            : b.position.y - a.position.y)[0]
        : null
      const offset = direction === 'horizontal'
        ? { x: NODE_GAP_HORIZONTAL, y: 0 } : { x: 0, y: NODE_GAP_VERTICAL }
      const stepBase: any = { id }
      let toolForCatalog: ForgeTool | null = null
      if (kind === 'parallel') {
        stepBase.parallel = [
          { tool: 'web_fetch', args: { url: 'https://example.com/a' } },
          { tool: 'web_fetch', args: { url: 'https://example.com/b' } },
        ]
      } else if (kind === 'foreach') {
        stepBase.for_each = '{{ inputs.items }}'
        stepBase.as = 'item'
        stepBase.do = [
          { tool: 'web_fetch', args: { url: '{{ item }}' } },
        ]
      } else if (kind === 'wait') {
        stepBase.tool = 'wait_seconds'
        stepBase.args = { seconds: 5 }
        toolForCatalog = toolMap.get('wait_seconds') || null
      } else if (kind === 'if') {
        stepBase.tool = 'web_fetch'
        stepBase.args = { url: '{{ inputs.url }}' }
        stepBase.if = '{{ inputs.url }}'
      } else {
        stepBase.tool = 'forge_run_workflow'
        stepBase.args = { workflow_id: 0, inputs: {} }
        toolForCatalog = toolMap.get('forge_run_workflow') || null
      }
      const newNode: StepNode = {
        id, type: 'forgeStep',
        position: last
          ? { x: last.position.x + offset.x, y: last.position.y + offset.y }
          : nodePositionFor(direction, 0),
        data: {
          step: stepBase, tool: toolForCatalog,
          // parallel et foreach restent flag unsupported parce que leurs
          // sub-steps ne sont pas éditables visuellement (édition YAML).
          unsupported: kind === 'parallel' || kind === 'foreach',
          direction,
        },
      }
      const next = [...prev, newNode]
      if (last) {
        setEdges(prevEdges => {
          const nextEdges = [...prevEdges, {
            id: `e-${last.id}-${id}`, source: last.id, target: id,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#dc2626' },
            style: { stroke: '#dc2626', strokeWidth: 2 },
          } as Edge]
          pushYaml(next, nextEdges)
          return nextEdges
        })
      } else {
        pushYaml(next, edges)
      }
      return next
    })
  }, [setNodes, setEdges, edges, pushYaml, direction, toolMap])

  // Édition d'un node.
  const handleNodeChange = useCallback((nodeId: string, patch: Partial<StepData['step']> & { id?: string }) => {
    setNodes(prev => {
      const next = prev.map(n => {
        if (n.id !== nodeId) return n
        const newStepId = patch.id !== undefined ? patch.id : n.id
        const mergedStep = { ...n.data.step }
        for (const k of Object.keys(patch)) {
          const v = (patch as any)[k]
          if (k === 'id') continue
          if (v === undefined || v === null || v === '') delete mergedStep[k]
          else mergedStep[k] = v
        }
        mergedStep.id = newStepId
        return {
          ...n,
          id: newStepId,
          data: { ...n.data, step: mergedStep, tool: toolMap.get(mergedStep.tool) || null },
        }
      })
      // Renomme aussi l'id dans les edges si nécessaire.
      if (patch.id !== undefined) {
        setEdges(prevEdges => {
          const renamed = prevEdges.map(e => ({
            ...e,
            source: e.source === nodeId ? patch.id! : e.source,
            target: e.target === nodeId ? patch.id! : e.target,
          }))
          pushYaml(next, renamed)
          return renamed
        })
      } else {
        pushYaml(next, edges)
      }
      return next
    })
    if (patch.id !== undefined) setSelectedId(patch.id)
  }, [setNodes, setEdges, edges, pushYaml, toolMap])

  // Suppression d'un node + ses edges connectés.
  const handleDelete = useCallback((nodeId: string) => {
    setNodes(prev => {
      const next = prev.filter(n => n.id !== nodeId)
      setEdges(prevEdges => {
        const nextEdges = prevEdges.filter(e => e.source !== nodeId && e.target !== nodeId)
        pushYaml(next, nextEdges)
        return nextEdges
      })
      return next
    })
    setSelectedId(null)
  }, [setNodes, setEdges, pushYaml])

  const selectedNode = nodes.find(n => n.id === selectedId) || null

  // Auto-layout : reorganise les nodes selon la direction courante,
  // par ordre topologique des edges.
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return
    const incoming = new Map<string, number>()
    for (const e of edges) incoming.set(e.target, (incoming.get(e.target) || 0) + 1)
    const outMap = new Map<string, string[]>()
    for (const e of edges) {
      const arr = outMap.get(e.source) || []
      arr.push(e.target)
      outMap.set(e.source, arr)
    }
    const ordered: string[] = []
    const visited = new Set<string>()
    const roots = nodes.filter(n => !incoming.get(n.id)).map(n => n.id)
    const walk = (id: string) => {
      if (visited.has(id)) return
      visited.add(id); ordered.push(id)
      for (const nxt of outMap.get(id) || []) walk(nxt)
    }
    roots.forEach(walk)
    nodes.forEach(n => walk(n.id))  // catch isolés
    setNodes(prev => prev.map(n => {
      const idx = ordered.indexOf(n.id)
      return { ...n, position: nodePositionFor(direction, idx) }
    }))
  }, [nodes, edges, setNodes, direction])

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      <ToolPalette tools={tools} onAdd={handleAdd} onAddControl={handleAddControl} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, position: 'relative' }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>{nodes.length} step{nodes.length > 1 ? 's' : ''} · {edges.length} connexion{edges.length > 1 ? 's' : ''}</span>
          <div style={{ flex: 1 }} />
          {/* Toggle direction du flow — déclenche aussi un relayout via l'effet sur direction */}
          <div style={{ display: 'flex', gap: 1, padding: 2, background: 'var(--bg-tertiary)', borderRadius: 4 }}>
            <button onClick={() => setDirection('vertical')}
              title="Flow vertical (de haut en bas)"
              style={{
                padding: '2px 6px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                border: 'none', borderRadius: 3,
                background: direction === 'vertical' ? 'var(--scarlet)' : 'transparent',
                color: direction === 'vertical' ? '#fff' : 'var(--text-secondary)',
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
              <MoveDown size={10} /> Vertical
            </button>
            <button onClick={() => setDirection('horizontal')}
              title="Flow horizontal (de gauche à droite)"
              style={{
                padding: '2px 6px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                border: 'none', borderRadius: 3,
                background: direction === 'horizontal' ? 'var(--scarlet)' : 'transparent',
                color: direction === 'horizontal' ? '#fff' : 'var(--text-secondary)',
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
              <MoveRight size={10} /> Horizontal
            </button>
          </div>
          <button onClick={handleAutoLayout}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <Wand2 size={11} /> Auto-layout
          </button>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            fitView fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} color="var(--border)" />
            <Controls position="bottom-right" />
            <MiniMap pannable zoomable
              nodeColor={() => '#dc2626'}
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text-muted)', pointerEvents: 'none' }}>
              <Plus size={36} style={{ opacity: 0.3 }} />
              <div style={{ fontSize: 12 }}>Cliquez un outil dans la palette à gauche pour commencer</div>
            </div>
          )}
        </div>
      </div>
      {selectedNode && (
        <StepInspector
          node={selectedNode}
          tool={selectedNode.data.tool}
          onChange={(patch) => handleNodeChange(selectedNode.id, patch)}
          onDelete={() => handleDelete(selectedNode.id)}
        />
      )}
    </div>
  )
}
