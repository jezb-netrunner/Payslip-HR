import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Opens a page's create form when the top bar's quick-add menu linked here
 * with `?new=<key>`, then drops the parameter so a reload doesn't reopen it.
 * `ready` holds it back until the form can open (e.g. the client is loaded).
 */
export function useQuickAction(key: string, open: () => void, ready = true) {
  const [params, setParams] = useSearchParams()
  const wanted = params.get('new') === key
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })
  useEffect(() => {
    if (!wanted || !ready) return
    openRef.current()
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('new')
        return next
      },
      { replace: true },
    )
  }, [wanted, ready, setParams])
}
