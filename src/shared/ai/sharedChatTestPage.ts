/**
 * For tests: a ChatGPT share page in the same form as the real one (the data
 * in React Router's turbo-stream encoding, handed to streamController.enqueue).
 */

/** Encodes a value as a turbo-stream list (objects as {"_<key index>": <value index>}). */
export function encodeTurboStream(value: unknown): unknown[] {
  const list: unknown[] = []
  const strings = new Map<string, number>()
  const objects = new Map<object, number>()
  const put = (v: unknown): number => {
    if (v === null) return -5
    if (v === undefined) return -7
    if (typeof v === 'string') {
      const known = strings.get(v)
      if (known !== undefined) return known
      list.push(v)
      strings.set(v, list.length - 1)
      return list.length - 1
    }
    if (typeof v !== 'object') {
      list.push(v)
      return list.length - 1
    }
    const seen = objects.get(v)
    if (seen !== undefined) return seen
    const at = list.length
    objects.set(v, at)
    list.push(null)
    if (Array.isArray(v)) list[at] = v.map(put)
    else {
      const o: Record<string, number> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[`_${put(k)}`] = put(x)
      list[at] = o
    }
    return at
  }
  put(value)
  return list
}

export interface TestMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  text?: string
  parts?: unknown[]
  type?: string
  recipient?: string
  hidden?: boolean
  time?: number
}

/** A share page holding these messages (as `linear_conversation`, or only `mapping`). */
export function sharePage(
  title: string,
  messages: TestMessage[],
  options: { mappingOnly?: boolean; splitAt?: number } = {},
): string {
  const nodes = messages.map((m, i) => ({
    id: `m${i}`,
    parent: i ? `m${i - 1}` : 'root',
    message: {
      id: `m${i}`,
      author: { role: m.role, metadata: {} },
      create_time: m.time ?? 1_790_000_000 + i * 60,
      content: { content_type: m.type ?? 'text', parts: m.parts ?? [m.text ?? ''] },
      metadata: m.hidden ? { is_visually_hidden_from_conversation: true } : {},
      recipient: m.recipient ?? 'all',
    },
  }))
  const data: Record<string, unknown> = {
    title,
    create_time: 1_790_000_000,
    update_time: 1_790_000_000 + messages.length * 60,
    mapping: Object.fromEntries([
      ['root', { id: 'root', children: ['m0'] }],
      ...nodes.map((n) => [n.id, n]),
    ]),
    current_node: `m${messages.length - 1}`,
  }
  if (!options.mappingOnly) data['linear_conversation'] = [{ id: 'root' }, ...nodes]
  const root = {
    loaderData: {
      root: { theme: 'light' },
      'routes/share.$shareId.($action)': { serverResponse: { type: 'data', data } },
    },
    actionData: null,
  }
  const line = `${JSON.stringify(encodeTurboStream(root))}\nP99:[{}]\n`
  const cut = options.splitAt ?? line.length
  const script = (s: string) =>
    `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(s)});</script>`
  return `<!DOCTYPE html><html><head><title>ChatGPT - ${title}</title></head><body>${script(line.slice(0, cut))}${cut < line.length ? script(line.slice(cut)) : ''}</body></html>`
}
