/**
 * Gungnir Plugin — Browser
 * Entry point (lazy-loaded by the core plugin loader)
 */
export default function BrowserPlugin() {
  return (
    <div className="flex-1 flex items-center justify-center p-6" style={{ color: 'var(--text-muted)' }}>
      <div className="text-center space-y-2">
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Browser</h2>
        <p className="text-sm">Plugin en cours de migration...</p>
      </div>
    </div>
  )
}
