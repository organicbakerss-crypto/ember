# Ember — build plan

Oct 27, 2026

## Overview and ground rules

Ember is a personal desktop app for writing novels and building the worlds they live in. It is built for one person, on Arch Linux (KDE Plasma) and macOS, and is never meant to be sold or published as is.

These rules apply to every milestone. Claude Code should treat them as hard constraints.

1. **The core stays basic.** The previous attempt failed because it got bloated and cluttered. Everything beyond the core (see Optional modules) is a module that is off until switched on. The core must feel finished before any module is built.
2. **Never lose words.** Local files are the source of truth. No sync, AI or import step may ever overwrite text the user wrote without them seeing it first.
3. **Light branding.** The name "Ember" lives in one config file (`app.config.ts`: name, app ID, data folder name, URL scheme). Every other place reads it from there. No logo baked into layouts, no "Ember" in component names, CSS classes, file formats or storage keys. Renaming the app should mean editing one file plus the icon.
4. **Plain, portable data.** Projects are ordinary files in folders, readable without the app.
5. **No required API keys.** Everything works with no keys at all. ChatGPT sign-in and ElevenLabs are optional extras.
6. **Leave the door open for other platforms.** Arch and Mac first; avoid choices that would block Windows, web or mobile later.

## Tech stack

One Electron app written in React and TypeScript. These are defaults; Claude Code can propose a swap if one blocks progress, but should ask first.

| Area | Choice | Why |
| --- | --- | --- |
| App shell | Electron + electron-vite | Native file access, multiple windows, runs on Arch and Mac |
| UI | React + TypeScript | Largest ecosystem for editor, drag-and-drop and companion rendering |
| Editor | TipTap (ProseMirror) | Rich text stored as structured JSON, not raw HTML |
| Binder drag-and-drop | dnd-kit | Reorder chapters and arcs |
| Local index and outbox | SQLite (better-sqlite3) | Sync queue, search index, file versions |
| Spellcheck | Electron's built-in spellchecker + personal dictionary | Google Docs style flags |
| Cloud sync | Cloudflare Worker + R2 (files) + D1 (version table) | Free tier is enough for one person |
| Local AI | Ollama | Free, offline, already installed |
| Cloud AI (optional) | Sign in with ChatGPT | Uses the ChatGPT Plus plan, no API key |
| Speech to text | whisper.cpp | Local and private |
| Voice (default) | Piper or Kokoro | Local, free |
| Voice (optional) | ElevenLabs | Better voice, needs an API key |
| Word import | mammoth | .docx to structured content |
| Secrets | Electron safeStorage | Tokens and keys never in plain files |

Architecture: the **main process** owns everything that touches disk, network or AI (files, sync, AI calls, sign-in, settings). **Renderer windows are views only.** They request data over IPC and receive change broadcasts, so every open window, split pane or torn-off window stays live.

## Library and data model

The library holds two kinds of top-level item: **Series** (with their Volumes) and **Worlds**. A series links to a world rather than containing it, so every volume shares one world.

- **Series:** an umbrella for related books. Links to one world (optional).
- **Volume:** a separate project inside a series, and its own sync and Smart Storage unit.
- **Arc:** a collapsible group of chapters inside a volume. Arcs are labels in the volume's outline, not folders on disk.
- **Chapter:** one file, the core writing unit. Has a type (chapter or interlude) and an optional POV tag. Scene breaks inside a chapter show as jump points in the binder; splitting into separate scenes is optional.
- **World:** characters, places, lore, maps and the timeline, in user-defined categories. A world is its own sync unit.

