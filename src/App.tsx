import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { Spinner } from './components/ui'
import Login from './pages/Login'
import Shell from './components/Shell'
import AdminDashboard from './pages/admin/Dashboard'
import Employees from './pages/admin/Employees'
import EmployeeDetail from './pages/admin/EmployeeDetail'
import Attendance from './pages/admin/Attendance'
import LeavesAdmin from './pages/admin/LeavesAdmin'
import Payroll from './pages/admin/Payroll'
import PayrollRunDetail from './pages/admin/PayrollRunDetail'
import Statutory from './pages/admin/Statutory'
import Holidays from './pages/admin/Holidays'
import Settings from './pages/admin/Settings'
import AuditLog from './pages/admin/AuditLog'
import TimeClock from './pages/employee/TimeClock'
import MyAttendance from './pages/employee/MyAttendance'
import MyPayslips from './pages/employee/MyPayslips'
import MyLeaves from './pages/employee/MyLeaves'
import MyProfile from './pages/employee/MyProfile'

export default function App() {
  const { session, profile, loading, isAdmin } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-100">
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

  if (!profile) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-100">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-bold text-brand-900">Account not provisioned</h1>
          <p className="mt-2 text-sm text-slate-500">
            Your login exists but has no profile yet. Ask your administrator to link your account
            to an employee record.
          </p>
        </div>
      </div>
    )
  }

  const hasEmployee = !!profile.employee_id

  return (
    <Routes>
      {isAdmin && (
        <Route path="/admin" element={<Shell mode="admin" />}>
          <Route index element={<AdminDashboard />} />
          <Route path="employees" element={<Employees />} />
          <Route path="employees/:id" element={<EmployeeDetail />} />
          <Route path="attendance" element={<Attendance />} />
          <Route path="leaves" element={<LeavesAdmin />} />
          <Route path="payroll" element={<Payroll />} />
          <Route path="payroll/:id" element={<PayrollRunDetail />} />
          <Route path="statutory" element={<Statutory />} />
          <Route path="holidays" element={<Holidays />} />
          <Route path="settings" element={<Settings />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>
      )}
      {hasEmployee && (
        <Route path="/me" element={<Shell mode="employee" />}>
          <Route index element={<TimeClock />} />
          <Route path="attendance" element={<MyAttendance />} />
          <Route path="payslips" element={<MyPayslips />} />
          <Route path="leaves" element={<MyLeaves />} />
          <Route path="profile" element={<MyProfile />} />
        </Route>
      )}
      <Route
        path="*"
        element={<Navigate to={isAdmin ? '/admin' : hasEmployee ? '/me' : '/admin'} replace />}
      />
    </Routes>
  )
}
