/**
 * Never lose words across windows: a chapter (or an entry's page) is edited
 * in one place at a time. Other places show it read-only and kept live. To
 * edit there instead, a place asks to take it over: the place editing it is
 * told to save everything and stop, and only then does the new place start.
 */

/** A window's renderer, as far as leases need it. */
export interface LeaseSender {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

interface Holder {
  sender: LeaseSender
  pane: string
}

/** How long a place has to save before editing moves anyway (a stuck window can't block it). */
const YIELD_TIMEOUT_MS = 4000

export class DocLeases {
  private readonly holders = new Map<string, Holder>()
  private readonly waiting = new Map<string, () => void>()

  constructor(
    /** The event channel that asks a place to save and stop editing. */
    private readonly yieldChannel: string,
    private readonly timeoutMs = YIELD_TIMEOUT_MS,
  ) {}

  /** Who edits a document now, if anyone. */
  holder(key: string): Holder | undefined {
    const h = this.holders.get(key)
    if (h && h.sender.isDestroyed()) {
      this.holders.delete(key)
      return undefined
    }
    return h
  }

  /**
   * Asks to edit a document. Free, or already this place's: granted. Held
   * elsewhere: refused, unless `take`, which waits for the holder to save.
   */
  async claim(
    key: string,
    sender: LeaseSender,
    pane: string,
    take: boolean,
  ): Promise<{ editing: boolean }> {
    const current = this.holder(key)
    if (!current || (current.sender === sender && current.pane === pane)) {
      this.holders.set(key, { sender, pane })
      return { editing: true }
    }
    if (!take) return { editing: false }
    await new Promise<void>((resolve) => {
      this.waiting.set(key, resolve)
      current.sender.send(this.yieldChannel, { key, pane: current.pane })
      setTimeout(resolve, this.timeoutMs)
    })
    this.waiting.delete(key)
    this.holders.set(key, { sender, pane })
    return { editing: true }
  }

  /** The holder saved and stopped (in reply to a take-over). */
  yielded(key: string, sender: LeaseSender, pane: string): void {
    const h = this.holders.get(key)
    if (h && h.sender === sender && h.pane === pane) this.holders.delete(key)
    this.waiting.get(key)?.()
  }

  /** A place closed the document. */
  release(key: string, sender: LeaseSender, pane: string): void {
    const h = this.holders.get(key)
    if (h && h.sender === sender && h.pane === pane) this.holders.delete(key)
  }

  /** A window closed: everything it was editing is free. */
  releaseAll(sender: LeaseSender): void {
    for (const [key, h] of this.holders) if (h.sender === sender) this.holders.delete(key)
  }
}