```
library/
  series/<series-id>/
    series.json                 name, linked world id, volume order
    cover.<ext>                 optional cover image
    volumes/<volume-id>/
      volume.json               name, settings, goals
      cover.<ext>               optional cover image
      outline.json              arcs + chapter order (the only file changed by reordering)
      chapters/<chapter-id>.json   TipTap JSON + metadata (type, POV, notes)
      manifest.json             file list, versions, hashes (for sync)
  worlds/<world-id>/
    world.json                  name, category definitions
    cover.<ext>                 optional cover image
    entries/<entry-id>.json     one file per character, place, etc.
    maps/<map-id>.json + image  map image + pins linked to entry ids
    timeline.json
    manifest.json
  .ember-local/                 device-only: SQLite index, outbox, trash, doodles, window layout
```

(The `.ember-local` folder name comes from the app config, per the branding rule.)

Rules:

- **Stable IDs everywhere.** Every series, volume, arc, chapter and world entry has a permanent random ID. Links use IDs, never names, so renaming a character never breaks a link. Renaming anything changes only its display name; IDs and folders stay the same.
- **One file per item.** Chapters and world entries are separate small files, so sync moves only what changed.
- **Reorganizing is cheap.** Moving a chapter between arcs, or reordering, edits only `outline.json`. Nothing is renamed or moved on disk.
- **New story flow:** creating a series asks to connect it to a world: pick an existing one, create a new one, or skip. Volumes can be moved to another world later.
- **Safe writes:** every save writes a temp file, then renames it over the original, so a crash never leaves a half-written file.

## App shell and layout

One app, two modes: **Write** and **World**. Each mode keeps its own toolbar and sidebar, so neither shows the other's clutter. Moving between books happens on the **bookshelf**, not in a sidebar.

**Bookshelf (home screen).** A visual library of everything in it:

- **Series shelf:** every series as a cover card with its title underneath. A series with one volume shows a single cover; a series with two or more shows its covers stacked like a deck of cards, the latest volume on top and the others peeking out slightly behind it. Hovering a stack fans it out a little so two or three covers show (a smooth, subtle animation that respects reduced-motion settings).
- **Worlds shelf:** below the series, every world as a card in the same style.
- **"+ New series"** and **"+ New world"** cards at the end of each shelf. New series uses the new story flow (connect a world, create one, or skip).
- Files that can't be read are listed at the top of the bookshelf, untouched.

**Series page.** Clicking a series shows all its volumes as covers in reading order, each with its title and word count, plus a "+ New volume" card and the series' own cover. Clicking a volume opens it in the writing view. Clicking a series always opens this page, even when it has only one volume. A back button returns to the bookshelf.

**Covers.** Series, volumes and worlds can each have a cover image, added by upload or by dropping an image onto the cover. The image is stored inside that item's folder as `cover.<ext>` (PNG, JPEG, WebP or GIF), so it syncs with it; a replaced cover goes to the local trash. A volume without its own cover uses the series cover. With no image at all, a generated placeholder shows the title on a solid colour from the current theme, so a cover never looks broken. Covers use a book-like 2:3 portrait ratio.

**Right-click menus and renaming.** Short context menus:

- Series: New volume, Rename, Change cover, Delete. Volume and world: Rename, Change cover, Delete.
- Arc (in the binder): Rename, Delete. Deleting an arc that holds chapters asks whether to move them out of the arc (to where it was) or send them to the trash too.
- Chapter (in the binder): Rename, Move to arc, Delete.

Delete always moves to the local trash, with an Undo notice. Double-clicking a title (binder, series page, card labels) renames it inline, and F2 renames the selected item.

**Windows and panes:**

- **Split screen:** open the other mode beside the current one with a shortcut or button; drag the divider to resize.
- **Tear-off windows:** drag a pane's tab out to pop it into its own window, opened at the same route (for example `/world/<entry-id>`). Drag it back to re-dock.
- **Internal links:** clicking a linked name in the writer opens or focuses the World pane on that entry, wherever it is (split, torn off, or not yet open).

Layout of a writing window (there is no library sidebar; navigation goes through the bookshelf):

