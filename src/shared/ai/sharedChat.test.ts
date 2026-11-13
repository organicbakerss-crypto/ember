import { describe, expect, it } from 'vitest'
import {
  SharedChatError,
  chatPieces,
  decodeTurboStream,
  pickChatPieces,
  shareIdOf,
  sharedChatFromHtml,
} from './sharedChat'
import { encodeTurboStream, sharePage, type TestMessage } from './sharedChatTestPage'

const ID = '6af6d288-3d88-83e8-bbb5-72a95ca016f6'

const chat: TestMessage[] = [
  { role: 'system', text: '', hidden: true },
  { role: 'user', text: 'Who is Mara?' },
  { role: 'assistant', type: 'thoughts', parts: [{ summary: 'thinking' }] },
  { role: 'assistant', text: 'print(1)', type: 'code', recipient: 'python' },
  { role: 'tool', text: 'output' },
  { role: 'assistant', text: 'hidden note', hidden: true },
  { role: 'assistant', text: 'Mara is the **harbour** pilot.\n\nShe is 19.' },
  {
    role: 'user',
    type: 'multimodal_text',
    parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'x' }, 'Here is her map'],
  },
  { role: 'assistant', text: 'Lovely map — "quotes", </script> and \\ survive.' },
]

describe('ChatGPT share links', () => {
  it('knows a share link (and nothing else)', () => {
    expect(shareIdOf(`https://chatgpt.com/share/${ID}`)).toBe(ID)
    expect(shareIdOf(` https://chat.openai.com/share/${ID.toUpperCase()}?x=1 `)).toBe(ID)
    expect(shareIdOf(`https://chatgpt.com/c/${ID}`)).toBeNull()
    expect(shareIdOf(`https://evil.example/share/${ID}`)).toBeNull()
    expect(shareIdOf(`http://chatgpt.com/share/${ID}`)).toBeNull()
  })

  it('decodes turbo-stream lists, shared references and special values', () => {
    const shared = { name: 'Mara' }
    const list = encodeTurboStream({ a: shared, b: shared, n: null, list: [1, 'two', true] })
    const out = decodeTurboStream(list) as Record<string, unknown>
    expect(out).toEqual({
      a: { name: 'Mara' },
      b: { name: 'Mara' },
      n: null,
      list: [1, 'two', true],
    })
    expect(out['a']).toBe(out['b'])
  })

  it('keeps what was said on screen, in order, and nothing hidden', () => {
    const c = sharedChatFromHtml(sharePage('Mara notes', chat, { splitAt: 200 }), ID)
    expect(c.title).toBe('Mara notes')
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Who is Mara?'],
      ['assistant', 'Mara is the **harbour** pilot.\n\nShe is 19.'],
      ['user', '[Picture]\n\nHere is her map'],
      ['assistant', 'Lovely map — "quotes", </script> and \\ survive.'],
    ])
    expect(c.messages[0]!.at).toBe(new Date((1_790_000_000 + 60) * 1000).toISOString())
  })

  it('follows the branch on screen when there is no linear list', () => {
    const c = sharedChatFromHtml(sharePage('M', chat, { mappingOnly: true }), ID)
    expect(c.messages).toHaveLength(4)
  })

  it('says plainly when the page has no chat', () => {
    expect(() => sharedChatFromHtml('<html>Not found</html>', ID)).toThrow(SharedChatError)
    expect(() =>
      sharedChatFromHtml(sharePage('Empty', [{ role: 'system', text: '', hidden: true }]), ID),
    ).toThrow(/no messages/)
    const broken = `<script>x.streamController.enqueue("[{\\"_1\\":2}");</script>`
    expect(() => sharedChatFromHtml(broken, ID)).toThrow(SharedChatError)
  })

  it('cuts a long chat into question-and-reply pieces and finds the ones that matter', () => {
    const long = 'word '.repeat(900).trim()
    const pieces = chatPieces({
      title: 'Plans',
      messages: [
        { role: 'user', content: 'Tell me about the curse', at: '2026-10-01T10:00:00Z' },
        {
          role: 'assistant',
          content: 'The curse began with the flood.',
          at: '2026-10-01T10:01:00Z',
        },
        { role: 'user', content: 'And the lighthouse?', at: '2026-10-02T10:00:00Z' },
        { role: 'assistant', content: `${long}\n\n${long}`, at: '2026-10-02T10:01:00Z' },
      ],
    })
    expect(pieces[0]!.text).toBe(
      'Writer: Tell me about the curse\n\nChatGPT: The curse began with the flood.',
    )
    expect(pieces[0]!.where).toBe('“Plans”, 1 Oct 2026')
    expect(pieces.length).toBe(3) // the long reply is split
    const picked = pickChatPieces(pieces, ['curse', 'flood'], 2, 50)
    expect(picked).toHaveLength(1)
    expect(picked[0]!.text.length).toBeLessThanOrEqual(50)
    expect(pickChatPieces(pieces, [], 5, 100)).toEqual([])
  })
})
