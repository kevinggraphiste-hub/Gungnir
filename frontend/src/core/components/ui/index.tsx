/**
 * Gungnir — Shared UI primitives.
 *
 * Matches the Conscience design language (cards, tabs, stat cards, buttons,
 * inputs) so every page/plugin uses the same visual vocabulary. Keep these
 * components thin: style-only wrappers, no logic.
 */
import React, { CSSProperties, ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react'

// ── SectionCard ────────────────────────────────────────────────────────────
type SectionCardProps = {
  children: ReactNode
  className?: string
  style?: CSSProperties
  accent?: string  // optional scarlet/accent tint (CSS color). When set, the
                   // card uses a color-mix tinted bg + border instead of neutral.
  padding?: 'sm' | 'md' | 'lg'
}
export function SectionCard({ children, className = '', style, accent, padding = 'md' }: SectionCardProps) {
  const pad = padding === 'sm' ? 'p-3' : padding === 'lg' ? 'p-6' : 'p-4'
  const base: CSSProperties = accent
    ? {
        background: `color-mix(in srgb, ${accent} 8%, var(--bg-secondary))`,
        border: `1px solid color-mix(in srgb, ${accent} 25%, transparent)`,
      }
    : { background: 'var(--bg-secondary)', border: '1px solid var(--border)' }
  return (
    <div className={`rounded-xl ${pad} ${className}`} style={{ ...base, ...style }}>
      {children}
    </div>
  )
}

// ── SectionTitle ───────────────────────────────────────────────────────────
type SectionTitleProps = {
  children: ReactNode
  icon?: ReactNode
  right?: ReactNode       // element rendered on the right side (info button, toggle, etc.)
  className?: string
  color?: string          // override color (e.g. accent for warning sections)
}
export function SectionTitle({ children, icon, right, className = '', color }: SectionTitleProps) {
  return (
    <div className={`flex items-center justify-between mb-3 ${className}`}>
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"
        style={{ color: color || 'var(--text-muted)' }}>
        {icon}
        <span>{children}</span>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}

// ── StatCard ───────────────────────────────────────────────────────────────
type StatCardProps = {
  label: string
  value: ReactNode
  icon?: ReactNode
  accent?: string         // color for icon/value tint
  className?: string
}
export function StatCard({ label, value, icon, accent, className = '' }: StatCardProps) {
  return (
    <div className={`rounded-lg p-3 ${className}`}
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--text-muted)' }}>{label}</div>
        {icon && (
          <div style={{ color: accent || 'var(--scarlet)' }}>{icon}</div>
        )}
      </div>
      <div className="text-lg font-bold" style={{ color: accent || 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  )
}

// ── TabBar ─────────────────────────────────────────────────────────────────
export type TabItem<K extends string = string> = {
  key: K
  label: string
  icon?: ReactNode
  badge?: ReactNode
}
type TabBarProps<K extends string> = {
  tabs: TabItem<K>[]
  active: K
  onChange: (key: K) => void
  accent?: string         // CSS color used for the active state tint
  className?: string
  size?: 'sm' | 'md'
}
export function TabBar<K extends string>({
  tabs, active, onChange, accent, className = '', size = 'md',
}: TabBarProps<K>) {
  const color = accent || 'var(--scarlet)'
  const py = size === 'sm' ? 'py-1.5' : 'py-2'
  const px = size === 'sm' ? 'px-3' : 'px-4'
  return (
    <div className={`flex items-center gap-1 flex-wrap ${className}`}>
      {tabs.map(t => {
        const isActive = t.key === active
        const style: CSSProperties = isActive
          ? {
              background: `color-mix(in srgb, ${color} 15%, transparent)`,
              color,
              border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
            }
          : {
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
            }
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`flex items-center gap-2 ${px} ${py} rounded-lg text-xs font-medium transition-all hover:brightness-110`}
            style={style}
          >
            {t.icon}
            <span>{t.label}</span>
            {t.badge != null && (
              <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold"
                style={{ background: isActive ? `color-mix(in srgb, ${color} 25%, transparent)` : 'var(--bg-tertiary)' }}>
                {t.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── PrimaryButton ──────────────────────────────────────────────────────────
type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}
export function PrimaryButton({ icon, children, className = '', size = 'md', ...rest }: PrimaryButtonProps) {
  const sz = size === 'sm' ? 'px-3 py-1.5 text-xs' : size === 'lg' ? 'px-5 py-2.5 text-sm' : 'px-4 py-2 text-sm'
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-2 ${sz} rounded-xl font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      style={{
        background: 'linear-gradient(135deg, var(--scarlet), color-mix(in srgb, var(--scarlet) 70%, #000))',
        color: '#fff',
        border: '1px solid color-mix(in srgb, var(--scarlet) 60%, transparent)',
        boxShadow: '0 2px 8px color-mix(in srgb, var(--scarlet) 20%, transparent)',
        ...rest.style,
      }}
    >
      {icon}
      {children}
    </button>
  )
}

// ── SecondaryButton ────────────────────────────────────────────────────────
type SecondaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  danger?: boolean
}
export function SecondaryButton({ icon, children, className = '', size = 'md', danger = false, ...rest }: SecondaryButtonProps) {
  const sz = size === 'sm' ? 'px-3 py-1.5 text-xs' : size === 'lg' ? 'px-5 py-2.5 text-sm' : 'px-4 py-2 text-sm'
  const color = danger ? '#ef4444' : 'var(--text-primary)'
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-2 ${sz} rounded-lg font-medium transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      style={{
        background: danger ? 'color-mix(in srgb, #ef4444 10%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
        color,
        border: `1px solid ${danger ? 'color-mix(in srgb, #ef4444 30%, transparent)' : 'var(--border)'}`,
        ...rest.style,
      }}
    >
      {icon}
      {children}
    </button>
  )
}

// ── FormInput ──────────────────────────────────────────────────────────────
type FormInputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string
  hint?: string
  error?: string
  leftIcon?: ReactNode
}
export function FormInput({ label, hint, error, leftIcon, className = '', ...rest }: FormInputProps) {
  return (
    <label className="flex flex-col gap-1.5 w-full">
      {label && (
        <span className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--text-muted)' }}>{label}</span>
      )}
      <div className="relative">
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
            {leftIcon}
          </div>
        )}
        <input
          {...rest}
          className={`w-full rounded-lg text-sm transition-all focus:outline-none ${leftIcon ? 'pl-10' : 'pl-3'} pr-3 py-2.5 ${className}`}
          style={{
            background: 'var(--bg-secondary)',
            border: `1px solid ${error ? '#ef4444' : 'var(--border-subtle)'}`,
            color: 'var(--text-primary)',
            ...rest.style,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--scarlet)'
            e.currentTarget.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--scarlet) 15%, transparent)'
            rest.onFocus?.(e)
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = error ? '#ef4444' : 'var(--border-subtle)'
            e.currentTarget.style.boxShadow = 'none'
            rest.onBlur?.(e)
          }}
        />
      </div>
      {(hint || error) && (
        <span className="text-[11px]" style={{ color: error ? '#ef4444' : 'var(--text-muted)' }}>
          {error || hint}
        </span>
      )}
    </label>
  )
}

// ── PageHeader ─────────────────────────────────────────────────────────────
type PageHeaderProps = {
  icon?: ReactNode
  title: string
  subtitle?: string
  version?: string        // small muted pill next to the title (e.g. "v1.0.1")
  actions?: ReactNode
  className?: string
}
export function PageHeader({ icon, title, subtitle, version, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={`flex items-center justify-between pb-4 mb-4 ${className}`}
      style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-3">
        {icon && (
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--scarlet) 25%, transparent)',
              color: 'var(--scarlet)',
            }}>
            {icon}
          </div>
        )}
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>{title}</h1>
            {version && (
              <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
                style={{
                  background: 'color-mix(in srgb, var(--scarlet) 10%, transparent)',
                  color: 'color-mix(in srgb, var(--scarlet) 80%, var(--text-muted))',
                  border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)',
                }}>
                v{version}
              </span>
            )}
          </div>
          {subtitle && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

// ── Badge ──────────────────────────────────────────────────────────────────
type BadgeProps = {
  children: ReactNode
  color?: string
  className?: string
}
export function Badge({ children, color = 'var(--scarlet)', className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${className}`}
      style={{
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}>
      {children}
    </span>
  )
}
