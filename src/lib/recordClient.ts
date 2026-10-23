import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEntity } from './entity'

/**
 * A record page (an employee, a pay run) belongs to one client. Opening it
 * selects that client in the top bar, so the switcher, the pending counts and
 * links such as "Edit time in / out" match the page; switching to another
 * client afterwards leaves the record for that client's list.
 */
export function useRecordClient(recordEntityId: string | undefined, listPath: string) {
  const { entity, entities, setEntityId } = useEntity()
  const navigate = useNavigate()
  const synced = useRef(false)
  const selectedId = entity?.id
  useEffect(() => {
    if (!recordEntityId || !selectedId) return
    if (selectedId === recordEntityId) {
      synced.current = true
      return
    }
    if (synced.current) navigate(listPath)
    else if (entities.some((e) => e.id === recordEntityId)) setEntityId(recordEntityId)
  }, [recordEntityId, selectedId, entities, listPath, navigate, setEntityId])
}
