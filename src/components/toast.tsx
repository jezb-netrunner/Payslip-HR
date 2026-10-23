import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const ToastContext = createContext<(kind: ToastKind, message: string) => void>(() => {})

let nextId = 1

const looks: Record<ToastKind, { stripe: string; icon: ReactNode }> = {
  success: { stripe: 'bg-leaf-400', icon: <CheckCircle2 className="size-5 text-leaf-300" /> },
  error: { stripe: 'bg-rose-500', icon: <XCircle className="size-5 text-rose-400" /> },
  info: { stripe: 'bg-sky-400', icon: <Info className="size-5 text-sky-300" /> },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId++
      setToasts((t) => [...t, { id, kind, message }])
      setTimeout(() => dismiss(id), 5000)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed right-4 top-3 z-[100] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="flex items-center gap-3 rounded-xl bg-ink-900 py-2.5 pl-2.5 pr-2 text-white shadow-xl ring-1 ring-white/10"
          >
            <span className={`w-1 self-stretch rounded-full ${looks[t.kind].stripe}`} />
            <span className="shrink-0">{looks[t.kind].icon}</span>
            <p className="min-w-0 flex-1 text-sm font-medium">{t.message}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-lg p-1 text-white/60 hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(ToastContext)
}
