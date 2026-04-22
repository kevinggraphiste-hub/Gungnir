import { LC, MONO, S } from '../utils'

// ═══════════════════════════════════════════════════════════════════════════════
// DIFF VIEWER
// ═══════════════════════════════════════════════════════════════════════════════

export function DiffViewer({ original, modified, language, fileName }: { original: string; modified: string; language: string; fileName: string }) {
  const oL = original.split('\n'), mL = modified.split('\n'), max = Math.max(oL.length, mL.length)
  const diffs: Array<{ type: 'same' | 'add' | 'remove' | 'change'; ln: number; o?: string; m?: string }> = []
  for (let i = 0; i < max; i++) {
    const o = oL[i], m = mL[i]
    if (o === undefined) diffs.push({ type: 'add', ln: i + 1, m })
    else if (m === undefined) diffs.push({ type: 'remove', ln: i + 1, o })
    else if (o === m) diffs.push({ type: 'same', ln: i + 1, o, m })
    else diffs.push({ type: 'change', ln: i + 1, o, m })
  }
  const added = diffs.filter(d => d.type === 'add' || d.type === 'change').length
  const removed = diffs.filter(d => d.type === 'remove' || d.type === 'change').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ ...S.badge(LC[language] || '#6b7280', true), fontSize: 8 }}>{language}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>Diff: {fileName}</span>
        <div style={{ flex: 1 }} />
        <span style={{ ...S.badge('#22c55e', true), fontSize: 8 }}>+{added}</span>
        <span style={{ ...S.badge('#dc2626', true), fontSize: 8 }}>-{removed}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontFamily: MONO, fontSize: 11, lineHeight: '18px' }}>
        {diffs.map((d, i) => {
          if (d.type === 'same') return <DL key={i} ln={d.ln} text={d.o!} />
          if (d.type === 'remove') return <DL key={i} ln={d.ln} text={d.o!} t="-" />
          if (d.type === 'add') return <DL key={i} ln={d.ln} text={d.m!} t="+" />
          return <div key={i}><DL ln={d.ln} text={d.o!} t="-" /><DL ln={d.ln} text={d.m!} t="+" /></div>
        })}
      </div>
    </div>
  )
}

export function DL({ ln, text, t }: { ln: number; text: string; t?: '+' | '-' }) {
  return (
    <div style={{ display: 'flex', padding: '0 12px', background: t === '+' ? '#22c55e12' : t === '-' ? '#dc262612' : 'transparent' }}>
      <span style={{ width: 40, flexShrink: 0, textAlign: 'right', paddingRight: 8, color: t === '+' ? '#22c55e' : t === '-' ? '#dc2626' : 'var(--text-muted)', opacity: 0.4, userSelect: 'none' }}>{ln}</span>
      {t && <span style={{ color: t === '+' ? '#22c55e' : '#dc2626', marginRight: 6, userSelect: 'none' }}>{t}</span>}
      <span style={{ flex: 1, color: t === '+' ? '#4ade80' : t === '-' ? '#f87171' : 'var(--text-muted)', opacity: t ? 1 : 0.5 }}>{text}</span>
    </div>
  )
}
