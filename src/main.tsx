import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './lib/auth'
import { ToastProvider } from './components/toast'
import { isFramed } from './lib/framing'

// BASE_URL is '/' in dev and '/<repo>/' when built with --base for GitHub
// Pages; React Router needs the same prefix (without the trailing slash).
const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

const root = document.getElementById('root')!

// GitHub Pages can't send X-Frame-Options and a meta CSP can't carry
// frame-ancestors, so the app refuses to start inside another page's frame:
// a site that framed it could overlay its own buttons on Finalize or Void
// (clickjacking) while the signed-in session keeps working underneath.
if (isFramed()) {
  root.textContent =
    'For your security, Payslip HR does not open inside another page. Open it in its own browser tab.'
} else {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basename}>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}
