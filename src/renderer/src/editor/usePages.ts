import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { PAPER_SIZES } from '@shared/settings'
import { useSettings } from '../useTheme'

/** Space between sheets in the page view. */
export const PAGE_GAP = 28

/**
 * Sheets of a fixed paper shape for an editor with the Pagination extension:
 * the page height follows the width of `stackRef`'s element, and `pages` is
 * how many sheets the text needs.
 */
export function usePages(editor: Editor, paged: boolean) {
  const { settings } = useSettings()
  const ratio = PAPER_SIZES[settings.paperSize].ratio
  const stackRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState({ width: 0, marginBlock: 0 })
  const [pages, setPages] = useState(1)
  useEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    const measure = () => {
      const content = stack.querySelector('.page-content')
      const marginBlock = content ? parseFloat(getComputedStyle(content).paddingTop) : 0
      setGeometry((g) =>
        g.width === stack.clientWidth && g.marginBlock === marginBlock
          ? g
          : { width: stack.clientWidth, marginBlock },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stack)
    return () => observer.disconnect()
  }, [])
  const pageHeight = Math.round(geometry.width * ratio)
  useEffect(() => {
    editor.commands.onPages(setPages)
    return () => {
      if (!editor.isDestroyed) editor.commands.onPages(null)
    }
  }, [editor])
  useEffect(() => {
    editor.commands.setPageLayout({
      enabled: paged && pageHeight > 0,
      contentHeight: pageHeight - 2 * geometry.marginBlock,
      pitch: pageHeight + PAGE_GAP,
    })
  }, [editor, paged, pageHeight, geometry.marginBlock])
  return { stackRef, pageHeight, pages }
}
