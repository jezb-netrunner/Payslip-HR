// Pages load on first visit (their own chunk), so the first screen does not
// download every page, PDF and chart library. After a new deploy an open tab
// still asks for the old chunk files, which no longer exist: reload once to
// get the new version, then let the page boundary show the error.

import { lazy, type ComponentType } from 'react'

const RELOADED = 'phr:chunk-reload'

/** True the first time in this tab (and remembers it); false if it already reloaded or storage is unavailable. */
function firstFailure(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED)) return false
    sessionStorage.setItem(RELOADED, '1')
    return true
  } catch {
    return false
  }
}

export function lazyPage(load: () => Promise<{ default: ComponentType }>) {
  return lazy(async () => {
    try {
      const page = await load()
      try {
        sessionStorage.removeItem(RELOADED)
      } catch {
        // storage unavailable: nothing to clear
      }
      return page
    } catch (err) {
      if (firstFailure()) {
        window.location.reload()
        return new Promise<never>(() => {})
      }
      throw err
    }
  })
}
