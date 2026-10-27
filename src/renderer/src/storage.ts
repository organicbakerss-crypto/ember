/** Small per-window conveniences (last open chapter, panel state). Never required. */
export function loadLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function saveLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable; the choice just isn't remembered.
  }
}
