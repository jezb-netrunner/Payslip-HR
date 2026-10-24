import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { EntityProvider } from './lib/entity'
import { Spinner } from './components/ui'
import ChangePassword from './components/ChangePassword'
import Login from './pages/Login'
import Shell from './components/Shell'
import AdminDashboard from './pages/admin/Dashboard'
import Clients from './pages/admin/Clients'
import Users from './pages/admin/Users'
import Employees from './pages/admin/Employees'
import EmployeeDetail from './pages/admin/EmployeeDetail'
import Timesheets from './pages/admin/Timesheets'
import Schedules from './pages/admin/Schedules'
import LeavesAdmin from './pages/admin/LeavesAdmin'
import Payroll from './pages/admin/Payroll'
import PayrollRunDetail from './pages/admin/PayrollRunDetail'
import CashAdvances from './pages/admin/CashAdvances'
import Announcements from './pages/admin/Announcements'
import Reports from './pages/admin/Reports'
import Statutory from './pages/admin/Statutory'
import Holidays from './pages/admin/Holidays'
import Settings from './pages/admin/Settings'
import AuditLog from './pages/admin/AuditLog'
import MyDashboard from './pages/employee/MyDashboard'
import MyAttendance from './pages/employee/MyAttendance'
import MyPayslips from './pages/employee/MyPayslips'
import MyLeaves from './pages/employee/MyLeaves'
import MyAdvances from './pages/employee/MyAdvances'
import MyAnnouncements from './pages/employee/MyAnnouncements'
import MyProfile from './pages/employee/MyProfile'

function Centered({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-canvas p-4">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-bold text-ink-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">{body}</p>
        {children && <div className="mt-5 flex justify-center gap-4">{children}</div>}
      </div>
    </div>
  )
}

const linkBtn = 'text-sm font-semibold text-brand-600 hover:text-brand-800'

export default function App() {
  const { session, profile, loading, profileError, refreshProfile, isAdmin, isCompanyAdmin, isEmployee, recovering, clearRecovery, signOut } =
    useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <Spinner />
      </div>
    )
  }

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  if (recovering) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <h1 className="mb-4 text-lg font-bold text-ink-900">Choose a new password</h1>
          <ChangePassword />
          <button
            onClick={async () => {
              clearRecovery()
              await signOut()
            }}
            className={`mt-4 ${linkBtn}`}
          >
            Cancel and sign out
          </button>
        </div>
      </div>
    )
  }

  if (!profile) {
    return profileError ? (
      <Centered title="Couldn't load your account" body="Check your connection and try again.">
        <button onClick={refreshProfile} className={linkBtn}>Try again</button>
        <button onClick={signOut} className={linkBtn}>Sign out</button>
      </Centered>
    ) : (
      <Centered
        title="Account not provisioned"
        body="Your login exists but has no profile yet. Ask your administrator to set up your access."
      >
        <button onClick={signOut} className={linkBtn}>Sign out</button>
      </Centered>
    )
  }

  if (!profile.is_active) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-canvas p-4">
        <Centered title="Access disabled" body="This account has been deactivated. Contact your administrator." />
        <button onClick={signOut} className="text-sm font-semibold text-brand-600">Sign out</button>
      </div>
    )
  }

  if (!isAdmin && !isEmployee) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-canvas p-4">
        <Centered
          title="No access yet"
          body="This account is not linked to an employee record or an admin role. Ask your administrator."
        />
        <button onClick={signOut} className="text-sm font-semibold text-brand-600">Sign out</button>
      </div>
    )
  }

  return (
    <Routes>
      {isAdmin && (
        <Route
          path="/admin"
          element={
            <EntityProvider>
              <Shell mode="admin" />
            </EntityProvider>
          }
        >
          <Route index element={<AdminDashboard />} />
          {isCompanyAdmin && <Route path="clients" element={<Clients />} />}
          {isCompanyAdmin && <Route path="users" element={<Users />} />}
          <Route path="employees" element={<Employees />} />
          <Route path="employees/:id" element={<EmployeeDetail />} />
          <Route path="timesheets" element={<Timesheets />} />
          <Route path="schedules" element={<Schedules />} />
          <Route path="leaves" element={<LeavesAdmin />} />
          <Route path="payroll" element={<Payroll />} />
          <Route path="payroll/:id" element={<PayrollRunDetail />} />
          <Route path="advances" element={<CashAdvances />} />
          <Route path="announcements" element={<Announcements />} />
          <Route path="reports" element={<Reports />} />
          <Route path="statutory" element={<Statutory />} />
          <Route path="holidays" element={<Holidays />} />
          <Route path="settings" element={<Settings />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>
      )}
      {isEmployee && (
        <Route path="/me" element={<Shell mode="employee" />}>
          <Route index element={<MyDashboard />} />
          <Route path="payslips" element={<MyPayslips />} />
          <Route path="attendance" element={<MyAttendance />} />
          <Route path="leaves" element={<MyLeaves />} />
          <Route path="advances" element={<MyAdvances />} />
          <Route path="announcements" element={<MyAnnouncements />} />
          <Route path="profile" element={<MyProfile />} />
        </Route>
      )}
      <Route path="*" element={<Navigate to={isAdmin ? '/admin' : '/me'} replace />} />
    </Routes>
  )
}
