import { Link, NavLink, Outlet, matchPath, useLocation, useNavigate } from 'react-router-dom'
import {
  Briefcase,
  CalendarDays,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Clock,
  FileBarChart,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Palmtree,
  Plus,
  Scale,
  Settings as SettingsIcon,
  ShieldCheck,
  User,
  UserCog,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { useFocusTrap } from '../lib/focus'
import { useEntity } from '../lib/entity'
import { fullName, personInitials } from '../lib/format'
import { ROLE_LABELS } from '../lib/labels'
import { onPendingChanged } from '../lib/pending'
import { supabase } from '../lib/supabase'
import ChangePassword from './ChangePassword'
import { Avatar, Logo, Modal } from './ui'

type Counter = 'corrections' | 'leaves'

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  end?: boolean
  companyOnly?: boolean
  /** Pending requests waiting on an admin, shown as a red count. */
  counter?: Counter
}

interface NavGroup {
  title: string
  items: NavItem[]
}

const ic = 'size-5'

const adminGroups: NavGroup[] = [
  { title: 'Overview', items: [{ to: '/admin', label: 'Dashboard', icon: <LayoutDashboard className={ic} />, end: true }] },
  {
    title: 'People',
    items: [
      { to: '/admin/employees', label: 'Employees', icon: <Users className={ic} /> },
      { to: '/admin/timesheets', label: 'Time In / Out', icon: <Clock className={ic} />, counter: 'corrections' },
      { to: '/admin/leaves', label: 'Leaves', icon: <Palmtree className={ic} />, counter: 'leaves' },
      { to: '/admin/announcements', label: 'Announcements', icon: <Megaphone className={ic} /> },
    ],
  },
  {
    title: 'Payroll',
    items: [
      { to: '/admin/payroll', label: 'Pay Runs', icon: <Wallet className={ic} /> },
      { to: '/admin/reports', label: 'BIR & Reports', icon: <FileBarChart className={ic} /> },
    ],
  },
  {
    title: 'Setup',
    items: [
      { to: '/admin/clients', label: 'Clients', icon: <Briefcase className={ic} />, companyOnly: true },
      { to: '/admin/users', label: 'Admin Users', icon: <UserCog className={ic} />, companyOnly: true },
      { to: '/admin/settings', label: 'Client Settings', icon: <SettingsIcon className={ic} /> },
      { to: '/admin/holidays', label: 'Holidays', icon: <CalendarDays className={ic} /> },
      { to: '/admin/statutory', label: 'Statutory Tables', icon: <Scale className={ic} /> },
      { to: '/admin/audit', label: 'Audit Log', icon: <ShieldCheck className={ic} /> },
    ],
  },
]

const employeeGroups: NavGroup[] = [
  {
    title: 'Home',
    items: [
      { to: '/me', label: 'Dashboard', icon: <LayoutDashboard className={ic} />, end: true },
      { to: '/me/announcements', label: 'Announcements', icon: <Megaphone className={ic} /> },
    ],
  },
  { title: 'Pay', items: [{ to: '/me/payslips', label: 'Payslips', icon: <FileText className={ic} /> }] },
  {
    title: 'Time & Leave',
    items: [
      { to: '/me/attendance', label: 'Attendance', icon: <ClipboardList className={ic} /> },
      { to: '/me/leaves', label: 'Leaves', icon: <Palmtree className={ic} /> },
    ],
  },
  { title: 'Profile', items: [{ to: '/me/profile', label: 'My Profile', icon: <User className={ic} /> }] },
]

/** The employee portal's phone navigation: the five places employees go, always on screen. */
const employeeTabs: NavItem[] = [
  { to: '/me', label: 'Home', icon: <LayoutDashboard className={ic} />, end: true },
  { to: '/me/payslips', label: 'Payslips', icon: <FileText className={ic} /> },
  { to: '/me/attendance', label: 'Attendance', icon: <ClipboardList className={ic} /> },
  { to: '/me/leaves', label: 'Leaves', icon: <Palmtree className={ic} /> },
  { to: '/me/profile', label: 'Profile', icon: <User className={ic} /> },
]

// a per-viewer convenience: storage can be missing or throw (private mode, blocked site data)
const COLLAPSED_KEY = 'payslip-hr:sidebar-collapsed'
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}
function saveCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
  } catch {
    // not remembered: fine
  }
}

