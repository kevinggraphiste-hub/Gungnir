// ── Utilitaires purs SpearCode ───────────────────────────────────────────────
// Helpers sans état partagé (sérialisation, fuzzy match, sanitize, rendering).

// ── API ──────────────────────────────────────────────────────────────────────

export const API = '/api/plugins/code'

export async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

// ── Constants ────────────────────────────────────────────────────────────────

export function fmtSize(b: number): string { return b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(1)} Mo` }

export const LC: Record<string, string> = {
  python: '#3572A5', javascript: '#f1e05a', typescript: '#3178c6', tsx: '#3178c6',
  jsx: '#f1e05a', json: '#6b7280', html: '#e34c26', css: '#563d7c', scss: '#c6538c',
  markdown: '#083fa1', yaml: '#cb171e', bash: '#89e051', sql: '#e38c00', rust: '#dea584',
  go: '#00ADD8', java: '#b07219', ruby: '#701516', php: '#4F5D95', vue: '#41b883', text: '#6b7280',
}
export const PC: Record<string, string> = { architect: '#6366f1', debugger: '#dc2626', reviewer: '#f59e0b', writer: '#3b82f6', tester: '#22c55e', optimizer: '#f97316', hacker: '#8b5cf6' }
export const FI: Record<string, string> = {
  '.py': '\u{1F40D}', '.js': '\u{1F4DC}', '.ts': '\u{1F4D8}', '.tsx': '⚛️', '.jsx': '⚛️',
  '.json': '{}', '.html': '\u{1F310}', '.css': '\u{1F3A8}', '.md': '\u{1F4DD}', '.yaml': '⚙️', '.yml': '⚙️',
  '.sh': '\u{1F4BB}', '.rs': '\u{1F980}', '.go': '\u{1F439}', '.java': '☕', '.rb': '\u{1F48E}',
  '.png': '\u{1F5BC}️', '.jpg': '\u{1F5BC}️', '.jpeg': '\u{1F5BC}️', '.gif': '\u{1F5BC}️', '.svg': '\u{1F5BC}️',
}
export const GSM: Record<string, { label: string; color: string }> = {
  'M': { label: 'Modifie', color: '#f59e0b' }, 'A': { label: 'Ajoute', color: '#22c55e' },
  'D': { label: 'Supprime', color: '#dc2626' }, '?': { label: 'Non suivi', color: '#6b7280' },
  '??': { label: 'Non suivi', color: '#6b7280' }, 'R': { label: 'Renomme', color: '#3b82f6' },
  'MM': { label: 'Modifie', color: '#f59e0b' }, 'U': { label: 'Conflit', color: '#f97316' },
}
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
export const MONO = '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace'

export const S = {
  sl: { fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: 1, padding: '8px 14px 4px' },
  badge: (c: string, a = false) => ({
    fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
    background: a ? `${c}20` : 'var(--bg-tertiary)', color: a ? c : 'var(--text-muted)',
    border: a ? `1px solid ${c}40` : '1px solid transparent', cursor: 'pointer', transition: 'all 0.15s',
  }),
}

// ── Fuzzy match ──────────────────────────────────────────────────────────────

export function fuzzyMatch(query: string, text: string): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase(), t = text.toLowerCase()
  let qi = 0, score = 0, indices: number[] = [], prevIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti)
      score += (ti === prevIdx + 1) ? 10 : (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '.' ? 5 : 1)
      prevIdx = ti; qi++
    }
  }
  return { match: qi === q.length, score, indices }
}

// ── HTML sanitization ────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function sanitizeSvg(svg: string): string {
  // Robust SVG sanitizer — strips all dangerous elements and attributes
  return svg
    // Remove script tags (including nested/malformed)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    // Remove dangerous elements: foreignObject, iframe, embed, object, use with external refs
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<(iframe|embed|object|applet|form|input|textarea|button)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|embed|object|applet|form|input|textarea|button)\b[^>]*\/?>/gi, '')
    // Remove animate/set that can trigger script (onbegin, onend, onrepeat)
    .replace(/<(animate|set|animateTransform|animateMotion)\b[^>]*\bon\w+\s*=[^>]*>/gi, '')
    // Remove ALL event handlers: on*= with quotes, without quotes, or with HTML entities
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>"']+/gi, '')
    // Remove javascript: / data: / vbscript: URIs (including HTML entity encoding)
    .replace(/(?:java|vb)\s*(?:&#[xX]?[0-9a-fA-F]+;?)*\s*script\s*:/gi, '')
    .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '')
    // Remove xlink:href and href pointing to scripts
    .replace(/(?:xlink:)?href\s*=\s*["'](?:javascript|data|vbscript):[^"']*["']/gi, '')
    .replace(/(?:xlink:)?href\s*=\s*(?:javascript|data|vbscript):[^\s>]*/gi, '')
    // Remove base64 encoded content in attributes that could hide scripts
    .replace(/\bstyle\s*=\s*["'][^"']*expression\s*\([^"']*["']/gi, '')
    .replace(/\bstyle\s*=\s*["'][^"']*url\s*\(\s*["']?(?:javascript|data):[^"']*["']/gi, '')
}

// ── Markdown renderer (lightweight, XSS-safe) ───────────────────────────────

export function renderMarkdown(md: string): string {
  // First escape all HTML in the source, then apply markdown formatting
  const escaped = escapeHtml(md)
  return escaped
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:700;margin:12px 0 4px;color:var(--text-primary)">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:800;margin:16px 0 6px;color:var(--text-primary)">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;font-weight:900;margin:20px 0 8px;color:var(--text-primary)">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text-primary)">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg-tertiary);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/^```(\w*)\n([\s\S]*?)```$/gm, '<pre style="background:#0c0f14;padding:12px;border-radius:8px;margin:8px 0;overflow:auto;font-size:12px;line-height:1.5;border:1px solid #1e2633"><code>$2</code></pre>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">• $1</div>')
    .replace(/^\d+\. (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">$1</div>')
    .replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--scarlet);padding-left:12px;margin:6px 0;color:var(--text-muted)">$1</blockquote>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}

// ── Extract code blocks from AI response ─────────────────────────────────────

export function extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = []
  const regex = /```(\w*)\n([\s\S]*?)```/g
  let m
  while ((m = regex.exec(text)) !== null) {
    blocks.push({ language: m[1] || 'text', code: m[2].trimEnd() })
  }
  return blocks
}
