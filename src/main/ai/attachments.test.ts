import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Attachments } from './attachments'

let dir: string
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'att-'))
})
afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true })
})

const conv = 'cnv_0123456789abcdef'
const enc = (s: string) => new TextEncoder().encode(s)

describe('attachments', () => {
  it('keeps a file as text on this computer and reads it back', async () => {
    const a = new Attachments(() => dir)
    const info = await a.add(conv, 'handoff.md', enc('# Plan\nMara leaves.'))
    expect(info.words).toBe(4)
    expect(await a.texts(conv, [info.id, 'att_missing0000000'])).toEqual([
      { name: 'handoff.md', text: '# Plan\nMara leaves.' },
    ])
    expect(await a.here(conv, [info.id, 'att_zzzzzzzzzzzzzzzz'])).toEqual([info.id])
  })
  it('says which files it can’t read', async () => {
    const a = new Attachments(() => dir)
    await expect(a.add(conv, 'notes.pdf', enc('%PDF'))).rejects.toThrow(/can’t be read/)
    await expect(a.add(conv, 'empty.txt', enc('   '))).rejects.toThrow(/no text/)
    await expect(a.add('../x', 'a.txt', enc('hi'))).rejects.toThrow()
  })
})
