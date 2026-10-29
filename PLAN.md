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
- **World:** people, places, history and systems as entries (one file each), organised by four lenses (Where, Who, When, How) with no categories to set up. Maps and time come in milestones 4b and 4d. A world is its own sync unit.

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
    world.json                  name, pinned entries
    cover.<ext>                 optional cover image
    entries/<entry-id>.json     one file per person, place, event, system: template, facts
                                (with history), page text, captured quotes, portrait
    images/<sha256>.<ext>       portraits and map images, stored once, named by content hash
    maps/<map-id>.json          a map: its image (by hash), the place it shows, its regions
                                (vector outlines) and pins linked to places; or the travel sketch
    templates.json              customised or new templates (only once used)
    inbox.json                  captured lines waiting to be filed (only once used)
    rejected.json               turned-down suggestions, never shown again (only once used)
    relationships/<rel-id>.json one file per relationship: from, to, type, kin (family),
                                words, starts/ends (chapter or event), over
    relationship-types.json     renamed or added relationship types (only once used)
    board.json                  where each person sits on the people board (layout only)
    …                           added by milestone 4d
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

Delete always moves to the local trash, with an Undo notice. Double-clicking a title (binder, series page, card labels) renames it inline, and F3 renames the selected item. F2 copies a screenshot of the window to the clipboard (nothing is saved).

**Windows and panes:**

- **Split screen:** open the other mode beside the current one with a shortcut or button; drag the divider to resize.
- **Tear-off windows:** drag a pane's tab out to pop it into its own window, opened at the same route (for example `/world/<entry-id>`). Drag it back to re-dock.
- **Internal links:** Ctrl/Cmd+clicking a linked name in the writer (or "Open in World" on its hover card) opens that entry: in World mode for now, and in the World pane wherever it is (split, torn off, or not yet open) once split screen exists.

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
- **Linked names:** names and aliases of world entries are recognised (whole words, case-sensitive, possessives included) and marked with a dotted underline, in chapters and in other entries. Hover shows a card (category, aliases, opening text); Ctrl/Cmd+click opens the entry. A plain click only places the cursor, so names stay easy to edit. The marks are view-only and can be switched off in Settings → World. "Quick add" turns selected text into a stub entry: right-click → "Add to the world…", Ctrl/Cmd+Alt+N, or the command palette; it offers to create a world if the series has none.
- **POV and interludes:** each chapter has a type and POV tag; the binder can filter by POV. The POV field suggests names from the world; picking one links the chapter to that entry by ID, so renaming the character updates the POV everywhere. Two chapters can open side by side.
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

The milestone 4 that was built works, but in use it feels like a filing cabinet: a blank form, generic text boxes, and a separate room the writer never visits. This redesign keeps the same ground rules (core stays basic, never lose words, light branding, local-first) and replaces the World experience.

### Goals

1. **Explore, don't file.** World mode should feel like travelling through the world, not filling in forms.
2. **It should feel like the story.** World mode takes on the look and language of the theme (fantasy, cyberpunk, arcade).
3. **The world comes to the writer.** Most day-to-day worldbuilding happens beside the page, not in a separate mode.
4. **Little typing.** Certain facts fill in automatically; everything else is captured in a click or suggested for approval.
5. **Never wrong on its own.** The app only fills in what it knows for certain. Anything guessed is a suggestion until accepted.
6. **Readable by AI.** Every visual feature also exists as text and links, so Ollama or ChatGPT can understand the whole world without seeing images.

### Clear the test data

The existing world data (Mara Voss, The Shattered Isles, etc.) is test data created during development. No migration is needed; remove it.

### Entries: pages, not forms

Every person, place, faction, event and system is an entry, stored as one small file.

