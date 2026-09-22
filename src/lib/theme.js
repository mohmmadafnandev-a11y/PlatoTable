import { useCallback, useEffect, useState } from 'react'

// Theme preference, shared by the Super Admin panel and the restaurant admin.
//
// Following the operating system until someone explicitly picks is the
// behaviour people expect, and it means an app is already dark for someone who
// has chosen dark everywhere else. The storage key is passed in rather than
// fixed here so that choosing dark in one admin does not silently change the
// appearance of the other — they are separate products to the person using
// them, even though they ship in one bundle.

const prefersDark = () => {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  } catch {
    return false
  }
}

export function useTheme(storageKey) {
  const readStored = useCallback(() => {
    try {
      const value = window.localStorage.getItem(storageKey)
      return value === 'dark' || value === 'light' ? value : null
    } catch {
      return null
    }
  }, [storageKey])

  const [theme, setTheme] = useState(() => readStored() || (prefersDark() ? 'dark' : 'light'))

  useEffect(() => {
    // Once someone has chosen a side, stop tracking the system.
    if (readStored()) return undefined
    let media
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return undefined
    }
    const onChange = (event) => setTheme(event.matches ? 'dark' : 'light')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [readStored])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem(storageKey, next)
      } catch {
        // Private browsing: the choice simply does not persist.
      }
      return next
    })
  }, [storageKey])

  return { theme, toggle }
}
