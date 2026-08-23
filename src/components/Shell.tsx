import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  Building2,
  CalendarDays,
  ClipboardList,
  Clock,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Palmtree,
  Scale,
  Settings as SettingsIcon,
  ShieldCheck,
  User,
  Users,
  Wallet,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { initials } from '../lib/format'

interface NavItem {
  to: string
  label: string
  icon: React.ReactNode
  end?: boolean
}

const adminNav: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: <LayoutDashboard className="size-4.5" />, end: true },
  { to: '/admin/employees', label: 'Employees', icon: <Users className="size-4.5" /> },
  { to: '/admin/attendance', label: 'Time & Attendance', icon: <Clock className="size-4.5" /> },
  { to: '/admin/leaves', label: 'Leaves', icon: <Palmtree className="size-4.5" /> },
  { to: '/admin/payroll', label: 'Payroll', icon: <Wallet className="size-4.5" /> },
  { to: '/admin/statutory', label: 'Statutory Tables', icon: <Scale className="size-4.5" /> },
  { to: '/admin/holidays', label: 'Holidays', icon: <CalendarDays className="size-4.5" /> },
  { to: '/admin/audit', label: 'Audit Log', icon: <ShieldCheck className="size-4.5" /> },
  { to: '/admin/settings', label: 'Settings', icon: <SettingsIcon className="size-4.5" /> },
]

const employeeNav: NavItem[] = [
  { to: '/me', label: 'Time Clock', icon: <Clock className="size-4.5" />, end: true },
  { to: '/me/attendance', label: 'My Attendance', icon: <ClipboardList className="size-4.5" /> },
  { to: '/me/payslips', label: 'My Payslips', icon: <FileText className="size-4.5" /> },
  { to: '/me/leaves', label: 'My Leaves', icon: <Palmtree className="size-4.5" /> },
  { to: '/me/profile', label: 'My Profile', icon: <User className="size-4.5" /> },
]

export default function Shell({ mode }: { mode: 'admin' | 'employee' }) {
  const { profile, isAdmin, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const nav = mode === 'admin' ? adminNav : employeeNav

  const crossLink =
    mode === 'admin' && profile?.employee_id ? (
      <NavLink to="/me" className="sidebar-cross flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-brand-200 hover:bg-brand-800 hover:text-white">
        <User className="size-4.5" /> My Employee Portal
      </NavLink>
    ) : mode === 'employee' && isAdmin ? (
      <NavLink to="/admin" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-brand-200 hover:bg-brand-800 hover:text-white">
        <BarChart3 className="size-4.5" /> Admin Portal
      </NavLink>
    ) : null

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-900">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex size-9 items-center justify-center rounded-xl bg-white/10">
          <Building2 className="size-5 text-accent-400" />
        </div>
        <div>
          <p className="text-sm font-extrabold tracking-tight text-white">Payslip HR</p>
          <p className="text-[10px] font-medium uppercase tracking-wider text-brand-300">
            {mode === 'admin' ? 'Admin Console' : 'Employee Portal'}
          </p>
        </div>
      </div>
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
        <div className="my-3 border-t border-brand-800" />
        {crossLink}
      </nav>
      <div className="border-t border-brand-800 p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <div className="flex size-8 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white">
            {initials(profile?.full_name || profile?.email || '?')}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-white">
              {profile?.full_name || profile?.email}
            </p>
            <p className="text-[10px] capitalize text-brand-300">{profile?.role}</p>
          </div>
          <button
            title="Sign out"
            onClick={async () => {
              await signOut()
              navigate('/login')
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
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-brand-950/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64">{sidebar}</aside>
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
    </div>
  )
}