- **Reading mode by default.** A page shows only what has been written, laid out like part of the world. Empty fields are hidden; a single "+ add detail" adds one. Inputs appear only when you click something to edit it.
- **A page you write.** Each entry has a free-written body (like a chapter), not a stack of text boxes.
- **Quick facts strip.** 3–5 key facts at the top from the entry's template. These show in hover cards.
- **Linking by typing.** Names of existing entries in world pages are recognised and linked, the same way they are in chapters. Typing `@` opens a picker to link anything explicitly.
- **Facts that change over time.** A fact can have a history, each value with "from chapter X" or "from event Y" (location, status, ruler, allegiance). Everything that displays the fact shows the value for the selected moment (see Time).
- **Portraits and images.** Drag an image onto an entry to set its portrait, with simple cropping.

#### Templates

Templates decide which quick facts an entry shows. Most fields are **links** to other entries, not text, so the map, board and timeline can draw them. When creating, the app guesses the template from context (a region on a world map defaults to Kingdom; inside a city, District), and you can change it.

| Lens | Templates | Key fields (→ = link) |
| --- | --- | --- |
| Where | Continent, Kingdom, City, District, Landmark, Wilds | within →, ruled by →, population, climate, known for |
| Who | Person, Faction, Family, Creature | home →, member of →, leader →, territory →, status, role |
| When | Era, Event | era →, where →, who was involved →, outcome |
| How | Magic, Religion, Law, Technology, Custom | rules, costs, limits, who can use it →, where it works → |

Every template keeps a free notes area. Templates are editable, users can make their own, and customised templates are saved into the world folder (so they travel with it).

### The four lenses

World mode is organised around four questions, each a visual space. What you create is decided by where you create it, so there is no category setup.

#### Where: the map (the front door)

Opening World mode lands on the world map. You travel instead of browsing folders.

- **Places are locations you visit.** A place shows who is there (at the selected moment), what happened there, what is inside it, and **what's nearby** as exits. Moving between neighbouring places, or stepping back out to the parent, is how you navigate.
- **Interactive regions.** Import a map image, then detect regions:
  - **Auto-detect all** finds every area enclosed by border lines (best on clean, flat-colour maps).
  - **Magic wand:** click inside a region to fill just that area, with a tolerance slider.
  - **Fix-up tools:** merge regions, split a region by drawing a line, trace a region by hand.
  - Detection runs locally with OpenCV.js. No AI, no internet.
