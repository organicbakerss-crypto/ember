/**
 * Reading a ChatGPT conversation from its share link (chatgpt.com/share/…).
 *
 * The share page carries the whole conversation in the page itself, in React
 * Router's "turbo-stream" form: a flat JSON list where objects point at other
 * entries by index. We decode that list and keep only what the writer and
 * ChatGPT actually said on screen (no hidden thinking, tool calls or code
 * runs). Nothing here is documented by OpenAI, so every step fails with a
 * plain message rather than guessing.
 */

export interface SharedChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO time it was written (the chat's own time when the message has none). */
  at: string
}

export interface SharedChat {
  shareId: string
  title: string
  createdAt: string
  updatedAt: string
  messages: SharedChatMessage[]
}

export class SharedChatError extends Error {}

const SHARE_URL =
  /^https:\/\/(?:www\.)?(?:chatgpt\.com|chat\.openai\.com)\/share\/(?:e\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:[?#].*)?$/i

/** The share id in a ChatGPT share link, or null when it isn't one. */
export function shareIdOf(url: string): string | null {
  return SHARE_URL.exec(url.trim())?.[1]?.toLowerCase() ?? null
}

/** The page address to read for a share id. */
export const shareUrl = (shareId: string) => `https://chatgpt.com/share/${shareId}`

/** The text handed to `streamController.enqueue("…")` in the page, joined. */
export function enqueuedText(html: string): string {
  const marker = 'streamController.enqueue('
  let out = ''
  let from = 0
  for (;;) {
    const at = html.indexOf(marker, from)
    if (at < 0) break
    let i = at + marker.length
    while (html[i] === ' ') i++
    if (html[i] !== '"') {
      from = i
      continue
    }
    // A JSON string literal: find its closing quote, skipping escapes.
    let j = i + 1
    while (j < html.length && html[j] !== '"') j += html[j] === '\\' ? 2 : 1
    try {
      out += JSON.parse(html.slice(i, j + 1)) as string
    } catch {
      throw new SharedChatError('The shared chat page couldn’t be read (its data was cut short).')
    }
    from = j + 1
  }
  return out
}

/** Special numbers turbo-stream uses in place of an index. */
const SPECIAL: Record<number, unknown> = {
  [-1]: undefined, // a hole
  [-2]: Number.NaN,
  [-3]: Number.NEGATIVE_INFINITY,
  [-4]: -0,
  [-5]: null,
  [-6]: Number.POSITIVE_INFINITY,
  [-7]: undefined,
}

/** Decodes a turbo-stream list (its first line) into plain values. */
export function decodeTurboStream(list: unknown[]): unknown {
  const done = new Map<number, unknown>()
  const value = (i: unknown): unknown => {
    if (typeof i !== 'number') return undefined
    if (i < 0) return SPECIAL[i]
    if (done.has(i)) return done.get(i)
    const raw = list[i]
    if (Array.isArray(raw)) {
      // A tagged value (["D", …] a date, ["P", …] a promise…): not used by a chat.
      if (typeof raw[0] === 'string') {
        done.set(i, undefined)
        return undefined
      }
      const out: unknown[] = []
      done.set(i, out)
      for (const x of raw) out.push(value(x))
      return out
    }
    if (raw && typeof raw === 'object') {
      const out: Record<string, unknown> = {}
      done.set(i, out)
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = list[Number(k.slice(1))]
        if (typeof key === 'string') out[key] = value(v)
      }
      return out
    }
    done.set(i, raw)
    return raw
  }
  // Deep chats nest deeply: decode without recursion limits mattering for the list.
  return value(0)
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)

/** Finds the share route's conversation data wherever it sits in the decoded page. */
function findConversation(root: unknown): Obj | null {
  const seen = new Set<unknown>()
  const stack: unknown[] = [root]
  while (stack.length) {
    const x = stack.pop()
    if (!x || typeof x !== 'object' || seen.has(x)) continue
    seen.add(x)
    if (isObj(x) && (Array.isArray(x['linear_conversation']) || isObj(x['mapping']))) return x
    stack.push(...(Array.isArray(x) ? x : Object.values(x)))
  }
  return null
}

const iso = (seconds: unknown, fallback: string) =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : fallback

/** The messages in order: the linear list, else the branch that ends at the current node. */
function orderedMessages(data: Obj): Obj[] {
  if (Array.isArray(data['linear_conversation'])) {
    return data['linear_conversation']
      .map((n) => (isObj(n) && isObj(n['message']) ? n['message'] : null))
      .filter((m): m is Obj => !!m)
  }
  const mapping = data['mapping'] as Obj
  const out: Obj[] = []
  let id = data['current_node']
  const seen = new Set<unknown>()
  while (typeof id === 'string' && isObj(mapping[id]) && !seen.has(id)) {
    seen.add(id)
    const node = mapping[id] as Obj
    if (isObj(node['message'])) out.push(node['message'])
    id = node['parent']
  }
  return out.reverse()
}

/** What a message shows on screen, or null when it isn't shown (thinking, tools, system). */
function shownText(m: Obj): { role: 'user' | 'assistant'; text: string } | null {
  const author = isObj(m['author']) ? m['author'] : {}
  const role = author['role']
  if (role !== 'user' && role !== 'assistant') return null
  const meta = isObj(m['metadata']) ? m['metadata'] : {}
  if (meta['is_visually_hidden_from_conversation']) return null
  if (m['recipient'] !== undefined && m['recipient'] !== 'all') return null
  const content = isObj(m['content']) ? m['content'] : {}
  const type = content['content_type']
  if (type !== 'text' && type !== 'multimodal_text') return null
  const parts = Array.isArray(content['parts']) ? content['parts'] : []
  const text = parts
    .map((p) =>
      typeof p === 'string'
        ? p
        : isObj(p) && String(p['content_type'] ?? '').includes('image')
          ? '[Picture]'
          : isObj(p) && typeof p['text'] === 'string'
            ? p['text']
            : '',
    )
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return text ? { role, text } : null
}

/** Reads a share page's HTML into the conversation as it shows on screen. */
export function sharedChatFromHtml(html: string, shareId: string): SharedChat {
  const stream = enqueuedText(html)
  if (!stream) {
    throw new SharedChatError(
      'That page has no conversation in it. The link may have been deleted, or ChatGPT changed how shared chats work.',
    )
  }
  let list: unknown
  try {
    list = JSON.parse(stream.split('\n')[0]!)
  } catch {
    throw new SharedChatError('The shared chat page couldn’t be read (its data wasn’t valid).')
  }
  if (!Array.isArray(list)) throw new SharedChatError('The shared chat page couldn’t be read.')
  const data = findConversation(decodeTurboStream(list))
  if (!data) {
    throw new SharedChatError(
      'No conversation was found on that page. ChatGPT may have changed how shared chats work.',
    )
  }
  const now = new Date().toISOString()
  const createdAt = iso(data['create_time'], now)
  const messages: SharedChatMessage[] = []
  let last = createdAt
  for (const m of orderedMessages(data)) {
    const shown = shownText(m)
    if (!shown) continue
    last = iso(m['create_time'], last)
    messages.push({ ...shown, at: last })
  }
  if (!messages.length) throw new SharedChatError('That shared chat has no messages to bring in.')
  const title = typeof data['title'] === 'string' && data['title'].trim() ? data['title'] : 'Chat'
  return {
    shareId,
    title: title.trim().slice(0, 180),
    createdAt,
    updatedAt: iso(data['update_time'], last),
    messages,
  }
}

/* ---------- finding the parts of imported chats that matter ---------- */

export interface ChatPiece {
  /** "“Plan writing app development”, 12 Mar 2026" */
  where: string
  text: string
}

const WORDS_PER_PIECE = 700

/**
 * A chat cut into pieces for looking things up: each question with the reply
 * it got, long messages split at paragraphs.
 */
export function chatPieces(
  chat: { title: string; messages: { role: string; content: string; at: string }[] },
  words = WORDS_PER_PIECE,
): ChatPiece[] {
  const out: ChatPiece[] = []
  const label = (at: string) =>
    `“${chat.title}”, ${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  let current: string[] = []
  let count = 0
  let at = ''
  const push = () => {
    if (current.length) out.push({ where: label(at), text: current.join('\n\n') })
    current = []
    count = 0
  }
  for (const m of chat.messages) {
    // A new question starts a new piece.
    if (m.role === 'user') push()
    if (!current.length) at = m.at
    const who = m.role === 'user' ? 'Writer' : 'ChatGPT'
    const paragraphs = m.content.split(/\n{2,}/).filter((p) => p.trim())
    paragraphs.forEach((p, i) => {
      const n = p.split(/\s+/).filter(Boolean).length
      // A short question stays with the start of its reply, however long that is.
      if (count + n > words && count >= words / 4) {
        push()
        at = m.at
      }
      current.push(i === 0 || !current.length ? `${who}: ${p}` : p)
      count += n
    })
  }
  push()
  return out
}

const score = (text: string, terms: string[]) => {
  const t = text.toLowerCase()
  let n = 0
  for (const term of terms) {
    let at = t.indexOf(term)
    let hits = 0
    while (at >= 0 && hits < 5) {
      hits++
      at = t.indexOf(term, at + term.length)
    }
    // Each different term counts more than the same term again.
    if (hits) n += (term.includes(' ') ? 3 : 1) * (1 + Math.log2(hits))
  }
  return n
}

/** The pieces that touch the question most (best first, at most `max`, clipped). */
export function pickChatPieces(
  pieces: ChatPiece[],
  terms: string[],
  max: number,
  maxChars: number,
): ChatPiece[] {
  if (!terms.length) return []
  return pieces
    .map((p, i) => ({ p, i, s: score(p.text, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(({ p }) => ({
      where: p.where,
      text: p.text.length > maxChars ? `${p.text.slice(0, maxChars - 1)}…` : p.text,
    }))
}
