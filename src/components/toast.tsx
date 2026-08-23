import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle, Info } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const ToastContext = createContext<(kind: ToastKind, message: string) => void>(() => {})

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId++
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }, [])

  const icons: Record<ToastKind, ReactNode> = {
    success: <CheckCircle2 className="size-5 text-emerald-500" />,
    error: <XCircle className="size-5 text-rose-500" />,
    info: <Info className="size-5 text-brand-500" />,
  }

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex max-w-sm items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg"
          >
            {icons[t.kind]}
            <p className="text-sm text-slate-700">{t.message}</p>
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