- **Command palette (Ctrl/Cmd+K):** commands for the current view (new chapter, find, focus mode, rename, scene break, panels), jumping to any chapter, series or volume, and switching theme.
- **Top bar:** back arrow (to the bookshelf) and a breadcrumb where every part is clickable: series (its series page), volume (its binder), arc (unfolds it in the binder), chapter (top of the chapter). Mode switch, command palette (Ctrl/Cmd+K).
- **Icon rail (left):** switches the side panel between binder, find, history, and later the world list and AI chat. Settings at the bottom.
- **Settings window:** the gear (or the Settings button on the bookshelf) turns the writing space into a settings window, with categories on the left and that category's settings on the right; Esc or Done returns to the page. Categories: Appearance, Page, Spelling, Writing analysis, Status bar, Library, Keyboard shortcuts, World, Import & export, Sync, Smart Storage, AI, Companion, Voice, Optional modules. Categories for features not built yet are shown greyed out, so the full shape of the app is visible from the start.
- **Side panel:** collapsible. The binder shows arcs (collapsible, finished arcs folded by default) and chapters, with drag-and-drop.
- **Page:** the writing surface (see Editor).
- **World pane (right, optional):** a slim view of the entry under the cursor or the last one clicked.
- **Status bar:** customisable. Right-click to choose what it shows (chapter, session and project words, goal progress, save/sync status, and any Diagnostics statistic for the chapter) and drag items to reorder them. Default: chapter words, session words, goal progress, sync status. It is the only place sync status appears ("Synced" or "Offline, 3 changes saved locally"). No sync popups.
- **Focus mode:** hides every panel and bar, leaving only the page (Ctrl/Cmd+Shift+F; Esc leaves it).

Window positions, split sizes and torn-off windows are device-only and never synced.

## Editor

The writing surface is a **page**, not open empty space: a fixed-width sheet centred on a darker background, with real margins.

- **Separate pages:** by default a chapter is laid out on separate sheets of a fixed paper shape (A4, US Letter or 6 × 9 in trade paperback), with a gap between sheets and a page number on each, like Word. Text flows from one sheet to the next; the page breaks are view-only and never saved. The page keeps its paper proportions at any window size, so it is never stretched. A continuous view (one sheet that grows) is available in Settings.
- **Page style:** margins, line spacing and page colour follow the theme (dark page in dark themes). The text column's width is an editor setting, 660px by default (about 60–75 characters per line, comfortable for long sessions), adjustable in Settings; the paper's height follows from its width and shape.
- **Rich text:** bold, italic, underline, headings, scene breaks, fonts, colours, images. Stored as TipTap JSON.
- **Autosave:** on every pause in typing; writing never waits for sync.
- **Linked names:** names of world entries are recognised; hover shows a card, click opens the entry. "Quick add" creates a stub world entry from selected text.
- **POV and interludes:** each chapter has a type and POV tag; the binder can filter by POV. Two chapters can open side by side.
- **Spellcheck:** Google Docs style. Unknown words are flagged; right-click for suggestions or to add the word to the personal dictionary. The dictionary is part of the app settings (so it syncs with them) and can be edited in Settings, along with the language and an on/off switch. On Linux and Windows the dictionary for a language is downloaded once on first use; macOS uses the system's.
- **Find and replace** across the whole volume (Ctrl/Cmd+F): match case and whole-word options, results grouped by chapter, click to jump to a match, replace one or replace all. Before a replace-all, every chapter it changes is snapshotted, so it can be undone from history. A match must sit inside one run of text with the same formatting.
- **Goals:** session goal and project goal, shown in the status bar. No streaks.
- **Version history:** automatic snapshots. When a chapter's text is saved and the last snapshot is over 10 minutes old, the version being replaced is kept, and a save that deletes 20+ characters always keeps the version from just before it (identical versions are skipped). A "Keep this version now" button saves one on demand, and the panel always shows the current version at the top. Keep everything from the last 2 weeks, one per day for 3 months, then one per week. Preview and restore any snapshot from the History panel; restoring first snapshots the current text, so a restore can be undone too. Snapshots live in the device folder until sync uploads them.
- **Trash:** deleted series, volumes, worlds, chapters (and later world entries) go to a local trash, kept until emptied. Restoring puts an item back where it was (a chapter returns to its arc and position; a deleted arc is recreated). Device-only, opened from the bookshelf.
- **Import:** .docx files, split into chapters at headings or "Chapter X" lines, with a preview to fix splits before anything is created.
- **Export:** DOCX, PDF, EPUB, Markdown, and copy-for-Royal-Road (per chapter, formatting that pastes cleanly).

