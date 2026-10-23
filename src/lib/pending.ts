// The top bar's red counts of requests waiting on an admin. Pages that
// approve, reject or file requests announce it so the counts refresh at once
// instead of on the next navigation.

const EVENT = 'phr:pending-requests-changed'

export function notifyPendingChanged() {
  window.dispatchEvent(new Event(EVENT))
}

export function onPendingChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