- Regions are saved as **vector outlines**, separate from the image. Hovering a region highlights it and shows its name; clicking opens its place. Each region links to a place entry (existing or new).
- **Nested maps:** a region can link to its own sub-map (click a kingdom to open the kingdom's map).
- **Territory colours:** regions can be tinted by the faction that rules them.
- **Who's where:** portraits sit on the map at each person's location at the selected moment.
- **Unplaced tray:** people without a location wait at the edge of the map; drag one onto a place to set it.
- **Event pins:** events with a "where" show as markers.
- **No map yet?** Start with a **travel sketch**: places as dots joined by roads. It can be replaced by a real map later.

#### Who: the Cast view and the people board

**Cast view (the default for Who).** Every person, grouped automatically using only certain data (where they have actually been mentioned):

- **In the story:** appeared recently.
- **Waiting in the wings:** created but not yet mentioned in any chapter.
- **Gone quiet:** appeared before, but not mentioned in the last 10 chapters (adjustable).
- **Left the story:** marked dead or departed.

Each card shows portrait, name, role and one key line: "Last seen: Ch 4, Gullhaven", or for waiting characters an optional "Enters around: Arc 3" note. Filter by faction, place or POV; sort by last seen; search. "Gone quiet" is shown, never announced. The same groups are available for places, factions and systems.

**People board.** A board of portraits and groups (factions and families as frames).

- **Link by dragging** one portrait onto another, then choose the relationship type.
- **Coloured lines by relationship type**, with a legend:

  | Colour | Means |
  | --- | --- |
  | Grey | Met |
  | Green | Friends / allies |
  | Red | Fought / enemies |
  | Blue | Family |
  | Pink | Romance |
  | Gold | Mentor / loyal to |
  | Purple | Rivals |

- **Solid = current, dashed = over.**
- **Several types between the same two people blend along the line** (red fading into pink; blue into gold; three types = three bands). Colours are never averaged, because averaged colours would collide with other types. Hovering a line lists the types in words ("Rivals, then lovers").
- **Grey "met" never blends.** It only shows when there is no other relationship.
- Click the legend to show or hide types. Types and colours are editable.
- **Family tree view** rearranges family links into a tree.
- Relationships respect time (a relationship can start or end at a chapter or event).

#### When: the time scrubber

Time is a scrubber that sits above the map (and is available on the board).

- World history shows as **era bands** with **event ticks**; the story's **chapters** are markers along it.
- **Defaults to "now":** the chapter last written.
- Dragging it changes everything below to that moment: who is where, territory colours, statuses, relationships, hover cards.
- **People move:** portraits move to their location at that moment, with a faint trail showing where they came from. A play button animates the story's movements.
- **Recording a move is a drag:** set the scrubber to chapter 8 and drag Mara to Saltmere. That records "in Saltmere from chapter 8".
- **Map versions:** a map can change at an event (a coastline drowns, borders shift, a city burns). Choose "the map changes here" on an event and upload a new image or redraw borders. Places keep their identity across versions; a place that splits becomes new places linked to the old one.
- **Calendar:** no calendar for now. Ordering is by eras, events and chapters. Leave room for an optional date field later.

#### How: the rulebook

Systems (magic, religion, law, technology, customs) are rulebook pages: numbered rules, costs and limits, who can use it, where it works. Rules can be tagged in chapters, and each rule lists the chapters where it comes up.

### One card everywhere

Clicking anything in any lens (a region, a portrait, an event, a rule) opens the same entry card. It shows what that thing touches across all four lenses: who lives in a place, what happened there, which rules apply there.

### The world while writing

The Write mode side panel has two tabs:

- **In this chapter:** people, places and terms mentioned in the current chapter. Click one to expand its card; add a fact without leaving the page; open its full page.
- **Waiting and gone quiet:** characters due to enter, or not seen in a while.

Plus:

- **Hover cards** on linked names show quick facts as of the current chapter.
- **One-click capture:** select a sentence, right-click, "Add to Mara → Appearance". It saves the quote with a link back to the chapter.
- **Bug fix:** names must not match inside hyphenated words ("Mara-blue" must not link to Mara).

### What fills in automatically, and what doesn't

**Certain, automatic (no AI):**

- Mentions, with the line each appears in.
- Chapters each entry appears in, first and last appearance, POV chapters.
- Last seen, and the Cast view groups.
- Region adjacency (from region outlines).
- New capitalised names that repeat 3+ times and aren't just sentence starts (to the inbox, never a popup).

**Never automatic:** "met" because two people share a chapter, "lives here" because a person is mentioned near a place, "family" because of a shared surname. These are not drawn and not suggested.

**Suggested (inbox only, always with the quote):** clear phrases that state a relationship ("her brother Odo", "Mara of Gullhaven"), and later, AI suggestions.

**Rules:** nothing guessed appears on the map, board or timeline until accepted. User edits always win; automation never overwrites them. Rejected suggestions are remembered (one small synced file) and never come back.

### The inbox

A quiet review queue in World mode. No popups, no badges that nag. Three kinds of items:

1. **Captured:** things you saved from your writing.
2. **Suggestions:** new names, stated relationships, and (later) AI-proposed facts, moves and events. Grouped by chapter, with "accept all from chapter 4".
3. **Questions:** things the AI needs answered (see below).

Accepting a suggestion is dropping it into place: it becomes a normal entry or fact.

### Convenience

- **Command palette searches the world** and jumps to any entry.
- **Quick add hotkey** from anywhere (including the writing page): type a name, pick a template.
- **Back and forward** like a browser (mouse side buttons, Alt+arrows).
- **Recent and pinned** entries.
- **Peek:** hover for the card; middle-click to open in split view or a new window.
- **Undo** for world actions (moving portraits, deleting links, redrawing borders).
- **Fix-up:** merge duplicate entries, change an entry's type, duplicate an entry.
- **Safe deletes:** deleting a place asks what to do with linked people and events; everything goes to the trash first.
- **Export a world bible** to PDF or Markdown.

### Settings and fallbacks

Every visual feature has a plain fallback, so turning something off never leaves a hole.

| Setting | When off, you get |
| --- | --- |
| World skin (full / plain / minimal) | The clean default layout in the theme's colours |
| Themed vocabulary | Plain words, even inside a skin |
| Map | A travel sketch, or a simple list |
| Time scrubber | The world as it stands at the latest chapter |
| Movement trails and animations | Portraits jump to their new spot (also follows the system's reduced-motion setting) |
| Blended relationship lines | One line in the strongest relationship's colour |
| Name underlines in the writer | Names link only on Ctrl+click |
| Hover cards | The side panel only |
| Name catcher | No new-name suggestions |
| AI suggestions (off / Ollama / ChatGPT; after each chapter, when idle, or only when asked) | The inbox holds only captured items and questions |
| AI questions (voice / inbox only) | Questions go to the inbox |
| Every visual lens | A list view toggle: a plain sortable list of the same data |

Also:

- **Lighter mode** for slower machines: no animations, lower-resolution map rendering.
- **Accessibility:** keyboard navigation between map regions and board portraits; readable contrast in every skin.

### Data and sync

- **One small file per entry** (place, person, faction, event, system), as before.
- **Fact history lives inside each entry** (location, status, etc., each with its "from" anchor). Small; syncs with the entry.
- **Each relationship is its own tiny file** (from, to, type, current or over, start and end anchors). The reverse side is computed, not stored twice, so adding links on two devices never conflicts.
- **Layout is separate from content:** portrait positions on the board are a small per-world layout file. Dragging a portrait never rewrites the person. If two devices disagree on layout, the newest wins.
- **Map images are stored once,** named by content hash, and never re-uploaded. Region outlines and map versions are small separate files. A new device downloads map images only when the Where lens is opened.
- **Templates and the rejected-suggestions list** live in the world folder and sync with it.
- **Derived data** (mentions, appearances, Cast groups, adjacency, the digest, search indexes) is rebuilt locally and never synced, except that each volume's search index and chapter summaries are kept available when the volume goes cold.
- **Smart Storage** still treats a world as one unit; a cold world archives everything, including map images and versions.

### As built in 4a

Choices made while building 4a, so later steps start from what exists:

- **Old test data** is not migrated. An entry file in the old format (categories and sections) is listed in World mode as unreadable and left untouched on disk; delete the old world from the bookshelf (it goes to the trash) and empty the trash to clear it.
- **World mode opens on Where.** Until the map exists (4b), Where shows places inside places (by their "Within" fact) and a sortable list. Who opens on the Cast view; When lists eras with their events; How is a rulebook (numbered rules, costs, limits). Every lens has a List toggle.
- **Facts over time:** each value starts "from the start", "from Ch N" or "from an event". Until events have a place on the timeline (4d), a value from an event counts as already true. Hover cards and the side panel show facts as of the chapter being written; World mode shows them as of now.
- **Linking:** names typed on a page link like in chapters; `@` inserts an explicit link that survives renames. Both count as links in "Linked here" on the other entry.
- **One-click capture:** right-click selected text in a chapter → "Capture to the world" → an entry from this chapter (POV first) → a field or Notes, or "Capture to the inbox". The quote keeps a link back to its chapter.
- **The name catcher** suggests single capitalised words (names of two or more words come later). Turning one down remembers it in `rejected.json`.
- **Merging** keeps one entry: the other's name becomes an alias, its facts, quotes and page are added, links to it move over, and it goes to the trash. Chapters are never rewritten; a POV tagged with the merged entry still resolves to the kept one.
- **Undo** covers world actions (adding, deleting, merging, changing facts, filing, rejecting): a notice with Undo, or Ctrl/Cmd+Z outside a text field.
- **Text forms:** "View as text" on any entry and "View the world as text" (the digest) show exactly what an AI model will be given.
- **Settings → World:** name marks, hover cards, the name catcher, and how many chapters make someone "gone quiet" (default 10).
- **The Add dialog** (quick add, "+ New place" and so on) uses the app's own searchable template picker. From a lens's button it lists that lens (City, Person, Event or Magic chosen) plus "Something else…"; from the page it lists every template, guessing from the name and the words before it ("sailed into Gullhaven" → City), else Person. Right-click "Add … to the world" is offered only for name-like selections, not sentences.

### As built in 4b

- **The Where lens has Map, Places and List.** It opens on the map once one exists. With no map, Map shows the travel sketch: places as dots you drag into place, joined by roads (click one, then another). "Import a map image…" adds a real map; the sketch stays as the fallback.
- **Detection runs in a background worker with OpenCV.js**, on a copy of the image at most 1600 px across; outlines are scaled back to the image. Every tool first smooths the copy (median, then two edge-preserving passes) so paint texture and brush strokes don't count as edges. **Auto-detect** has a ▾ menu of methods: _border lines_ (political maps: areas enclosed by drawn lines), _land and sea_ (painted maps: the sea is found by colour, blue groups, or a point you click; the frame, grid lines, label boxes and thin bridges are cleaned away and each landmass becomes a region), and _colour areas_ (countries in different colours without lines). _Automatic_ tries border lines and keeps them if they give 2–40 areas covering most of the map, else land and sea, else colour areas, and says which it used. Detection only adds regions that aren't already covered. A step that fails or runs over 90 seconds is stopped and explained, never left spinning.
- **The magic wand** (default tolerance 25, 1–60) grows only outwards from the click on the smoothed image, cuts narrow leaks and fills small holes. A click shows a preview; Shift+click adds to it, Alt+click cuts from it, the slider re-runs it, Enter or "Add region" keeps it. Merge joins selected regions across the border line between them; Split cuts one along a drawn line (the line's ends are carried on a little, so stopping just short of the edge still cuts); Trace outlines by hand. Every change has Undo.
- **Selecting:** click a region or pin; Shift, Ctrl or ⌘+click adds more; drag a box to select several; the smallest region under the pointer wins; a readout says how many are selected. Outlines in edit mode are white with a dark halo, visible on any map.
- **Pins** mark a place at a point (a city, a landmark), inside a region or anywhere, saved in the map file with the regions. Pin tool: click, then find or create the place (City by default; Landmark on a city's map). A new pin inside a region makes the place within it if it had no "Within"; if it was within somewhere else you're asked, never changed silently. Pins can be dragged to move; hover shows name and kind; click opens the place; people can be dropped on them. Pins within 4% of the map of each other are nearby; the text form says "Pinned on: …".
- **The pin bar** (collapsible, beside the map) lists only places that belong on this map but aren't on it yet: grouped under the region they're within (full region names, groups collapsible and sorted, with a search box), and "Unsorted" last. A map of a place lists only places within it; places on a map of one of its regions are left out. Drag a place out onto the map to pin it (it leaves the bar); drag a pin back in to take it off the map. An unsorted place whose page mentions one of the map's regions gets "Page mentions … : put it there?", which sets "Within" only when accepted.
- **Regions** are vector outlines in image pixels, saved in the map file, separate from the image. Hover shows the place's name; click opens it (an unlinked region offers to link). Link panel: find a place or make one; a new place defaults to Kingdom on the world map, City inside a kingdom, District inside a city, and gets "Within" the map's place.
- **Nested maps:** a place's page has "Add a map of …" / "Open the map of …"; on the parent map a ⤵ marker leads in, and breadcrumbs lead back out.
- **Nearby:** regions within 1.5% of the map's size of each other touch (border lines have width); touching linked regions and sketch roads make places nearby. Place pages list them as exits; the text form ("## Nearby") and digest ("borders: …") include them.
- **People on the map:** portraits stand on their current location (a region or a pin); the Unplaced tray lists people with no location; dropping one on a region, pin or sketch dot sets "Where now".
- **Territory colours** (toggle, remembered per device) tint regions by their place's "Ruled by", with a legend.
- **Settings → World:** the map can be turned off (Places and List remain); lighter mode shows map images at most 1200 px across and turns off animations and transitions everywhere.
- **Trash:** removing a map moves its file to the trash (its image stays, as it's stored once).

### As built in 4c

- **The Who lens has Cast, Board, Family tree and List.** Board shows every person and group as a portrait; groups (factions, families) are drawn as frames around their members (from "Member of"), and dragging a frame's label moves its members.
- **Linking:** drag one portrait onto another to open the relationship editor; dragging onto empty space just moves the portrait (saved in `board.json`, with Undo). The editor has the type (chips), for Family whether one is the other's parent or they're siblings or partners, optional words ("sworn brother"), when it starts and ends (a chapter or an event), and "It's over". Clicking a line lists that pair's links to edit or remove.
- **Lines:** one line per pair, in the type's colour. Several types on one pair are drawn as bands side by side in a gradient (never mixed into a new colour); hovering says it in words ("Rivals, then romance"). "Met" shows only when the pair has nothing else. A line whose links are all over is dashed. With blending off (Settings → World) a line takes its strongest type: family, romance, enemies, rivals, mentor, friends, met.
- **Types:** met, friends/allies, fought/enemies, family, romance, mentor/loyal to, rivals, each with a colour. "Edit types…" renames, recolours or adds types per world (`relationship-types.json`). The legend toggles each type's lines (remembered per device).
- **Family tree** lays out family links: parents above children, partners and siblings side by side (siblings without a shared parent joined by a light bracket). **List** is a sortable table of every relationship.
- **Entry pages** of people and groups (and any entry with links) have a Relationships section with "+ Add a relationship".
- **Merging** two entries moves their relationships to the kept one; **deleting** an entry with "remove links to it" removes its relationships too (otherwise they are hidden until it is restored); Undo restores them.
- **Text forms:** the entry's text gains "## Relationships"; the digest gains "ties: …".

World skins are described under Themes; the AI side of the world (readable by AI, "Update the worldbuilding", AI questions) under AI layer. Build order: milestones 4a–4e.

- **Ownership rule:** World mode edits world files; Write mode edits chapter files. Each file has one writer, so the two modes never fight over a file.

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

### The world and the AI

#### Readable by AI (baked in from the start)
Every world feature must also exist as text and links. The map, board and timeline are views over structured data. The AI never needs to see an image.

- **Map as facts:** within, borders (from adjacency), on the coast, and "who is where at chapter X" as a list.
- **Board as facts:** "Mara: sister of Odo; fought Kael (from ch 7)".
- **Timeline as facts:** events in order, with eras and places.
- **World digest:** a compact, automatically rebuilt text summary of every entry (ID, name, aliases, type, one line, current location and status). Small enough for Ollama. Derived data, rebuilt locally.
- **Lookup tools for the AI:** search entries, get an entry, get relationships, where was X at chapter N, what is in place P, list the cast by status. The AI looks things up instead of being handed everything. For models without tool calling, the app does the lookup itself and includes only the relevant entries.
- **Cold volumes stay searchable:** each volume keeps a small search index and chapter summaries that remain available when it is compacted, so the AI can search old volumes without unpacking them.

#### "Update the worldbuilding" (built at the AI milestone)

A fixed pipeline. The app drives each step; the AI only answers narrow questions.

1. The app finds which known entries appear in the chapter (certain matching).
2. The app gives the AI the chapter (chunked if long), those entries, the digest and everyone's positions at that chapter.
3. The AI returns structured proposed changes (new entries, fact updates with "from chapter N", moves, relationships, events), each with a quote and real entry IDs. Smaller Ollama models run this as several short passes (people, places, events); ChatGPT can do one pass.
4. The app validates every proposal (IDs exist, schema correct) and drops anything invalid.
5. Valid proposals go to the inbox. The AI never writes to the world directly.

#### When the AI can't find something

1. Search everything first, including cold volumes' indexes and summaries.
2. Fetch quietly if needed: unpack a cold volume temporarily, or download a small cloud-only one.
3. Otherwise **ask the user**: something unclear ("Is 'the Captain' in chapter 9 Mara, or someone new?"), something not written anywhere, or something needing permission (a large download, or offline).

- Asks **by voice by default** once the companion and voice exist, only at a natural pause, never while typing. Unanswered questions move to the inbox. Setting: voice or inbox only. Until voice exists, questions go to the inbox.
- The pipeline continues with everything else; only changes that depend on the answer wait.
- Answers become facts marked "you told me", so the same question is never asked twice.

#### Proving it

Build a small test world with a few chapters and the changes they should produce. Run the pipeline against it with the local Ollama model to measure how well it does before trusting it with real work.


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
- **Fantasy:** a new theme with a full world skin (parchment, inked borders; Atlas / Chronicle / Lore).
- **Starter set:** about 15 more (for example sepia paper, forest, ocean, solarized), generated to fill out roughly 20 total.

**World skins.** World mode should feel like the story. Each theme can carry a **world skin**:

- Frames, typography, map styling (parchment and inked borders; neon wireframe glow; pixel grid), transitions, and a **vocabulary file** (fantasy: Atlas / Chronicle / Lore; cyberpunk: NETDB / Logs / Protocols; arcade: Stages / Players / Unlocked).
- Same layout and data underneath; a new skin is new art and words, not new code.
- **Full skins for three themes only:** a new **Fantasy** theme, **Cyberpunk** and **Arcade**. All other themes use the clean default skin in their own colours.
- **The writing page stays readable in every skin.** Immersion lives in World mode and the surrounding app.

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
4. **World** (built in steps; each must be usable on its own before the next starts):
   - **4a: Pages.** Clear test data. Entry pages in reading mode, templates and quick facts, linking by typing and `@`, fact history (data only), the two Write-mode side panel tabs, hover cards, one-click capture, the hyphen bug fix, the Cast view, the inbox (captured items and name catcher), convenience basics (palette search, quick add, back/forward, recent and pinned, undo, merge, safe deletes), list views. The world digest and text forms start here.
   - **4b: The map.** Import, region detection (auto, magic wand, fix-up tools), regions linked to places, nested maps, nearby/exits navigation, unplaced tray, travel sketch fallback, territory colours.
   - **4c: The people board.** Drag-to-link, coloured relationship lines, blending, dashed for over, legend filters, family tree view.
   - **4d: Time.** The scrubber, facts as of the selected moment everywhere, moving people by dragging, trails and playback, map versions, event pins.
   - **4e: Skins.** The world-skin system and vocabulary files; Fantasy, Cyberpunk and Arcade skins; lighter mode.
5. **Layout:** split screen, tear-off windows, live updates across windows.
6. **Import and export:** .docx import with preview; DOCX, PDF, EPUB, Markdown and Royal Road export.
7. **Sync engine:** Cloudflare Worker, R2 and D1 with step-by-step setup instructions; outbox, manifests, pull rule, conditional uploads, conflict copies, and the failure test harness. Ship only when the harness passes.
8. **Smart Storage and settings sync.**
9. **World extras:** nothing left here; maps moved to 4b and time (the timeline) to 4d.
10. **AI layer:** provider interface, Ollama, reading scope, grammar preview, brainstorm and chat panel. Then ChatGPT sign-in. Then the world side: lookup tools, the "Update the worldbuilding" pipeline, AI suggestions, AI questions, and the test world.
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
