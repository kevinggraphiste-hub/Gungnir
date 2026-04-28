import { useState, useEffect, useCallback } from 'react'
import type { Snippet } from '../types'
import { apiFetch, LC, MONO, S } from '../utils'
import { IconBtn } from './common'

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPPETS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

export function SnippetsPanel({ language, onInsert }: { language?: string; onInsert: (code: string) => void }) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [filter, setFilter] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [newLang, setNewLang] = useState(language || 'text')
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const data = await apiFetch<{ snippets: Snippet[] }>('/snippets')
    if (data) setSnippets(data.snippets)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const filtered = snippets.filter(s => {
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase()) && !s.language.includes(filter.toLowerCase())) return false
    return true
  })

  const addSnippet = async () => {
    if (!newName.trim() || !newCode.trim()) return
    await apiFetch('/snippets', { method: 'POST', body: JSON.stringify({ name: newName, code: newCode, language: newLang }) })
    setNewName(''); setNewCode(''); setShowAdd(false); refresh()
  }

  const deleteSnippet = async (id: string) => {
    await apiFetch(`/snippets/${id}`, { method: 'DELETE' })
    refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>Snippets</span>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>({snippets.length})</span>
        <div style={{ flex: 1 }} />
        <IconBtn onClick={() => setShowAdd(!showAdd)} title="Nouveau snippet"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></IconBtn>
      </div>

      {/* Bandeau explicatif — affiché en permanence en haut du panneau. Aide
          les nouveaux utilisateurs à comprendre à quoi sert cette zone. */}
      <div style={{
        padding: '8px 12px', fontSize: 'var(--font-xs)', lineHeight: 1.45,
        color: 'var(--text-muted)', background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border)',
      }}>
        <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Snippets</strong> : petits bouts de code réutilisables
        (imports fréquents, boilerplate, patterns…). <br />
        • Pour en <strong style={{ color: 'var(--text-primary)' }}>créer</strong> un : sélectionne du code dans l'éditeur
        puis clique <em>Snippet</em> dans la barre d'actions IA, ou utilise le
        bouton <strong style={{ color: 'var(--text-primary)' }}>+</strong> ci-dessus pour le saisir à la main. <br />
        • Pour <strong style={{ color: 'var(--text-primary)' }}>insérer</strong> un snippet : clique dessus dans la liste pour
        déplier, puis utilise le bouton <em>Insérer</em>.
      </div>

      {showAdd && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nom du snippet" style={{ width: '100%', padding: '4px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginBottom: 4 }} />
          <select value={newLang} onChange={e => setNewLang(e.target.value)} style={{ width: '100%', padding: '3px 6px', fontSize: 'var(--font-2xs)', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', marginBottom: 4 }}>
            {['python', 'javascript', 'typescript', 'tsx', 'html', 'css', 'json', 'bash', 'sql', 'rust', 'go', 'java', 'text'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <textarea value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Code..." rows={4} style={{ width: '100%', padding: '4px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: MONO, marginBottom: 4 }} />
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={addSnippet} style={{ flex: 1, padding: '4px 0', borderRadius: 4, border: 'none', fontSize: 'var(--font-2xs)', fontWeight: 600, background: '#22c55e', color: '#fff', cursor: 'pointer' }}>Sauvegarder</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: '4px 8px', borderRadius: 4, border: 'none', fontSize: 'var(--font-2xs)', background: 'var(--bg-secondary)', color: 'var(--text-muted)', cursor: 'pointer' }}>Annuler</button>
          </div>
        </div>
      )}

      <div style={{ padding: '4px 10px' }}>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filtrer snippets..." style={{ width: '100%', padding: '4px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
            Aucun snippet.{'\n'}Selectionnez du code et utilisez le bouton Snippet.
          </div>
        ) : filtered.map(s => (
          <div key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <div onClick={() => setExpanded(expanded === s.id ? null : s.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 'var(--font-xs)' }}>
              <span style={{ ...S.badge(LC[s.language] || '#6b7280', true), fontSize: 'var(--font-2xs)', padding: '0 4px' }}>{s.language}</span>
              <span style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>{s.code.split('\n').length}L</span>
            </div>
            {expanded === s.id && (
              <div style={{ padding: '0 10px 6px' }}>
                <pre style={{ margin: 0, padding: 6, borderRadius: 4, fontSize: 'var(--font-2xs)', background: '#0c0f14', color: '#c9d1d9', overflow: 'auto', maxHeight: 120, fontFamily: MONO, lineHeight: 1.4, border: '1px solid #1e2633' }}>{s.code}</pre>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button onClick={() => onInsert(s.code)} style={{ flex: 1, padding: '3px 0', borderRadius: 4, border: 'none', fontSize: 'var(--font-2xs)', fontWeight: 600, background: '#22c55e20', color: '#22c55e', cursor: 'pointer' }}>Inserer</button>
                  <button onClick={() => { navigator.clipboard.writeText(s.code) }} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', fontSize: 'var(--font-2xs)', background: '#3b82f620', color: '#3b82f6', cursor: 'pointer' }}>Copier</button>
                  <button onClick={() => deleteSnippet(s.id)} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', fontSize: 'var(--font-2xs)', background: '#dc262620', color: '#dc2626', cursor: 'pointer' }}>Suppr</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
