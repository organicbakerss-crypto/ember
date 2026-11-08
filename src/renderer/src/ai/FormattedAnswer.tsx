import type { ReactNode } from 'react'
import type { Block, Inline } from './markdown'

function Inlines(props: { c: Inline[] }): ReactNode {
  return props.c.map((x, i) =>
    x.t === 'text' ? (
      x.s
    ) : x.t === 'code' ? (
      <code key={i}>{x.s}</code>
    ) : x.t === 'b' ? (
      <strong key={i}>
        <Inlines c={x.c} />
      </strong>
    ) : (
      <em key={i}>
        <Inlines c={x.c} />
      </em>
    ),
  )
}

export function Blocks(props: { blocks: Block[] }): ReactNode {
  return props.blocks.map((b, i) => {
    switch (b.t) {
      case 'p':
        return (
          <p key={i}>
            <Inlines c={b.c} />
          </p>
        )
      case 'h': {
        const H = (b.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4'
        return (
          <H key={i}>
            <Inlines c={b.c} />
          </H>
        )
      }
      case 'ul':
        return (
          <ul key={i}>
            {b.items.map((it, k) => (
              <li key={k}>
                <Inlines c={it} />
              </li>
            ))}
          </ul>
        )
      case 'ol':
        return (
          <ol key={i} start={b.start}>
            {b.items.map((it, k) => (
              <li key={k}>
                <Inlines c={it} />
              </li>
            ))}
          </ol>
        )
      case 'quote':
        return (
          <blockquote key={i}>
            <Blocks blocks={b.blocks} />
          </blockquote>
        )
      case 'pre':
        return <pre key={i}>{b.s}</pre>
      case 'hr':
        return <hr key={i} />
    }
  })
}
