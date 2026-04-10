import { useState, useEffect } from 'react'
import {
  MoreHorizontal, Download, FileText, FileCode, Globe, Brain,
  Trash2, Pencil, Loader2, FileType, Folder, FolderMinus
} from 'lucide-react'
import { api } from '../services/api'

interface Props {
  conversationId: number
  conversationTitle: string
  provider: string
  model: string
  onTitleUpdated: (id: number, title: string) => void
  onDelete: (id: number) => void
  onStartEdit: () => void
  onNewChatWithSummary: (summary: string) => void
  onFolderChanged?: () => void
}

export default function ConversationMenu({
  conversationId, conversationTitle, provider, model,
  onTitleUpdated, onDelete, onStartEdit, onNewChatWithSummary, onFolderChanged
}: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [folders, setFolders] = useState<any[]>([])
  const [showFolderMenu, setShowFolderMenu] = useState(false)

  useEffect(() => {
    if (!isOpen || folders.length > 0) return
    api.listFolders().then(setFolders).catch(() => {})
  }, [isOpen])

  const handleMoveToFolder = async (folderId: number | null) => {
    setLoading('folder')
    try {
      await api.moveConversationToFolder(conversationId, folderId)
      onFolderChanged?.()
    } catch (err) { console.error('Move error:', err) }
    setLoading(null)
    setShowFolderMenu(false)
    setIsOpen(false)
  }

  const handleExport = async (format: 'json' | 'txt' | 'md' | 'html' | 'pdf') => {
    setLoading(`export-${format}`)
    try {
      const blob = await api.exportConversation(conversationId, format)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${conversationTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) { console.error('Export error:', err) }
    setLoading(null)
    setIsOpen(false)
  }

  const handleSummarize = async () => {
    setLoading('summarize')
    try {
      const result = await api.summarizeConversation(conversationId, provider, model)
      if (result.summary) onNewChatWithSummary(result.summary)
    } catch (err) { console.error('Summarize error:', err) }
    setLoading(null)
    setIsOpen(false)
  }

  const handleGenerateTitle = async () => {
    setLoading('title')
    try {
      const result = await api.generateTitle(conversationId)
      if (result.title) onTitleUpdated(conversationId, result.title)
    } catch (err) { console.error('Generate title error:', err) }
    setLoading(null)
    setIsOpen(false)
  }

  return (
    <div className="relative">
      <button onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen) }}
        className="p-1 rounded transition-colors opacity-0 group-hover:opacity-100" style={{ color: 'var(--text-muted)' }}>
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-52 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}>

            <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Export</div>

            {(['pdf', 'md', 'html', 'json', 'txt'] as const).map(fmt => (
              <button key={fmt} onClick={() => handleExport(fmt)} disabled={!!loading}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors disabled:opacity-50"
                style={{ color: 'var(--text-secondary)' }}>
                {loading === `export-${fmt}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                  fmt === 'pdf' ? <FileType className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary-light, #ff6b6b)' }} /> :
                  fmt === 'md' ? <FileText className="w-3.5 h-3.5" /> :
                  fmt === 'html' ? <Globe className="w-3.5 h-3.5" /> :
                  fmt === 'json' ? <FileCode className="w-3.5 h-3.5" /> :
                  <Download className="w-3.5 h-3.5" />}
                {fmt === 'pdf' ? 'PDF (.pdf)' : fmt === 'md' ? 'Markdown (.md)' : fmt === 'html' ? 'HTML (.html)' : fmt === 'json' ? 'JSON (.json)' : 'Texte brut (.txt)'}
              </button>
            ))}

            <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
            <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>IA</div>

            <button onClick={handleSummarize} disabled={!!loading}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors disabled:opacity-50"
              style={{ color: 'var(--text-secondary)' }}>
              {loading === 'summarize' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
              Résumer + nouveau chat
            </button>

            <button onClick={handleGenerateTitle} disabled={!!loading}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors disabled:opacity-50"
              style={{ color: 'var(--text-secondary)' }}>
              {loading === 'title' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
              Renommer par IA
            </button>

            <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
            <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Dossier</div>

            <button onClick={(e) => { e.stopPropagation(); setShowFolderMenu(!showFolderMenu) }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors" style={{ color: 'var(--text-secondary)' }}>
              {loading === 'folder' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Folder className="w-3.5 h-3.5" />}
              Déplacer vers…
            </button>
            {showFolderMenu && (
              <div className="max-h-40 overflow-y-auto" style={{ background: 'var(--bg-tertiary, var(--bg-primary))' }}>
                <button onClick={() => handleMoveToFolder(null)}
                  className="w-full flex items-center gap-2.5 px-5 py-1.5 text-[11px] transition-colors" style={{ color: 'var(--text-muted)' }}>
                  <FolderMinus className="w-3 h-3" /> Aucun dossier
                </button>
                {folders.map(f => (
                  <button key={f.id} onClick={() => handleMoveToFolder(f.id)}
                    className="w-full flex items-center gap-2.5 px-5 py-1.5 text-[11px] transition-colors" style={{ color: 'var(--text-secondary)' }}>
                    <Folder className="w-3 h-3" style={{ color: f.color || 'var(--accent-primary)' }} /> {f.name}
                  </button>
                ))}
                {folders.length === 0 && (
                  <div className="px-5 py-1.5 text-[10px] italic" style={{ color: 'var(--text-muted)' }}>Aucun dossier créé</div>
                )}
              </div>
            )}

            <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

            <button onClick={(e) => { e.stopPropagation(); onStartEdit(); setIsOpen(false) }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors" style={{ color: 'var(--text-secondary)' }}>
              <Pencil className="w-3.5 h-3.5" /> Renommer
            </button>

            <button onClick={(e) => { e.stopPropagation(); onDelete(conversationId); setIsOpen(false) }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors" style={{ color: 'var(--accent-primary-light)' }}>
              <Trash2 className="w-3.5 h-3.5" /> Supprimer
            </button>
          </div>
        </>
      )}
    </div>
  )
}
