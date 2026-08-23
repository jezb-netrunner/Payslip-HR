import { X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

// ---------- buttons ----------

type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'danger' | 'ghost'

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-800 text-white hover:bg-brand-700 disabled:bg-brand-300 shadow-sm',
  accent:
    'bg-accent-500 text-white hover:bg-accent-600 disabled:bg-accent-200 shadow-sm',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300 shadow-sm',
  ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-slate-400',
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${variantClasses[variant]} ${className}`}
      {...props}
    />
  )
}

// ---------- surfaces ----------

export function Card({
  children,
  className = '',
  title,
  actions,
}: {
  children: ReactNode
  className?: string
  title?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-brand-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  tone?: 'default' | 'accent' | 'good' | 'warn' | 'bad'
}) {
  const tones = {
    default: 'text-brand-900',
    accent: 'text-accent-600',
    good: 'text-emerald-600',
    warn: 'text-amber-600',
    bad: 'text-rose-600',
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        {icon && <span className="text-brand-300">{icon}</span>}
      </div>
      <p className={`mt-2 text-2xl font-extrabold tracking-tight ${tones[tone]}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

// ---------- badges ----------

const badgeTones: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-rose-100 text-rose-700',
  blue: 'bg-brand-100 text-brand-800',
  orange: 'bg-accent-100 text-accent-800',
  violet: 'bg-violet-100 text-violet-700',
}

export function Badge({ tone = 'slate', children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${badgeTones[tone] ?? badgeTones.slate}`}
    >
      {children}
    </span>
  )
}

// ---------- forms ----------

export function Field({
  label,
  children,
  hint,
  className = '',
}: {
  label: string
  children: ReactNode
  hint?: string
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  )
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-sm text-slate-700"
    >
      <span
        className={`relative inline-flex h-5.5 w-10 items-center rounded-full transition-colors ${checked ? 'bg-brand-700' : 'bg-slate-300'}`}
      >
        <span
          className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`}
        />
      </span>
      {label}
    </button>
  )
}

// ---------- modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-950/50 p-4 backdrop-blur-sm">
      <div
        className={`mt-8 w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} rounded-2xl bg-white shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-bold text-brand-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

// ---------- misc ----------

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center py-10 ${className}`}>
      <div className="size-8 animate-spin rounded-full border-[3px] border-brand-200 border-t-brand-700" />
    </div>
  )
}

export function EmptyState({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-sm font-semibold text-slate-600">{title}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  )
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 rounded-xl bg-slate-200/60 p-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${
            active === t.key
              ? 'bg-white text-brand-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-800'
          }`}
        >
          {t.label}
          {typeof t.count === 'number' && t.count > 0 && (
            <span className="ml-1.5 rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  className = '',
  colSpan,
}: {
  children?: ReactNode
  className?: string
  colSpan?: number
}) {
  return (
    <td colSpan={colSpan} className={`px-3 py-2.5 text-sm text-slate-700 ${className}`}>
      {children}
    </td>
  )
}

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-thin overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 bg-white">{children}</table>
    </div>
  )
}
