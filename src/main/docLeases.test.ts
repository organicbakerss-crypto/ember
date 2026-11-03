import { describe, expect, it } from 'vitest'
import { DocLeases, type LeaseSender } from './docLeases'

function window() {
  const sent: { channel: string; payload: unknown }[] = []
  const sender: LeaseSender & { destroyed: boolean } = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    send: (channel, payload) => sent.push({ channel, payload }),
  }
  return { sender, sent }
}

describe('document leases', () => {
  it('lets one place edit; another is refused unless it takes over', async () => {
    const leases = new DocLeases('yield', 1000)
    const a = window()
    const b = window()
    expect(await leases.claim('chapter:chp_1111', a.sender, 'p1', false)).toEqual({ editing: true })
    // The same place asking again keeps it.
    expect(await leases.claim('chapter:chp_1111', a.sender, 'p1', false)).toEqual({ editing: true })
    expect(await leases.claim('chapter:chp_1111', b.sender, 'p2', false)).toEqual({
      editing: false,
    })
    // Another chapter is free.
    expect(await leases.claim('chapter:chp_2222', b.sender, 'p2', false)).toEqual({ editing: true })
  })

  it('takes over only after the holder has saved and stopped', async () => {
    const leases = new DocLeases('yield', 5000)
    const a = window()
    const b = window()
    await leases.claim('entry:ent_1111', a.sender, 'p1', false)
    let done = false
    const taking = leases.claim('entry:ent_1111', b.sender, 'p2', true).then((r) => {
      done = true
      return r
    })
    await Promise.resolve()
    expect(a.sent).toEqual([{ channel: 'yield', payload: { key: 'entry:ent_1111', pane: 'p1' } }])
    expect(done).toBe(false)
    leases.yielded('entry:ent_1111', a.sender, 'p1')
    expect(await taking).toEqual({ editing: true })
    expect(leases.holder('entry:ent_1111')?.pane).toBe('p2')
    // The old place now gets read-only.
    expect(await leases.claim('entry:ent_1111', a.sender, 'p1', false)).toEqual({ editing: false })
  })

  it('moves editing anyway if the holder never answers', async () => {
    const leases = new DocLeases('yield', 20)
    const a = window()
    const b = window()
    await leases.claim('chapter:chp_1111', a.sender, 'p1', false)
    expect(await leases.claim('chapter:chp_1111', b.sender, 'p2', true)).toEqual({ editing: true })
  })

  it('frees documents when a place releases them or its window closes', async () => {
    const leases = new DocLeases('yield', 1000)
    const a = window()
    const b = window()
    await leases.claim('chapter:chp_1111', a.sender, 'p1', false)
    await leases.claim('chapter:chp_2222', a.sender, 'p1', false)
    leases.release('chapter:chp_1111', a.sender, 'p1')
    expect(await leases.claim('chapter:chp_1111', b.sender, 'p2', false)).toEqual({ editing: true })
    // Someone else's release does nothing.
    leases.release('chapter:chp_2222', b.sender, 'p2')
    expect(leases.holder('chapter:chp_2222')?.pane).toBe('p1')
    a.sender.destroyed = true
    expect(await leases.claim('chapter:chp_2222', b.sender, 'p2', false)).toEqual({ editing: true })
    leases.releaseAll(b.sender)
    expect(leases.holder('chapter:chp_1111')).toBeUndefined()
  })

  it('sync borrows a document: the editor saves, stops, and gets it back', async () => {
    const leases = new DocLeases('yield', 5000, 'returned')
    const a = window()
    await leases.claim('chapter:chp_1111', a.sender, 'p1', false)
    let lent = false
    const borrowing = leases.borrow(['chapter:chp_1111', 'chapter:chp_2222']).then((r) => {
      lent = true
      return r
    })
    await Promise.resolve()
    expect(a.sent).toEqual([{ channel: 'yield', payload: { key: 'chapter:chp_1111', pane: 'p1' } }])
    expect(lent).toBe(false)
    leases.yielded('chapter:chp_1111', a.sender, 'p1')
    const giveBack = await borrowing
    // Meanwhile nobody else can edit it.
    const b = window()
    expect(await leases.claim('chapter:chp_1111', b.sender, 'p2', false)).toEqual({
      editing: false,
    })
    expect(await leases.claim('chapter:chp_2222', b.sender, 'p2', false)).toEqual({
      editing: false,
    })
    giveBack()
    expect(a.sent[1]).toEqual({
      channel: 'returned',
      payload: { key: 'chapter:chp_1111', pane: 'p1' },
    })
    expect(await leases.claim('chapter:chp_1111', a.sender, 'p1', false)).toEqual({ editing: true })
    expect(await leases.claim('chapter:chp_2222', b.sender, 'p2', false)).toEqual({ editing: true })
  })
})