### Writing analysis

Everything here is computed locally (no AI), and every number shows its unit. These are descriptive signals, not quality scores.

- **Diagnostics panel** (command palette or the status bar). Scope: Selection, Chapter or Volume. Shows word count, novel pages (words ÷ 250), reading time (250 words a minute), sentence count, average and longest sentence (words), paragraph count, average and longest paragraph (words), dialogue % (words inside quotation marks), vocabulary variety (distinct words per 100, averaged over 100-word stretches) and -ly adverb count. Lists the most-used content words; clicking one highlights every use in the current chapter. In Volume scope, a bar per chapter (with the median marked) shows uneven chapter lengths.
- **Rhythm** (toolbar toggle, Ctrl/Cmd+Alt+R, palette): tints each sentence by length: under 10 words green, 10–19 yellow, 20+ red. Hovering a sentence shows its word count. Thresholds and colours are adjustable in Settings.
- **Echo** (toolbar toggle, Ctrl/Cmd+Alt+E, palette): highlights content words that repeat within about 50 words (adjustable). Simple forms count as one word (walk, walks, walked, walking). Each repeated word has its own colour. Clicking one selects its nearby repeats, with a small bar to step between them.
- Rhythm and Echo are off by default, can be on together, and are view-only highlights: never saved into the chapter, exported or synced. Their soft tints come from the theme.
- **Shared rules:** sentence splitting understands fiction (dialogue in quotes, `?` and `!` inside quotes, ellipses, em dashes, abbreviations like Mr. and Dr., initials). Repeated words and Echo share one editable filler-word list (and, the, I, a, to, was, said…). Character and place names from the world are left out by default, with one setting to include them. Everything recalculates a moment after typing stops, never on every keystroke.

## Worldbuilding

Worlds are flexible: the user creates categories as the story needs them, instead of the app shipping a fixed set of empty tabs.

- **Custom categories:** characters, places, magic systems, factions, items, languages, religions, or anything else. Each category defines its own sections.
- **Entries with subsections:** an entry can have extra subsections, for example a character's past life and current life under one entry.
- **Links by ID:** entries link to other entries and to chapters.
- **Appearances:** each entry lists the chapters it appears in (the World view reads the manuscript but never edits it).
- **Maps:** an uploaded image with pins, each pin linked to a world entry. Maps are world data and sync with the world.
- **Timeline:** dated or ordered events, linkable to entries and chapters.
- **Ownership rule:** World mode edits world files; Write mode edits chapter files. Each file has one writer, so the two modes never fight over a file.
- **Later (not core):** a relationship web, drawn as a graph of who is connected to whom.

## Sync engine

Sync is per file and local-first: the local copy is the truth, the cloud is a mailbox, and no file with unsynced local changes is ever overwritten. This fixes the previous version's two failures: everything synced as one large blob (which stalled and errored), and reconnecting pulled the cloud copy over newer local work.

**What syncs, and how**

| Tier | Examples | Rule |
| --- | --- | --- |
| Device-only | Window layout, split sizes, recent files, trash, doodles, sign-in tokens | Never synced |
| Derived | Search index, AI summaries, caches | Never synced; rebuilt locally |
| Settings | Themes, character presets, AI settings, dictionary, ElevenLabs key | Manual only (see Settings sync) |
| Content | Chapters, outlines, world entries, maps | Automatic, per file |
| History | Snapshots | Upload-only; pulled only on restore |

