import { useCallback, useState } from 'react'

// Sidebar width preference.
//
// Persisted because the rail is a working preference, not a transient state: an
// operator who collapses it to read wide tables does not want it springing back
// open on every click. Storage is read in the state initialiser rather than an
// effect so the first paint is already correct — restoring it afterwards would
// show the sidebar at full width and then snap it shut.
//
// A browser that blocks storage (private mode, hardened settings) must not break
// the panel, so every access is guarded.

const STORAGE_KEY = 'platotable-super-admin-sidebar'

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

export function useSidebar() {
  const [collapsed, setCollapsed] = useState(readStored)

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'collapsed' : 'expanded')
      } catch {
        // The preference simply will not survive a reload; the toggle still works.
      }
      return next
    })
  }, [])

  return { collapsed, toggle }
}
