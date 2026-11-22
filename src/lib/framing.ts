// Whether the app is running inside another page's frame.

/** A cross-origin parent makes reading `top` throw: that counts as framed. */
export function isFramed(win: { self: unknown; top: unknown } = window): boolean {
  try {
    return win.top !== win.self
  } catch {
    return true
  }
}
