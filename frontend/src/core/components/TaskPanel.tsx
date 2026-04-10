/**
 * TaskPanel — todo-list interne style Claude Code, affichée en panneau latéral du Chat.
 *
 * L'agent peut lire/écrire via les outils WOLF `conversation_tasks_*`.
 * L'utilisateur peut cocher, ajouter, supprimer, réordonner depuis ce panneau.
 */
import { useState, useEffect, useCallback } from 'react'
import { api } from '../services/api'
import { Plus, Check, X, Circle, Loader2, Trash2, ListTodo } from 'lucide-react'

type Task = {
  id: number
  conversation_id: number
  content: string
  active_form?: string | null
  status: 'pending' | 'in_progress' | 'completed'
  position: number
  created_by: 'user' | 'agent'
}

interface Props {
  conversationId: number | null
  onClose?: () => void
}

export default function TaskPanel({ conversationId, onClose }: Props) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [newContent, setNewContent] = useState('')

  const load = useCallback(async () => {
    if (!conversationId) { setTasks([]); return }
    setLoading(true)
    try {
      const data = await api.listConversationTasks(conversationId)
      setTasks(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [conversationId])

  useEffect(() => { load() }, [load])

  // Rafraichit périodiquement (agent peut écrire pendant une réponse en cours)
  useEffect(() => {
    if (!conversationId) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [conversationId, load])

  const cycleStatus = async (task: Task) => {
    if (!conversationId) return
    const next: Task['status'] =
      task.status === 'pending' ? 'in_progress'
      : task.status === 'in_progress' ? 'completed'
      : 'pending'
    // Optimistic
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: next } : t))
    try {
      await api.updateConversationTask(conversationId, task.id, { status: next })
    } catch { load() }
  }

  const deleteTask = async (taskId: number) => {
    if (!conversationId) return
    setTasks(prev => prev.filter(t => t.id !== taskId))
    try { await api.deleteConversationTask(conversationId, taskId) } catch { load() }
  }

  const addTask = async () => {
    const content = newContent.trim()
    if (!content || !conversationId) return
    setNewContent('')
    try {
      const created = await api.createConversationTask(conversationId, { content, created_by: 'user' } as any)
      setTasks(prev => [...prev, created])
    } catch { load() }
  }

  const pending = tasks.filter(t => t.status === 'pending').length
  const inProgress = tasks.filter(t => t.status === 'in_progress').length
  const completed = tasks.filter(t => t.status === 'completed').length

  return (
    <aside
      className="flex flex-col h-full w-[320px] flex-shrink-0"
      style={{ background: 'var(--bg-primary)', borderLeft: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <ListTodo className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Todo-list</span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {completed}/{tasks.length}
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 rounded transition-colors" style={{ color: 'var(--text-muted)' }} title="Fermer">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {conversationId === null ? (
        <div className="flex-1 flex items-center justify-center text-center px-4">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Ouvre une conversation pour voir sa todo-list.
          </span>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
            {tasks.length === 0 && !loading && (
              <div className="text-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                Aucune tâche pour le moment.<br />
                <span className="text-[10px]">L'agent peut les créer automatiquement, ou tu peux en ajouter ci-dessous.</span>
              </div>
            )}
            {tasks.map(task => {
              const done = task.status === 'completed'
              const active = task.status === 'in_progress'
              return (
                <div
                  key={task.id}
                  className="group flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors"
                  style={{ background: active ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : undefined }}
                >
                  <button
                    onClick={() => cycleStatus(task)}
                    className="flex-shrink-0 mt-0.5"
                    title="Changer le statut"
                  >
                    {done ? (
                      <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-success)' }}>
                        <Check className="w-2.5 h-2.5" style={{ color: 'var(--bg-primary)' }} />
                      </div>
                    ) : active ? (
                      <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent-primary)' }} />
                    ) : (
                      <Circle className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    )}
                  </button>
                  <span
                    className="flex-1 text-xs leading-snug"
                    style={{
                      color: done ? 'var(--text-muted)' : 'var(--text-primary)',
                      textDecoration: done ? 'line-through' : 'none',
                    }}
                  >
                    {active && task.active_form ? task.active_form : task.content}
                    {task.created_by === 'agent' && (
                      <span className="ml-1.5 text-[9px] px-1 rounded" style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary-light, var(--accent-primary))' }}>
                        agent
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => deleteTask(task.id)}
                    className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded transition-opacity"
                    style={{ color: 'var(--text-muted)' }}
                    title="Supprimer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )
            })}
          </div>

          <div className="px-3 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newContent}
                onChange={e => setNewContent(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTask() }}
                placeholder="Nouvelle tâche…"
                className="flex-1 bg-transparent outline-none text-xs px-2 py-1.5 rounded"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <button
                onClick={addTask}
                className="p-1.5 rounded transition-colors"
                style={{ background: 'var(--accent-primary)', color: 'var(--bg-primary)' }}
                title="Ajouter"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {(pending > 0 || inProgress > 0) && (
              <div className="mt-2 flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {inProgress > 0 && <span>{inProgress} en cours</span>}
                {pending > 0 && <span>{pending} à faire</span>}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
