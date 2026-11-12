/** Markdown export: plain text with **bold**, _italic_ and ~~strike~~ (fonts and colours dropped). */
import {
  chapterHeading,
  type Block,
  type ExportStyle,
  type Manuscript,
  type ManuscriptChapter,
  type Run,
} from './blocks'

/** Escapes characters Markdown would read as formatting. */
function escape(text: string): string {
  return text.replace(/([\\`*_[\]<>#|~])/g, '\\$1')
}

function runsMarkdown(runs: Run[]): string {
  return runs
    .map((r) => {
      if (r.lineBreak) return '  \n'
      // Keep spaces outside the markers, where Markdown needs them.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)!
      if (!core) return r.text
      let t = escape(core)
      if (r.strike) t = `~~${t}~~`
      if (r.italic) t = `_${t}_`
      if (r.bold) t = `**${t}**`
      // Underline has no Markdown; it's left plain.
      return `${lead}${t}${trail}`
    })
    .join('')
}

function blocksMarkdown(blocks: Block[], style: ExportStyle): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.push(runsMarkdown(b.runs))
    else if (b.kind === 'heading') out.push(`${'#'.repeat(b.level)} ${runsMarkdown(b.runs)}`)
    else if (b.kind === 'break') out.push(escape(style.sceneBreak))
    else if (b.kind === 'image') out.push(`_[Picture${b.alt ? `: ${escape(b.alt)}` : ''}]_`)
    else if (b.kind === 'quote')
      out.push(
        blocksMarkdown(b.blocks, style)
          .join('\n\n')
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n'),
      )
    else if (b.kind === 'list')
      out.push(
        b.items
          .map((item, i) => {
            const marker = b.ordered ? `${i + 1}.` : '-'
            const body = blocksMarkdown(item, style).join('\n\n')
            return `${marker} ${body.replace(/\n/g, '\n   ')}`
          })
          .join('\n'),
      )
  }
  return out
}

export function chapterMarkdown(chapter: ManuscriptChapter, style: ExportStyle): string {
  const body = blocksMarkdown(chapter.blocks, style)
  return [`# ${escape(chapterHeading(chapter, style))}`, ...body].join('\n\n') + '\n'
}

export function manuscriptMarkdown(m: Manuscript, style: ExportStyle): string {
  const head = [`# ${escape(m.title)}`]
  if (m.author.trim()) head.push(`_by ${escape(m.author.trim())}_`)
  return [
    head.join('\n\n'),
    ...m.chapters.map((c) => chapterMarkdown(c, style).replace(/^# /, '## ')),
  ].join('\n\n')
}