**Per-file tracking.** Each content file records its content hash, the cloud version it was last synced from (its base version), and a dirty flag.

**Outbox.** Every save adds an entry to a persistent queue in SQLite. The queue survives going offline, closing the app and crashes, and uploads with retries and backoff when the network returns.

**Manifests.** Each volume and world has a small manifest of its files, versions and hashes. Sync compares manifests and transfers only changed files, usually a single chapter.

**The pull rule** (this is what prevents lost work):

| Cloud changed? | Local changed? | Action |
| --- | --- | --- |
| Yes | No | Download the cloud version |
| No | Yes | Upload the local version |
| Yes | Yes | Keep both: save a conflict copy, show a quiet notice, never overwrite |
| No | No | Nothing |

**Conditional uploads.** The Worker accepts an upload only if the file's cloud version still equals the base version the device started from (checked in D1 in one transaction). Otherwise it rejects the upload and the app treats it as a conflict.

**Deletions.** A deletion syncs as a marker. Every device moves its own copy into its own local trash rather than erasing it, so nothing is lost on any machine.

**Writing never waits.** Sync runs in the main process in the background; the editor never blocks on the network.

**Sync must prove itself.** Build an automated test harness alongside the engine, not after: two simulated devices editing the same and different files, the network cut mid-upload, the app killed mid-save, then reconnecting. The test passes only if no words are ever lost.

## Smart Storage

Volumes and worlds you are working on stay local and sync per file; ones you rarely open are compressed and only downloaded when you open them. It all happens in the background with no manual file management.

Each volume and each world is in one of three states:

| State | On this device | In the cloud |
| --- | --- | --- |
| Active | Normal files, synced per file | Per-file copies |
| Cold | One compressed archive | One archive |
| Cloud-only | A placeholder in the library | One archive |

Rules:

- **Going cold:** after a set number of days unopened (a setting), unless pinned with "Keep on this device".
- **Never compress anything with unsynced changes.** An item must be fully synced before it can go cold.
- **Cold items aren't re-uploaded** unless they change.
- **New devices** show cold items as cloud-only and download them on first open.
- **Reopening:** download if needed, decompress, verify every file's hash against the manifest, then switch back to per-file sync.
- **Volumes and worlds are independent:** an old volume can go cold while its series' world stays active.

## Settings sync

Settings never sync automatically. In Settings, two buttons move them between devices on demand, and the user always chooses the direction.

- **Upload to cloud:** saves this device's settings as the cloud copy.
- **Download to this device:** replaces this device's settings with the cloud copy.

Checkboxes choose what is included (remembered for next time): themes, character presets and sprite packs, AI settings, personal dictionary, keyboard shortcuts and editor preferences, and the ElevenLabs API key.

Before applying, show a summary (for example "3 themes, 2 characters, API key, uploaded from Mac on Oct 27") and ask to confirm.

**Secrets are encrypted on the device** with a user passphrase before upload, so Cloudflare only stores unreadable data. The passphrase is entered once on each new device. The ChatGPT sign-in is never synced; each device signs in itself.

## AI layer

AI helps but never writes the user's prose. It lives behind one provider interface in the main process, so features don't care which model answers.

