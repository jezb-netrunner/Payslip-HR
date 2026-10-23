import { Inbox, X } from 'lucide-react'
import { createContext, useContext, useEffect, useId } from 'react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useEntity } from '../lib/entity'
import { initials } from '../lib/format'

// ---------- brand ----------

/** The app's mark: a yellow payslip. */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M5 2.5h14a1 1 0 0 1 1 1V21l-2.67-1.6L14.67 21 12 19.4 9.33 21l-2.66-1.6L4 21V3.5a1 1 0 0 1 1-1z" fill="#f5d547" />
      <path d="M8 8h8M8 11.5h8M8 15h5" stroke="#1d1b25" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** `compact` drops the wordmark on the narrowest phones (the mark stays). */
export function Logo({ dark = false, compact = false, className = '' }: { dark?: boolean; compact?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark />
      <span className={`text-lg font-extrabold tracking-tight ${dark ? 'text-ink-900' : 'text-white'} ${compact ? 'hidden min-[380px]:inline' : ''}`}>
        payslip<span className="text-accent-500">hr</span>
      </span>
    </span>
  )
}

// ---------- buttons ----------

type ButtonVariant = 'primary' | 'dark' | 'secondary' | 'accent' | 'danger' | 'ghost'

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-200',
  dark: 'bg-ink-900 text-white hover:bg-ink-800 disabled:bg-slate-300',
  accent: 'bg-accent-400 text-ink-900 hover:bg-accent-300 disabled:bg-accent-100 disabled:text-slate-400',
  secondary:
    'bg-white text-ink-900 border border-slate-200 shadow-xs hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  ghost: 'text-brand-700 hover:bg-brand-50 disabled:text-slate-400',
}

// Sizes are props, not caller classes: in Tailwind v4 a caller's px-3 can lose
// to the base px-4 (stylesheet order decides, not class order).
const buttonSizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm' }

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: keyof typeof buttonSizes }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed ${buttonSizes[size]} ${variantClasses[variant]} ${className}`}
      {...props}
    />
  )
}

/** A square or round icon-only button (prev/next, kebab menus, close). */
export function IconButton({
  label,
  round = false,
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; round?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center border border-slate-200 bg-white text-ink-900 shadow-xs transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 ${size === 'sm' ? 'size-8' : 'size-9'} ${round ? 'rounded-full' : 'rounded-lg'} ${className}`}
      {...props}
    />
  )
}

// ---------- surfaces ----------

