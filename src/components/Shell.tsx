import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Building2,
  Briefcase,
  CalendarDays,
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
  Scale,
  Settings as SettingsIcon,
  ShieldCheck,
  User,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useEntity } from '../lib/entity'
import { fullName, initials } from '../lib/format'
import { ROLE_LABELS } from '../lib/labels'
import { supabase } from '../lib/supabase'
import ChangePassword from './ChangePassword'
import { Modal } from './ui'

interface NavItem {
  to: string
  label: string
  icon: React.ReactNode
  end?: boolean
  companyOnly?: boolean
}

const ic = 'size-4.5'

const adminNav: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: <LayoutDashboard className={ic} />, end: true },
  { to: '/admin/clients', label: 'Clients', icon: <Briefcase className={ic} />, companyOnly: true },
  { to: '/admin/users', label: 'Admin Users', icon: <UserCog className={ic} />, companyOnly: true },
  { to: '/admin/employees', label: 'Employees', icon: <Users className={ic} /> },
  { to: '/admin/timesheets', label: 'Time In / Out', icon: <Clock className={ic} /> },
  { to: '/admin/leaves', label: 'Leaves', icon: <Palmtree className={ic} /> },
  { to: '/admin/payroll', label: 'Payroll', icon: <Wallet className={ic} /> },
  { to: '/admin/announcements', label: 'Announcements', icon: <Megaphone className={ic} /> },
  { to: '/admin/reports', label: 'BIR & Reports', icon: <FileBarChart className={ic} /> },
  { to: '/admin/holidays', label: 'Holidays', icon: <CalendarDays className={ic} /> },
  { to: '/admin/statutory', label: 'Statutory Tables', icon: <Scale className={ic} /> },
  { to: '/admin/settings', label: 'Client Settings', icon: <SettingsIcon className={ic} /> },
  { to: '/admin/audit', label: 'Audit Log', icon: <ShieldCheck className={ic} /> },
]

const employeeNav: NavItem[] = [
  { to: '/me', label: 'Dashboard', icon: <LayoutDashboard className={ic} />, end: true },
  { to: '/me/payslips', label: 'My Payslips', icon: <FileText className={ic} /> },
  { to: '/me/attendance', label: 'My Attendance', icon: <ClipboardList className={ic} /> },
  { to: '/me/leaves', label: 'My Leaves', icon: <Palmtree className={ic} /> },
  { to: '/me/announcements', label: 'Announcements', icon: <Megaphone className={ic} /> },
  { to: '/me/profile', label: 'My Profile', icon: <User className={ic} /> },
]

function EntitySwitcher() {
  const { entities, entity, setEntityId } = useEntity()
  const { isCompanyAdmin } = useAuth()
  const active = entities.filter((e) => e.is_active)
  const archived = isCompanyAdmin ? entities.filter((e) => !e.is_active) : []
  if (active.length === 0 && !entity) {
    return (
      <p className="px-3 text-[11px] text-brand-300">
        {isCompanyAdmin ? 'No clients yet — add one under Clients.' : 'No client assigned to you yet.'}
      </p>
    )
  }
  // code first: a long registered name gets cut off by the select, the code must not
  const label = (e: (typeof entities)[number]) => `${e.code} · ${e.name}`
  return (
    <label className="block px-3">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-brand-300">
        Working on client
      </span>
      <select
        value={entity?.id ?? ''}
        title={entity ? `${entity.name} (${entity.code})` : undefined}
        onChange={(e) => setEntityId(e.target.value)}
        className="w-full truncate rounded-lg border border-brand-700 bg-brand-800 px-2.5 py-1.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-accent-500"
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
      {entity && !entity.is_active && (
        <span className="mt-1 block text-[11px] font-semibold text-amber-300">Archived client — its entity admins are locked out</span>
      )}
    </label>
  )
}

export default function Shell({ mode }: { mode: 'admin' | 'employee' }) {
  const { profile, employee, isCompanyAdmin, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [changingPw, setChangingPw] = useState(false)
  const [employerName, setEmployerName] = useState('')
  const nav = (mode === 'admin' ? adminNav : employeeNav).filter((n) => !n.companyOnly || isCompanyAdmin)

  useEffect(() => {
    if (mode !== 'employee' || !employee) return
    supabase
      .from('entities')
      .select('name')
      .eq('id', employee.entity_id)
      .maybeSingle()
      .then(({ data }) => setEmployerName((data?.name as string) ?? ''))
  }, [mode, employee])

  const displayName =
    mode === 'employee' && employee ? fullName(employee) : profile?.full_name || profile?.email || '?'

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-900">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex size-9 items-center justify-center rounded-xl bg-white/10">
          <Building2 className="size-5 text-accent-400" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-extrabold tracking-tight text-white">Payslip HR</p>
          <p className="truncate text-[10px] font-medium uppercase tracking-wider text-brand-300">
            {mode === 'admin' ? (isCompanyAdmin ? 'Company Admin' : 'Entity Admin') : employerName || 'Employee Portal'}
          </p>
        </div>
      </div>
      {mode === 'admin' && (
        <div className="pb-3">
          <EntitySwitcher />
        </div>
      )}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-accent-500 text-white shadow-sm'
                  : 'text-brand-200 hover:bg-brand-800 hover:text-white'
              }`
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-brand-800 p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white">
            {initials(displayName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-white">{displayName}</p>
            <p className="text-[10px] text-brand-300">{ROLE_LABELS[profile?.role ?? 'employee']}</p>
          </div>
          {mode === 'admin' && (
            <button
              title="Change password"
              onClick={() => setChangingPw(true)}
              className="rounded-lg p-1.5 text-brand-300 hover:bg-brand-800 hover:text-white"
            >
              <KeyRound className="size-4" />
            </button>
          )}
          <button
            title="Sign out"
            onClick={async () => {
              await signOut()
              navigate('/')
            }}
            className="rounded-lg p-1.5 text-brand-300 hover:bg-brand-800 hover:text-white"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-brand-950/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100">
            <Menu className="size-5" />
          </button>
          <p className="text-sm font-bold text-brand-900">Payslip HR</p>
        </header>
        <main className="scroll-thin flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
      <Modal open={changingPw} onClose={() => setChangingPw(false)} title="Change password">
        <ChangePassword onDone={() => setChangingPw(false)} />
      </Modal>
    </div>
  )
}