**Providers:** Ollama (default, local) and ChatGPT via Sign in with ChatGPT (optional, uses the Plus plan's allowance). The user picks a provider per feature, for example Ollama for grammar and ChatGPT for chat. If ChatGPT sign-in isn't available for a personal app, everything still works on Ollama.

**Features:**

- **Spelling and grammar cleanup** without changing word choice. Shown as a before/after preview of the whole chapter with every change highlighted; accept all, reject all, or undo single changes. The app diffs the result itself, so any change the AI wasn't supposed to make is visible.
- **Brainstorming** (names, plot options, what-ifs).
- **Continuity checks** against world entries and earlier chapters.
- **Ask the story:** answers from the manuscript and world.
- **Chat with the companion** (see next section).

**Reading scope.** The AI reads only what the user means, and a chip shows what that is ("Reading: on screen, ~400 words"):

1. **Selection**, if text is selected.
2. **What's on screen**, the default.
3. **Whole chapter**, only when asked. Long chapters are read in chunks and summarised.

On-screen and selection reads also get a short summary of the chapter so far, so the AI has context.

**Context builder.** Pulls only the relevant world entries (those linked in the text being read) and recent chapter summaries, never the whole book.

**Nothing touches files without consent.** AI output is a suggestion until the user accepts it.

## Companion and character presets

The companion is an optional on-screen character who is also the AI you talk to. It is a module, off by default, built after the core works.

**Behaviour on screen**

- Wanders empty space when you pause; settles and stays still (sits, reads, naps) while you type.
- Perches on the top edge of the page. It is not locked to the scroll position, so scrolling down never makes it cover text. It may drop into view when there is room.
- Transparent background; clicks pass through empty space between its shapes.
- Animation pauses when the window is unfocused.
- Reacts quietly (a small celebration at a goal) but never interrupts or pops up messages.

**Locked rules (built into the app; no preset can override them)**

1. Opinions only when asked.
2. Every concern comes with a specific fix (what to add, cut, move or clarify, and where). No fix, no comment.
3. On pushback: one new angle with a new fix. On a second pushback: drop it gracefully.
4. Dropped points go into a per-book notebook and are not raised again unless asked.
5. Continuity slips (eye colour changed, someone in two places) get one mention with the fix, dropped if marked intentional.
6. Never writes or inserts prose. "Show me what you mean" gives one example line in chat only.
7. Follows the reading scope from the AI layer.

**Voice-first**

- Push-to-talk: hold a hotkey or click the companion. No always-listening.
- Speech to text with whisper.cpp; reply spoken with Piper or Kokoro by default, or ElevenLabs if a key is set (off by default).
- Everything said both ways also appears as text in the chat panel. Talking or pressing the hotkey interrupts it.

**Character presets.** The personality is a pasteable YAML file, so a new character is a new preset, not new code. Presets cover persona only; the locked rules always apply. Settings → Characters → New character → paste → validation (missing fields get defaults) → a preview chat → save. Characters can be switched per book.

```yaml
name: Capri
role: companion
addresses_user_as: "choom"
address_frequency: natural   # roughly 1-3 times per conversation, never back to back
slang_frequency: light       # one slang word per reply at most, often none
personality: >
  Sharp, quick, a little cocky, genuinely on your side.
  Teases you but never mocks the work. Honest even when
  it stings, then helps you fix it.
speech_style: >
  Cyberpunk street slang, used naturally. Short, punchy lines.
slang:
  choom: friend
  preem: great, top quality
  nova: cool
  delta: leave, move on
  flatline: die / fall dead
bluntness: 4                 # 1 = very gentle, 5 = blunt
example_lines:
  - "Ehh, not sure about this one. Fight's over before it starts. Give him a beat where he clocks he's outgunned."
  - "I'm seeing the vision, choom, but this is not it... the reader's gonna think you forgot to finish the fight. Drop a warning in the opening."
  - "Alright, your call. Dropping it."
  - "Okay, that reveal? Preem. Didn't see it coming."
voice:
  local: ""
  elevenlabs_voice_id: ""
appearance: capri
```

**Built-in presets:** Capri (above) and a calm butler (addresses the user as "sir", dry and polite). More are added by pasting presets.

**Appearance.** Presets point to an appearance pack. Start with sprite packs (PNG frames per state). Capri's art comes from the open-source capri-desktop project and already includes idle, blink, perch, dangle, sleep, wake, grin, a talking mouth and glitch frames; a walk animation is missing. Her art is under the PolyForm Noncommercial license, fine for personal use, and is removed if the app is ever sold. Keep her as a swappable pack, never hard-coded.

## Themes

Themes are data files (colours, fonts, page style), so adding one is a new file, not new code. Every theme covers both the app chrome and the page. The page itself always uses a readable writing font; stylised fonts are for the UI only.

- **Light** and **Dark** (defaults)
- **High contrast**
- **Cyberpunk:** near-black and deep navy, hot pink and acid-green accents, faint glow on the active line, techy UI font.
- **'90s Desktop:** grey windows, bevelled buttons, classic title bars.
- **Arcade:** black cabinet with deep reds, pixel-art icons and borders, pixel UI font.
- **Starter set:** about 15 more (for example sepia paper, forest, ocean, solarized), generated to fill out roughly 20 total.

Optional: picking a theme can suggest a matching companion (Cyberpunk suggests Capri), as a suggestion only. Themes and characters mix freely.

## Optional modules

These are all off by default. While off, they leave no trace in the UI: no menu items, no empty panels, no settings pages beyond the toggle itself. Each lives in its own folder so it can be removed cleanly.

| Module | What it adds | Toggle lives in |
| --- | --- | --- |
| Publishing | Posted / scheduled / backlog tracking per chapter | Project settings |
| Author's notes | Per-chapter notes for above/below a posted chapter | Project settings |
| Companion | On-screen character, chat and voice | App settings |
| ElevenLabs voice | Premium voice for the companion | Companion settings |
| Doodle pad | Freehand scratch canvas, device-only, never synced | App settings |
| Relationship web | Graph of connections between world entries | World settings |

## Milestones

Build in this order. Each milestone ends with a working app the user can actually write in; don't start the next until the current one is solid. Keep each to a size that fits one or two Claude Code sessions.

1. **Foundation:** project scaffold (Electron + React + TypeScript), `app.config.ts` for branding, library folder format, main-process file service with safe writes, IPC skeleton.
2. **Writing core:** Write mode, binder with arcs and drag-and-drop, TipTap editor on a page, autosave, word counts and goals, light/dark themes.
3. **Writing polish:** separate pages (fixed paper size, Word-style page breaks), spellcheck with personal dictionary, find and replace, focus mode, version history and restore, local trash, command palette, Diagnostics panel, customisable status bar, Rhythm and Echo.
4. **World core:** World mode, custom categories and entries, linked names with hover cards, quick add, appearances list.
5. **Layout:** split screen, tear-off windows, live updates across windows.
6. **Import and export:** .docx import with preview; DOCX, PDF, EPUB, Markdown and Royal Road export.
7. **Sync engine:** Cloudflare Worker, R2 and D1 with step-by-step setup instructions; outbox, manifests, pull rule, conditional uploads, conflict copies, and the failure test harness. Ship only when the harness passes.
8. **Smart Storage and settings sync.**
9. **World extras:** maps with pins, timeline.
10. **AI layer:** provider interface, Ollama, reading scope, grammar preview, brainstorm and chat panel. Then ChatGPT sign-in.
11. **Companion:** preset system and locked rules, sprite renderer, Capri and the butler, on-page behaviour.
12. **Voice:** push-to-talk, whisper.cpp, Piper or Kokoro. Then the ElevenLabs option.
13. **Themes:** Cyberpunk, '90s Desktop, Arcade, high contrast, and the starter set.
14. **Remaining modules:** publishing, author's notes, doodle pad, relationship web.

## Open items

None of these block milestone 1.

- [ ] Confirm "Sign in with ChatGPT" can be used by a personal, unlisted app (check OpenAI's developer docs before milestone 10).
- [ ] Capri walk animation: commission or make the frames.
- [ ] Art for other companion characters.
- [ ] Pick local voices for Capri and the butler.
- [ ] Days-unopened threshold for Smart Storage.
- [ ] Final app name (Ember for now; rename via `app.config.ts`).
