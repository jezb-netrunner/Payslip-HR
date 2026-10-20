// The client (entity) an admin is currently working in. Company admins can
// switch between every client (archived ones included); entity admins between
// their assigned, active ones. The choice is remembered per browser.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import type { Entity } from './db'

interface EntityState {
  entities: Entity[]
  /** Currently selected client, or null when none exist / are assigned. */
  entity: Entity | null
  loading: boolean
  setEntityId: (id: string) => void
  reload: () => Promise<void>
}

const EntityContext = createContext<EntityState>({
  entities: [],
  entity: null,
  loading: true,
  setEntityId: () => {},
  reload: async () => {},
})

const STORAGE_KEY = 'phr_entity'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function EntityProvider({ children }: { children: ReactNode }) {
  const [entities, setEntities] = useState<Entity[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(readStored)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const { data } = await supabase.from('entities').select('*').order('name')
    setEntities((data ?? []) as Entity[])
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const setEntityId = useCallback((id: string) => {
    setSelectedId(id)
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // per-browser convenience only
    }
  }, [])

  // archived clients lock their entity admins out; company admins can still
  // open them (e.g. for the year's BIR reports) by picking them explicitly
  const { isCompanyAdmin } = useAuth()
  const entity =
    entities.find((e) => e.id === selectedId && (e.is_active || isCompanyAdmin)) ??
    entities.find((e) => e.is_active) ??
    null

  return (
    <EntityContext.Provider value={{ entities, entity, loading, setEntityId, reload }}>
      {children}
    </EntityContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useEntity() {
  return useContext(EntityContext)
}