const quickActions = {
  admin: [
    { to: '/admin/employees?new=employee', label: 'Add employee', icon: <Users className="size-4" /> },
    { to: '/admin/payroll?new=run', label: 'New pay run', icon: <Wallet className="size-4" /> },
    { to: '/admin/leaves?new=leave', label: 'File leave for an employee', icon: <Palmtree className="size-4" /> },
    { to: '/admin/announcements?new=announcement', label: 'Post announcement', icon: <Megaphone className="size-4" /> },
  ],
  employee: [
    { to: '/me/leaves?new=leave', label: 'File a leave', icon: <Palmtree className="size-4" /> },
    { to: '/me/attendance?new=correction', label: 'Report a missing time entry', icon: <ClipboardList className="size-4" /> },
  ],
}

function isActive(item: NavItem, pathname: string) {
  return matchPath({ path: item.to, end: !!item.end }, pathname) !== null
}

/**
 * Closes a popover on an outside click, on Escape (focus goes back to its
 * button) and when keyboard focus moves on past it.
 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = ref.current
    if (!open || !box) return
    const onDown = (e: MouseEvent) => {
      if (!box.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      box.querySelector<HTMLElement>('button')?.focus()
    }
    // a click on plain text inside moves focus nowhere (relatedTarget null): stay open
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && !box.contains(e.relatedTarget)) close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    box.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      box.removeEventListener('focusout', onFocusOut)
    }
  }, [open, close])
  return ref
}

function EntitySwitcher({ variant }: { variant: 'bar' | 'drawer' }) {
  const { entities, entity, setEntityId, error } = useEntity()
  const { isCompanyAdmin } = useAuth()
  const active = entities.filter((e) => e.is_active)
  const archived = isCompanyAdmin ? entities.filter((e) => !e.is_active) : []
  const bar = variant === 'bar'
  if (error) return <p className={`text-xs ${bar ? 'text-rose-300' : 'text-rose-600'}`}>Clients could not be loaded.</p>
  if (active.length === 0 && !entity) {
    return (
      <p className={`text-xs ${bar ? 'text-white/60' : 'text-slate-500'}`}>
        {isCompanyAdmin ? 'No clients yet — add one under Clients.' : 'No client assigned to you yet.'}
      </p>
    )
  }
  // code first: a long registered name gets cut off by the select, the code must not
  const label = (e: (typeof entities)[number]) => `${e.code} · ${e.name}`
  return (
    <label className={bar ? 'flex min-w-0 items-center gap-2' : 'block'}>
      <span
        className={
          bar
            ? 'sr-only'
            : 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400'
        }
      >
        Working on client
      </span>
      <span className="relative block min-w-0">
        <Briefcase
          className={`pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ${bar ? 'text-accent-400' : 'text-slate-400'}`}
        />
        <select
          value={entity?.id ?? ''}
          title={entity ? `Working on ${entity.name} (${entity.code})` : undefined}
          onChange={(e) => setEntityId(e.target.value)}
          className={`w-full appearance-none truncate rounded-xl py-2 pl-9 pr-8 text-sm font-semibold focus:outline-none focus:ring-2 ${
            bar
              ? 'max-w-[13rem] bg-ink-800 text-white hover:bg-ink-700 focus:ring-accent-400 [&_optgroup]:bg-white [&_optgroup]:text-ink-900 [&_option]:bg-white [&_option]:text-ink-900'
              : 'border border-slate-200 bg-white text-ink-900 focus:ring-brand-200'
          }`}
        >
          {active.map((e) => (
            <option key={e.id} value={e.id}>
              {label(e)}
            </option>
          ))}
          {archived.length > 0 && (
            <optgroup label="Archived">
              {archived.map((e) => (
                <option key={e.id} value={e.id}>
                  {label(e)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <ChevronDown
          className={`pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 ${bar ? 'text-white/60' : 'text-slate-400'}`}
        />
      </span>
      {entity &&
        !entity.is_active &&
        (bar ? (
          // short in the bar: the full sentence pushed Quick add and Account off narrower screens
          <span
            title="Archived client — its entity admins are locked out"
            className="shrink-0 rounded-md bg-amber-400/15 px-2 py-1 text-[11px] font-semibold text-amber-300"
          >
            Archived
          </span>
        ) : (
          <span className="mt-1 block text-[11px] font-semibold text-amber-600">Archived — its entity admins are locked out</span>
        ))}
    </label>
  )
}

export default function Shell({ mode }: { mode: 'admin' | 'employee' }) {
  const { profile, employee, isCompanyAdmin, signOut } = useAuth()
  const { entity } = useEntity()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [drawer, setDrawer] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [changingPw, setChangingPw] = useState(false)
  const [employerName, setEmployerName] = useState('')
  const [counts, setCounts] = useState<{ entityId: string; corrections: number; leaves: number } | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [countsTick, setCountsTick] = useState(0)
  const quickRef = useDismiss(quickOpen, () => setQuickOpen(false))
  const drawerRef = useRef<HTMLElement>(null)
  useFocusTrap(drawer, drawerRef)
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])
  const accountRef = useDismiss(accountOpen, () => setAccountOpen(false))

  const groups = (mode === 'admin' ? adminGroups : employeeGroups)
    .map((g) => ({ ...g, items: g.items.filter((n) => !n.companyOnly || isCompanyAdmin) }))
    .filter((g) => g.items.length > 0)
  const current = groups.find((g) => g.items.some((n) => isActive(n, pathname))) ?? groups[0]

  useEffect(() => {
    if (mode !== 'employee' || !employee) return
    supabase
      .from('entities')
      .select('name')
      .eq('id', employee.entity_id)
      .maybeSingle()
      .then(({ data }) => setEmployerName((data?.name as string) ?? ''))
  }, [mode, employee])

  // requests waiting on an admin in the selected client: refreshed on every
  // navigation and whenever a page approves, rejects or files one
  const entityId = mode === 'admin' ? entity?.id : undefined
  useEffect(() => onPendingChanged(() => setCountsTick((n) => n + 1)), [])
  useEffect(() => {
    if (!entityId) return
    let stale = false
    Promise.all([
      supabase.from('time_correction_requests').select('id', { count: 'exact', head: true }).eq('entity_id', entityId).eq('status', 'pending'),
      supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('entity_id', entityId).eq('status', 'pending'),
    ]).then(([corr, leaves]) => {
      if (!stale) setCounts({ entityId, corrections: corr.count ?? 0, leaves: leaves.count ?? 0 })
    })
    return () => {
      stale = true
    }
  }, [entityId, pathname, countsTick])

  const displayName =
    mode === 'employee' && employee ? fullName(employee) : profile?.full_name || profile?.email || '?'
  const avatarInitials = mode === 'employee' && employee ? personInitials(employee) : undefined
  const roleLabel =
    mode === 'admin' ? ROLE_LABELS[profile?.role ?? 'employee'] : employerName || 'Employee'
  const count = (n: NavItem) => (n.counter && counts && counts.entityId === entityId ? counts[n.counter] : 0)
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      saveCollapsed(!c)
      return !c
    })
  }

  const doSignOut = async () => {
    await signOut()
    navigate('/')
  }

  const pills = (
    <>
      {current.items.map((n) => {
        const c = count(n)
        return (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive: on }) =>
              `flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                on ? 'bg-ink-800 text-white' : 'text-white/55 hover:text-white'
              }`
            }
          >
            {n.label}
            {c > 0 && <span className="rounded-md bg-rose-600 px-1.5 py-px text-[11px] font-bold text-white">{c}</span>}
          </NavLink>
        )
      })}
    </>
  )

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* top bar */}
      <header className="shrink-0 bg-ink-900 text-white">
        <div className="flex h-16 items-center gap-3 px-3 sm:px-5">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
            className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white lg:hidden"
          >
            <Menu className="size-5" />
          </button>
          <Link to={mode === 'admin' ? '/admin' : '/me'} aria-label="Payslip HR home" className="shrink-0">
            <Logo compact />
          </Link>
          {mode === 'admin' && (
            // phones have no room for the client switcher: always show which client is open
            <button
              type="button"
              onClick={() => setDrawer(true)}
              title={entity ? `Working on ${entity.name} (${entity.code}) — tap to switch` : 'No client selected'}
              className="max-w-[7rem] shrink-0 truncate rounded-lg bg-ink-800 px-2.5 py-1.5 text-xs font-bold text-accent-400 sm:hidden"
            >
              {entity?.code ?? 'No client'}
            </button>
          )}
          {/* phones and tablets: name the section (the sidebar does on desktop) */}
          <span className="hidden h-6 w-px shrink-0 bg-white/15 sm:block lg:hidden" />
          <h2 className="hidden shrink-0 text-lg font-bold sm:block lg:hidden">{current.title}</h2>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {mode === 'admin' && (
              <div className="hidden sm:block">
                <EntitySwitcher variant="bar" />
              </div>
            )}
            <div ref={quickRef} className="relative">
              <button
                type="button"
                aria-label="Quick add"
                aria-expanded={quickOpen}
                title="Quick add"
                onClick={() => setQuickOpen((o) => !o)}
                className="flex size-10 items-center justify-center rounded-xl bg-accent-400 text-ink-900 transition-colors hover:bg-accent-300"
              >
                <Plus className="size-5" strokeWidth={2.5} />
              </button>
              {quickOpen && (
                <div className="absolute right-0 top-12 z-50 w-64 rounded-xl border border-slate-200 bg-white p-1.5 text-ink-900 shadow-xl">
                  {quickActions[mode].map((q) => (
                    <Link
                      key={q.to}
                      to={q.to}
                      onClick={() => setQuickOpen(false)}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium hover:bg-slate-100"
                    >
                      <span className="text-slate-400">{q.icon}</span>
                      {q.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <span className="mx-1 hidden h-6 w-px bg-white/15 sm:block" />
            <div ref={accountRef} className="relative">
              <button
                type="button"
                aria-label="Account"
                aria-expanded={accountOpen}
                onClick={() => setAccountOpen((o) => !o)}
                className="flex items-center rounded-full ring-2 ring-white/15 transition hover:ring-white/40"
              >
                <Avatar name={displayName} initials={avatarInitials} size="md" />
              </button>
              {accountOpen && (
                <div className="absolute right-0 top-12 z-50 w-64 rounded-xl border border-slate-200 bg-white p-1.5 text-ink-900 shadow-xl">
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={displayName} initials={avatarInitials} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{displayName}</p>
                      <p className="truncate text-xs text-slate-500">{roleLabel}</p>
                    </div>
                  </div>
                  <div className="my-1 h-px bg-slate-100" />
                  {mode === 'admin' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAccountOpen(false)
                        setChangingPw(true)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-slate-100"
                    >
                      <KeyRound className="size-4 text-slate-400" /> Change password
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={doSignOut}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-rose-600 hover:bg-rose-50"
                  >
                    <LogOut className="size-4" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* admins on phones and tablets: the section's other pages one tap away (employees have the bottom tabs) */}
        {mode === 'admin' && current.items.length > 1 && (
          <nav aria-label={`${current.title} pages`} className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-3 sm:px-5 lg:hidden">
            {pills}
          </nav>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* desktop sidebar: every page named, grouped; collapsible to icons (remembered per browser) */}
        <aside
          aria-label="Main navigation"
          className={`scroll-thin hidden shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-slate-200/70 bg-white py-3 lg:flex ${
            collapsed ? 'w-[76px] items-center' : 'w-60'
          }`}
        >
          <nav aria-label="Pages" className={collapsed ? 'flex flex-col items-center' : 'px-3'}>
            {groups.map((g, gi) => (
              <div key={g.title} className={collapsed ? 'flex flex-col items-center gap-0.5' : 'mb-2'}>
                {collapsed
                  ? gi > 0 && <span className="my-1.5 h-px w-8 bg-slate-200" />
                  : g.items.length > 1 && (
                      <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g.title}</p>
                    )}
                {g.items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    title={collapsed ? n.label : undefined}
                    aria-label={collapsed ? n.label : undefined}
                    className={({ isActive: on }) =>
                      collapsed
                        ? `relative flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                            on ? 'bg-slate-100 text-ink-900' : 'text-slate-500 hover:bg-slate-50 hover:text-ink-900'
                          }`
                        : `flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                            on
                              ? 'bg-slate-100 font-semibold text-ink-900 [&>.nav-icon]:text-ink-900'
                              : 'font-medium text-slate-600 hover:bg-slate-50 hover:text-ink-900'
                          }`
                    }
                  >
                    {collapsed ? (
                      <>
                        {n.icon}
                        {count(n) > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-rose-500 ring-2 ring-white" />}
                      </>
                    ) : (
                      <>
                        <span className="nav-icon text-slate-400">{n.icon}</span>
                        <span className="min-w-0 flex-1 truncate">{n.label}</span>
                        {count(n) > 0 && (
                          <span className="rounded-md bg-rose-600 px-1.5 py-px text-[11px] font-bold text-white">{count(n)}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className={`mt-auto flex shrink-0 flex-col gap-0.5 border-t border-slate-100 pt-2 ${collapsed ? 'items-center' : 'px-3'}`}>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand the menu' : undefined}
              aria-label={collapsed ? 'Expand the menu' : undefined}
              className={`flex items-center rounded-xl text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-ink-900 ${
                collapsed ? 'size-10 justify-center' : 'gap-3 px-3 py-2'
              }`}
            >
              {collapsed ? <ChevronsRight className={ic} /> : <ChevronsLeft className={ic} />}
              {!collapsed && 'Collapse menu'}
            </button>
            <button
              type="button"
              onClick={doSignOut}
              title={collapsed ? 'Sign out' : undefined}
              aria-label={collapsed ? 'Sign out' : undefined}
              className={`flex items-center rounded-xl text-sm font-medium text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-600 ${
                collapsed ? 'size-10 justify-center' : 'gap-3 px-3 py-2'
              }`}
            >
              <LogOut className={ic} />
              {!collapsed && 'Sign out'}
            </button>
          </div>
        </aside>

        <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] p-4 sm:p-6 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>

      {mode === 'employee' && (
        // part of the page column, not fixed: the content scrolls above it and is never hidden under it
        <nav aria-label="Main" className="shrink-0 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
          <div className="mx-auto grid max-w-lg grid-cols-5">
            {employeeTabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive: on }) =>
                  `flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors ${
                    on ? 'text-brand-700' : 'text-slate-500 hover:text-ink-900'
                  }`
                }
              >
                {t.icon}
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}

      {/* phone / tablet drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/50" onClick={() => setDrawer(false)} />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 flex w-[19rem] max-w-[85vw] flex-col bg-white shadow-2xl"
          >
            <div className="flex h-16 shrink-0 items-center justify-between bg-ink-900 px-4">
              <Logo />
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawer(false)}
                className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white"
              >
                <X className="size-5" />
              </button>
            </div>
            {mode === 'admin' && (
              <div className="border-b border-slate-100 p-4">
                <EntitySwitcher variant="drawer" />
              </div>
            )}
            <nav className="scroll-thin flex-1 overflow-y-auto p-3">
              {groups.map((g) => (
                <div key={g.title} className="mb-3">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.title}</p>
                  {g.items.map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      end={n.end}
                      onClick={() => setDrawer(false)}
                      className={({ isActive: on }) =>
                        `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                          on ? 'bg-slate-100 text-ink-900' : 'text-slate-600 hover:bg-slate-50 hover:text-ink-900'
                        }`
                      }
                    >
                      <span className="text-slate-400">{n.icon}</span>
                      <span className="flex-1">{n.label}</span>
                      {count(n) > 0 && (
                        <span className="rounded-md bg-rose-600 px-1.5 py-px text-[11px] font-bold text-white">{count(n)}</span>
                      )}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
            <div className="flex items-center gap-3 border-t border-slate-100 p-4">
              <Avatar name={displayName} initials={avatarInitials} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900">{displayName}</p>
                <p className="truncate text-xs text-slate-500">{roleLabel}</p>
              </div>
              {mode === 'admin' && (
                <button
                  type="button"
                  title="Change password"
                  aria-label="Change password"
                  onClick={() => setChangingPw(true)}
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-ink-900"
                >
                  <KeyRound className="size-4" />
                </button>
              )}
              <button
                type="button"
                title="Sign out"
                aria-label="Sign out"
                onClick={doSignOut}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-ink-900"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </aside>
        </div>
      )}

      <Modal open={changingPw} onClose={() => setChangingPw(false)} title="Change password">
        <ChangePassword onDone={() => setChangingPw(false)} />
      </Modal>
    </div>
  )
}
