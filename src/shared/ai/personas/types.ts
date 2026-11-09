/**
 * The AI's characters. Regular characters all give the same complete
 * feedback; only their personality (taste, opinions, bias, voice) differs.
 * Guest stars are AI portrayals of real creators: they look through their
 * own lens, deep on what they're known for and lighter on the rest.
 */

export interface PersonaBase {
  id: string
  name: string
  /**
   * Can learn as you talk, while Settings → AI → Adaptive characters is on.
   * 'writer': learns the writer's creative views from their own messages.
   */
  adaptive?: 'writer'
  /** How they talk, in a sentence or two (delivery only). */
  voice: string
  /** A few lines showing the voice (made up here, never real quotations). */
  sounds: readonly string[]
}

/** A regular brainstorming partner: no backstory, just how they think about stories. */
export interface RegularPersona extends PersonaBase {
  kind: 'regular'
  /** No personality at all: a plain assistant (for when you don't want a character). */
  plain?: boolean
  /** One line for the picker. */
  summary: string
  loves: readonly string[]
  cantStand: readonly string[]
  /** Craft opinions they'll argue for. */
  believes: readonly string[]
  /** What they over-focus on (said openly so the writer can weigh it). */
  bias: string
  /** How they shape an answer: their opening move, length, order. */
  approach: string
  /** A whole answer to "Does this scene work?" about another story, in their voice. */
  example: string
}

/** An AI portrayal of a real creator, built from their public craft. */
export interface GuestPersona extends PersonaBase {
  kind: 'guest'
  /** Their best-known work, for the picker. */
  knownFor: string
  /** Where they go deep. */
  strongAt: readonly string[]
  /** What they only touch on. */
  lighterOn: readonly string[]
  /** The questions they always bring to a story. */
  lens: readonly string[]
  /** What they've said matters in writing (from their own books, talks and interviews). */
  stated?: readonly string[]
  /** A few short things they really said, for cadence and priorities (not to recite). */
  quotes?: readonly { text: string; source: string }[]
  /** How they come across when they talk, from interviews. */
  cadence?: string
  /** True stories from their public record they can bring up when they fit (never invented ones). */
  stories?: readonly string[]
  /** A whole answer to "Does this scene work?" about another story, in their voice. */
  example?: string
  /** Where all this comes from, so it can be checked. */
  sources?: readonly string[]
}

export type Persona = RegularPersona | GuestPersona
