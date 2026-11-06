// A page that fails to render (or to load its chunk) shows this inside the
// shell instead of blanking the whole app; moving to another page resets it.

import { Component, type ReactNode } from 'react'

type Props = { resetKey: string; children: ReactNode }
type State = { error: Error | null; key: string }

export default class PageBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error) {
    console.error('Page failed', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-bold text-ink-900">This page couldn't be shown</h1>
        <p className="mt-2 text-sm text-slate-500">
          Check your connection and reload. If the app was just updated, reloading gets the new version.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-5 text-sm font-semibold text-brand-600 hover:text-brand-800"
        >
          Reload
        </button>
      </div>
    )
  }
}