export function Card({
  children,
  className = '',
  title,
  icon,
  actions,
}: {
  children: ReactNode
  className?: string
  title?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={`rounded-xl border border-slate-200/80 bg-white ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <h3 className="flex items-center gap-2.5 text-base font-bold text-ink-900">
            {icon && <span className="text-slate-400 [&>svg]:size-5">{icon}</span>}
            {title}
          </h3>
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
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Inline status counts under a page title: "● Active 28  ● Inactive 4". */
export function StatusCounts({ items }: { items: { label: string; count: number; dot: string }[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-sm text-ink-900">
          <span className={`size-1.5 rounded-full ${i.dot}`} />
          {i.label} <span className="font-semibold">{i.count}</span>
        </span>
      ))}
    </span>
  )
}

const InStatGroup = createContext(false)

/** One card holding several stats side by side, split by thin dividers. */
export function StatGroup({ children, className = '', bare = false }: { children: ReactNode; className?: string; bare?: boolean }) {
  return (
    <div className={`overflow-hidden bg-white ${bare ? '' : 'rounded-xl border border-slate-200/80'} ${className}`}>
      <div className="-ml-px flex flex-wrap">
        <InStatGroup.Provider value={true}>{children}</InStatGroup.Provider>
      </div>
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
  const grouped = useContext(InStatGroup)
  const tones = {
    default: 'text-ink-900',
    accent: 'text-brand-700',
    good: 'text-leaf-600',
    warn: 'text-amber-600',
    bad: 'text-rose-600',
  }
  return (
    <div
      className={
        grouped
          ? 'my-4 min-w-[160px] flex-1 border-l border-slate-200/80 px-5'
          : 'rounded-xl border border-slate-200/80 bg-white p-5'
      }
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-600">{label}</p>
        {icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 [&>svg]:size-4">
            {icon}
          </span>
        )}
      </div>
      <p className={`mt-1 text-2xl font-bold tracking-tight ${tones[tone]}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

/** A ring chart: segments in order around the circle, an optional label in the middle. */
export function Donut({
  segments,
  size = 184,
  thickness = 18,
  center,
}: {
  segments: { value: number; color: string; label: string }[]
  size?: number
  thickness?: number
  center?: ReactNode
}) {
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const shown = segments.filter((s) => s.value > 0)
  const total = shown.reduce((sum, s) => sum + s.value, 0)
  const gap = shown.length > 1 ? 3 : 0
  let offset = 0
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" role="img" aria-label={shown.map((s) => s.label).join(', ')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f1f5" strokeWidth={thickness} />
        {total > 0 &&
          shown.map((s) => {
            const len = (s.value / total) * c
            const dash = Math.max(0.5, len - gap)
            const el = (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
              >
                <title>{`${s.label} — ${Math.round((s.value / total) * 100)}%`}</title>
              </circle>
            )
            offset += len
            return el
          })}
      </svg>
      {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
    </div>
  )
}

// ---------- people ----------

const avatarTones = [
  'bg-brand-100 text-brand-800',
  'bg-leaf-100 text-leaf-700',
  'bg-violet-100 text-violet-700',
  'bg-accent-100 text-accent-800',
  'bg-sky-100 text-sky-800',
  'bg-rose-100 text-rose-700',
]

const avatarSizes = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-20 text-2xl',
}

/**
 * Initials on a soft colour picked from the name, so a person keeps one colour
 * everywhere. Pass `initials` when first and last name are known: the first
 * two words of a full name are often first and middle name.
 */
export function Avatar({
  name,
  initials: given,
  size = 'md',
  className = '',
}: {
  name: string
  initials?: string
  size?: keyof typeof avatarSizes
  className?: string
}) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${avatarSizes[size]} ${avatarTones[h % avatarTones.length]} ${className}`}
    >
      {(given || initials(name)).toUpperCase() || '?'}
    </span>
  )
}

// ---------- badges ----------

const badgeTones: Record<string, { chip: string; dot: string }> = {
  slate: { chip: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  green: { chip: 'bg-leaf-50 text-leaf-700 ring-1 ring-inset ring-leaf-200/70', dot: 'bg-leaf-500' },
  amber: { chip: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200/70', dot: 'bg-amber-400' },
  red: { chip: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200/70', dot: 'bg-rose-500' },
  blue: { chip: 'bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200/70', dot: 'bg-work' },
  orange: { chip: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200/70', dot: 'bg-overtime' },
  violet: { chip: 'bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200/70', dot: 'bg-violet-500' },
  solid: { chip: 'bg-leaf-700 text-white', dot: 'bg-leaf-200' },
  dark: { chip: 'bg-ink-900 text-white', dot: 'bg-accent-400' },
}

export function Badge({
  tone = 'slate',
  dot = true,
  icon,
  children,
}: {
  tone?: string
  dot?: boolean
  icon?: ReactNode
  children: ReactNode
}) {
  const t = badgeTones[tone] ?? badgeTones.slate
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${t.chip}`}
    >
      {icon ? <span className="[&>svg]:size-3.5">{icon}</span> : dot && <span className={`size-1.5 shrink-0 rounded-full ${t.dot}`} />}
      {children}
    </span>
  )
}

// ---------- forms ----------

/**
 * A captioned form control. `group` is for several controls under one
 * caption (checkbox lists, day pickers): a <label> would forward every click
 * on its caption to the first control inside it.
 */
export function Field({
  label,
  children,
  hint,
  className = '',
  group = false,
}: {
  label: string
  children: ReactNode
  hint?: string
  className?: string
  group?: boolean
}) {
  const id = useId()
  const caption = (
    <span id={id} className="mb-1.5 block text-[13px] font-medium text-slate-500">
      {label}
    </span>
  )
  const note = hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>
  if (group) {
    return (
      <div role="group" aria-labelledby={id} className={`block ${className}`}>
        {caption}
        {children}
        {note}
      </div>
    )
  }
  return (
    <label className={`block ${className}`}>
      {caption}
      {children}
      {note}
    </label>
  )
}

const inputClass =
  'rounded-lg border px-3 py-2 text-sm text-ink-900 placeholder-slate-400 shadow-xs transition-colors focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500'

/**
 * Defaults the caller didn't set: full width, a grey border, a white field.
 * CSS order, not class order, decides between two utilities for the same
 * property, so a caller's width or colours only win if the default is left out.
 */
