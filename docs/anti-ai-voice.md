# Ember shared anti-AI conversational style — v1

This is a **prompt-conditioning layer and developer diagnostic**, not an authorship detector, a rewriting engine, a fine-tuned model, or evidence that a fictional guest portrayal is an exact reproduction of a real person.

## Where it applies

- **All regular and guest-star chat characters**, in Chat, Brainstorm and Ask the story: `src/main/ai/prompts.ts` includes the shared catalog alongside the chosen character's own identity.
- **Roundtable guests, regular characters and specialists:** `src/main/ai/service.ts` applies the same catalog for conversational phases.
- **Sealed final proposals and ranked ballots:** use a short structured-output directive instead of the prose catalog. Existing JSON contracts, voting and anonymity behavior remain intact.
- Not injected into literal manuscript editing, reading aloud, search results, the Figurehead's evidence gathering, or other machine-oriented operations. It does **not** rewrite the user's novel or editing requests.

## Architecture

`src/shared/ai/antiAiStyle.ts` defines a versioned, inspectable catalog with one unique ID, category and original instruction per entry. Categories:

1. Starts and conversational setup.
2. Reasoning, concession, categorization and false balance.
3. Rhetorical formulas, manufactured jokes and invented anecdotes.
4. Formulaic endings, morals and unrequested reassurance.
5. Sentence rhythm, layouts, headings, fillers and punctuation tics.
6. Factual fidelity, grounding and preserving the character's evidenced voice.

There are 52 entries in v1. **Every entry goes into the active chat and Roundtable conversational guidance**; it is not limited to the five patterns in the Rifujin test. New patterns are added to the catalog and picked up automatically. `antiAiStyleGuidance(context, catalog)` can accept an alternate catalog for tests or future extensions.

The catalog's guidance is deliberately non-absolute. A documented character's own cadence, accurate reasoning, the writer's instructions and required structured formats take priority. This avoids the common failure of replacing one generic voice with another generic voice (“everyone becomes blunt, terse and humorless”).

## Diagnostic mode

`inspectAiStyle(text, detectors)` is a **non-invasive development tool**: it reports snippets matching a small, explicit subset of high-confidence phrase patterns. It does not delete or rewrite output, call a second AI model, claim the response is AI-written, or infer speaker identity. This is intentionally narrower than the full prompt catalog because broad rhetorical structures cannot reliably be classified by regex alone. More detectors may be added when real test cases justify them.

## Provenance / influences

Original Ember text adapted in spirit from the publicly documented concerns of:
- https://github.com/petergyang/no-ai-slop — formulaic binary contrasts, throat-clearing, fake-insight setups, inflated significance and fabricated depth.
- https://github.com/hardikpandya/stop-slop — repetitive stock phrasing, structural templates and style-review workflow.
- https://github.com/MariusAure/anti-slop-writing — use judgment rather than banning language indiscriminately; preserve individual voice.
- https://github.com/avectats7/anti-ai-writing — distinguish word/phrase tells from discourse shape and leave legitimate technical terms alone.
- https://github.com/ccf/humanize — varied structural tells, avoiding repetitive rhetorical templates.

**No external prompt text is copied wholesale.** This is an original, chat-specific catalog based on the pattern families rather than installing another package or calling an external service.

## Next evaluation

Run A/B comparisons against the same model with identical prompts and settings. The initial three Rifujin dialogue examples include:

- “I think a game can be enjoyable for hundreds of hours without being the best game. What do you think?”
- “I don't think familiarity is the same thing as enjoyment.”
- “Why does playing a game need to be productive?”

Record: unnecessary validation, forced distinctions, funny-sounding tics, invented experience, conclusion shape, response usefulness and whether the response actually resembles sourced conversational evidence. Compare ordinary conversation **and** Roundtable disagreement. The engineering regression tests check inclusion, structure and isolation; they **cannot** prove the model stops generating AI tells. Observe and refine rather than claiming success from passing CI.

Future catalog additions should be grounded in repeated observed failures or clear examples. Do not broaden any category just to make a longer prohibited-word list.