function controlClass(className?: string): string {
  const c = className ?? ''
  const width = /(^|\s)w-/.test(c) ? '' : 'w-full '
  const border = /(^|\s)border-[a-z]+-\d/.test(c) ? '' : 'border-slate-200 '
  const bg = /(^|\s)bg-/.test(c) ? '' : 'bg-white '
  return `${inputClass} ${width}${border}${bg}${c}`
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={controlClass(props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={controlClass(props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={controlClass(props.className)} />
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
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-left text-sm text-slate-700"
    >
      <span
        className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-brand-700' : 'bg-slate-300'}`}
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
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal-glow mt-8 w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} rounded-2xl bg-white shadow-2xl sm:mt-16`}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-5">
          <h3 id={titleId} className="text-lg font-bold text-ink-900">{title}</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1.5 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-ink-900"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="px-6 pb-6 pt-3">{children}</div>
      </div>
    </div>
  )
}

// ---------- misc ----------

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center py-10 ${className}`}>
      <div className="size-8 animate-spin rounded-full border-[3px] border-brand-100 border-t-brand-700" />
    </div>
  )
}

export function EmptyState({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Inbox className="size-5" />
      </span>
      <p className="text-sm font-semibold text-ink-900">{title}</p>
      {sub && <p className="mt-1 max-w-sm text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

/**
 * Keyboard model of ARIA tabs and radio groups: only the selected option is in
 * the tab order; arrows move to and pick the next/previous one, Home/End the
 * ends.
 */
function arrowSelect(e: ReactKeyboardEvent<HTMLElement>, keys: string[], current: string, pick: (k: string) => void) {
  const i = keys.indexOf(current)
  const n = keys.length
  const j =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? (i - 1 + n) % n
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? n - 1
            : -1
  if (j < 0 || n === 0) return
  e.preventDefault()
  pick(keys[j])
  e.currentTarget.querySelectorAll<HTMLElement>('[data-option]')[j]?.focus()
}

/** Underlined section tabs with optional icons and counts. */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number; icon?: ReactNode }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div
      role="tablist"
      onKeyDown={(e) =>
        arrowSelect(
          e,
          tabs.map((t) => t.key),
          active,
          onChange,
        )
      }
      className="mb-6 flex flex-wrap gap-x-2 border-b border-slate-200"
    >
      {tabs.map((t) => {
        const on = active === t.key
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            data-option
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-[3px] px-2.5 pb-3 pt-1.5 text-sm transition-colors [&>svg]:size-4 ${
              on ? 'border-ink-900 font-semibold text-ink-900' : 'border-transparent font-medium text-slate-500 hover:text-ink-900'
            }`}
          >
            {t.icon}
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && (
              <span className="rounded-md bg-rose-500 px-1.5 py-px text-[11px] font-bold text-white">{t.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** A compact switch between views: the active option is a dark pill. */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: K; label: ReactNode }[]
  value: K
  onChange: (key: K) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) =>
        arrowSelect(
          e,
          options.map((o) => o.key),
          value,
          (k) => onChange(k as K),
        )
      }
      className="inline-flex rounded-xl bg-slate-100 p-1"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          data-option
          aria-checked={value === o.key}
          tabIndex={value === o.key ? 0 : -1}
          onClick={() => onChange(o.key)}
          className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors [&>svg]:size-4 ${
            value === o.key ? 'bg-ink-900 text-white shadow-sm' : 'text-slate-500 hover:text-ink-900'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap bg-slate-100 px-4 py-3 text-left text-xs font-semibold text-slate-600 ${className}`}
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
  // the caller's text colour must win, so only colour cells that don't set one
  const color = /(^|\s)text-(slate|brand|ink|rose|emerald|amber|leaf|accent)-/.test(className) ? '' : 'text-slate-700'
  return (
    <td colSpan={colSpan} className={`px-4 py-3 text-sm ${color} ${className}`}>
      {children}
    </td>
  )
}

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="scroll-thin overflow-x-auto rounded-xl border border-slate-200/80 bg-white">
      <table className="min-w-full divide-y divide-slate-100 bg-white [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-slate-50/70 [&_tbody]:divide-y [&_tbody]:divide-slate-100">
        {children}
      </table>
    </div>
  )
}

/** A read that failed (network, expired session): say so instead of spinning or showing "nothing". */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
      {message}{' '}
      <button type="button" onClick={onRetry} className="font-semibold underline">
        Try again
      </button>
    </div>
  )
}

/** Shown by client-scoped pages when no client is selected or assigned. */
export function NoClient({ companyAdmin }: { companyAdmin: boolean }) {
  const { loading, error, reload } = useEntity()
  // the client list is still loading: don't claim there are none
  if (loading) return <Spinner />
  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-center text-sm text-rose-700">
        {error}.{' '}
        <button type="button" onClick={() => reload()} className="font-semibold underline">
          Try again
        </button>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white p-10 text-center">
      <p className="text-sm font-semibold text-ink-900">
        {companyAdmin ? 'No client yet' : 'No client assigned to your account'}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {companyAdmin
          ? 'Add your first client under Clients, then pick it in the top bar.'
          : 'Ask a company admin to assign you to a client.'}
      </p>
    </div>
  )
}
