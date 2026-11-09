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
| Spellcheck | Electron's built-in spellchecker + personal dictionary | Google Docs style flags |
| Cloud sync | Cloudflare R2, spoken to directly (S3 API, conditional writes) | Free tier is enough for one person; no server code |
| Local AI | Ollama | Free, offline, already installed |
| Cloud AI (optional) | Sign in with ChatGPT | Uses the ChatGPT Plus plan, no API key |
| Speech to text | whisper.cpp | Local and private |
| Voice (default) | Piper or Kokoro | Local, free |
| Voice (optional) | ElevenLabs | Better voice, needs an API key |
| Word import | mammoth | .docx to structured content |
| Export | docx, fflate (EPUB zip), Electron's printToPDF | Word, EPUB and PDF files |
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
                                (vector outlines) and pins linked to places; or the travel sketch.
                                A later version of a map is its own file (versionOf, from an event)
    templates.json              customised or new templates (only once used)
    inbox.json                  captured lines waiting to be filed (only once used)
    rejected.json               turned-down suggestions, never shown again (only once used)
    relationships/<rel-id>.json one file per relationship: from, to, type, kin (family),
                                words, starts/ends (chapter or event), over
    relationship-types.json     renamed or added relationship types (only once used)
    board.json                  where each person sits on the people board (layout only)
    manifest.json
  .ember-local/                 device-only: sync state, history, trash, doodles
```

(The `.ember-local` folder name comes from the app config, per the branding rule.)

Rules:

- **Stable IDs everywhere.** Every series, volume, arc, chapter and world entry has a permanent random ID. Links use IDs, never names, so renaming a character never breaks a link. Renaming anything changes only its display name; IDs and folders stay the same.
- **One file per item.** Chapters and world entries are separate small files, so sync moves only what changed.
- **Reorganizing is cheap.** Moving a chapter between arcs, or reordering, edits only `outline.json`. Nothing is renamed or moved on disk.
- **New story flow:** "New story" asks for a single book or a series, a name, and a world: none (the default), a new one, or an existing one. The world can be linked, changed or unlinked any time.
- **Safe writes:** every save writes a temp file, then renames it over the original, so a crash never leaves a half-written file.

### Story types (as built, after 7)

Not every story is a multi-book epic with a full world. The same files serve every size; the app shows only what a story uses.

- **A single book** is a series with one volume and `kind: "book"` in `series.json` (old files read as series). The shelf shows it as a book ("Book · 12,400 words") and opening it goes straight to writing; the breadcrumb is just the book and the chapter, and renaming the book renames its volume (and back). "Add a volume (make it a series)" on the shelf, or making a second volume anywhere (an import, say), turns it into a series; a series with at most one volume can be shown as a single book again.
- **Short stories:** a book with one chapter opens with the binder out of the way (the rail still opens it).
- **Collections:** each book can choose its own chapter headings for exports and Royal Road copies ("Arrival" instead of "Chapter 1: Arrival"), from the writing view's ⋯ menu or the Export dialog; it is kept in the volume's settings. Settings → Import & export holds the default for books that haven't chosen.
- **Worlds are optional.** A story has none by default. "World: …" on the series page header, in a story's right-click menu on the shelf, and in a book's ⋯ menu picks a world, none, or makes one. Unlinking removes only the link; the world stays on the shelf. With no world, no world parts appear anywhere (no World switch, no world panel, no capture menu).
- **Smaller worlds:** each world can turn off its map, its people board, and its timeline with the time scrubber (World ⋯ → Parts of this world; `features` in `world.json`). Off, they leave no trace in its views; nothing in the world is deleted, and turning them back on shows everything again.

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

**As built in 5:**

- **Split screen** puts writing (left) and the world (right) side by side in one window: the ⫽ button by the Write/World switch, or Ctrl/Cmd+\ (again to close). Drag the divider to resize (double-click resets); the size is remembered on this device. Each side has a slim tab with its name, Pop out (⧉) and Close (✕). Beside the world, the writing pane starts with the binder closed so the page has room, and page margins shrink with a narrow sheet.
- **Tear-off windows:** drag a pane's tab out of the window (or Pop out) to open it in a window of its own at the same place, where it was let go (`#pane=…` in the window's address). The drag follows the pointer (not the browser's drag-and-drop, which on Linux doesn't say where a drag ended); a hint says what letting go will do. The torn-off window's tab has **Dock**, which puts it back beside the main window's view and closes the window; a torn-off tab dragged onto the main window docks too. Closing the main window closes its torn-off windows, and they reopen where they were on the next start. Window positions and sizes are remembered (device-only, in the app's data folder).
- **Internal links:** Ctrl/Cmd+click a linked name (or "Open in World" on its card) shows the entry in a torn-off window of that world if one is open, otherwise beside the page (opening the split). Middle-click peeks at it in a new window. The Write/World switch still swaps the whole view.
- **Narrow panes:** each view lays itself out by its own width (container queries), not the screen's. Under about 980px headers wrap instead of squeezing, side lists narrow, the pin bar and tray go under the map (the page scrolls, so the map keeps its size) and the scrubber's moment takes its own line; under about 640px the world's sections become a strip across the top.
- **Shortcuts follow the pane being worked in** (the last one clicked or focused, marked by an accent line under its tab): F3, find, focus mode, quick add, undo, back/forward each act there only.
- **Live across windows:** every window hears every change. A chapter (and an entry's page text) is edited in **one place at a time**: a second window or pane showing it gets it read-only, updating as the other place saves, with "This chapter is being edited in another window or pane… Edit here". Edit here asks the other place to save and stop first (it then shows the note), so no words are lost; a window that doesn't answer within 4 seconds loses the edit anyway. The main process keeps who-edits-what (`docLeases`); a closed window frees everything it held.

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

**As built in 6:**

- **Import from Word…** is on the series page header and in the writing view's volume menu (⋯). The file is read in the main process (mammoth; images are dropped, with a note) and nothing is created until Import is pressed; the Word file is never changed.
- **The preview** lists the proposed chapters: include checkbox, title, Chapter/Interlude, word count and first line. Split at: headings and "Chapter …" lines (default), headings only, lines only, or don't split. Chapter lines are "Chapter 3", "Ch. 3: Title", "Chapter Twenty-One", "Chapter IV", and Prologue/Epilogue/Interlude/Foreword/Afterword; a heading or line becomes the title (so "Chapter 1: Arrival" is titled "Arrival") and isn't kept as text. Whatever comes before the first chapter is its own piece, unticked when it's under 40 words (a title page). Fix-ups: Join to previous, Split… (Split here at any paragraph), rename, change type, untick.
- **Destination:** a new volume (named after the file) or the end of an existing one. Bold, italic, underline, strikethrough, lists and quotes come through; paragraphs that are only "* * *", "#", "⁂" and the like become scene breaks.
- **Export…** (volume menu, series page volume menu, binder chapter menu, palette) writes Word, PDF, EPUB or Markdown for the whole volume, one chapter, or chosen chapters. Chapter numbers always follow the whole volume, so exporting chapter 2 alone still says "Chapter 2". Every file is written with the safe write.
- **How exports look** lives in Settings → Import & export (and in the dialog): author for the title page, chapter headings (number and title, number only, title only), the scene-break mark, spaced or indented paragraphs, and the PDF paper size (A4, Letter, 6×9 in). Books have a title page and each chapter starts on a new page.
- **PDF** is printed by a hidden window with scripts off, from a temporary file. **EPUB** is EPUB 3 with a table of contents (and an EPUB 2 NCX for older readers).
- **Copy for Royal Road** (binder chapter menu, volume menu, palette) puts the chapter on the clipboard as plain HTML with no fonts or colours (bold, italic, centred scene breaks) plus plain text, so it pastes cleanly into Royal Road's editor.

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

### As built in 4d

- **One timeline.** Eras and events are placed on it from their page ("When": before the story, or during a chapter) or from the When lens's **Timeline** view (now its default). History before the story is ordered (drag, or ↑/↓; the order is a number between neighbours, so moving one rewrites only that entry); events during a chapter share that chapter's moment. Eras run from where they start to the next era. The placement is stored in the entry as `when`; nothing is stored about chapters.
- **Moments:** each chapter, event and era is a stop; "now" is the latest chapter. Facts, relationships and map versions anchored to an event take effect at that event's place on the timeline; an event not on the timeline still counts as already true.
- **The time scrubber** sits above the map, the board and the timeline: era bands, event diamonds, chapter ticks and "now" at the end. It defaults to now, isn't remembered between visits, and is hidden until the world has chapters, eras or events. Moving it (drag, or arrow keys) changes everything in World mode: who is where, territory colours, statuses and other facts, relationships on the board, entry pages ("As of Ch 8 · Back to now") and their hover cards. Play steps through the story stop by stop and stops at now. The writing side still shows facts as of the chapter being written.
- **Moving people:** drag a portrait on the map to another place. That records "in Saltmere from Ch 8" at the scrubber's moment (from the latest chapter at now); a move recorded at the same moment replaces the earlier one. Dropping from the unplaced tray works the same way. A new relationship made on the board starts at the scrubber's moment. A relationship with an end is solid until then and dashed after (before 4d it was dashed throughout).
- **Trails and animation:** someone who moved at this moment or the one before has a faint dashed trail from where they were; portraits glide to their new place. Off with "Movement trails and animations" (Settings → World); gliding also stops in lighter mode and with the system's reduced motion.
- **Event pins:** events with a "Where" show as diamonds above that place once they have happened (the one at the current moment filled in); click opens the event.
- **Map versions:** on an event, "The map changes here…" makes a new version of a map from that event on: redraw its borders (a copy of the map as it was just before) or upload a new image (regions and pins scaled to it). The version is its own map file (`versionOf`, `from`). The map shows the version in effect at the moment, with a note; edit tools change only the version shown. Removing a map removes its versions; a version can be removed on its own. What's nearby uses each map's latest version. Places keep their identity across versions; a place that splits gets new places with "Formerly part of" (a new place field, shown in reverse as "Became").
- **Text forms:** an era's or event's text says "When: before the story (2 of 5)" or "during Ch 3"; the digest ends with the timeline in order, with places, and lists what isn't placed.
- **Settings → World:** the time scrubber can be turned off (the world as it stands now), and trails and animations separately.

### As built in 4e

- **Skins are data.** A skin is a JSON file in `skins/` (its words, and art tokens set as `--skin-*` properties) plus a CSS file of art scoped to `[data-skin="<id>"]`. A theme names its skin (`"skin": "fantasy"`). Layout and data are the same in every skin; a new skin is new art and words.
- **Three themes with full skins**, added now because the skins need them: **Fantasy** (parchment, inked double borders, engraved Cinzel capitals, sepia map with inked region borders, pages unfurl in), **Cyberpunk** (near-black and navy, hot pink and acid green, Share Tech Mono in caps, neon wireframe regions with glow, a grid with scanlines, a glitch as views change), **Arcade** (black cabinet with deep reds, Press Start 2P lettering, pixel borders with hard shadows, a pixel-grid background and pixelated map, a blinking cursor). Every other theme uses the clean default skin in its own colours. Fonts are bundled (OFL) so they work offline.
- **Words:** Where / Who / When / How / Inbox / World / Now become Atlas / Folk / Chronicle / Lore / Scribe’s tray / Realm / This day (Fantasy); Grid / NETDB / Logs / Protocols / Buffer / Net / Live (Cyberpunk); Stages / Players / Replays / Unlocked / Loot / Game / Continue (Arcade). The plain word stays as a tooltip, and the command palette shows both ("Atlas (Where)"). Template names and settings stay plain.
- **Settings → World:** World skin **Full** (art, frames, fonts, map styling, transitions), **Plain** (the skin's fonts and map styling, no art or transitions) or **Minimal** (the clean default layout in the theme's colours); **Themed words** on or off.
- **The writing page is never skinned:** skin styles apply inside World mode only, and the page keeps the theme's readable writing font. (The theme's colours and UI font still apply to the app around it.)
- **Lighter mode** drops skin textures, glows, shadows and filters; it and the system's reduced-motion setting stop skin animations.
- **Contrast is tested** for every theme: body text, the page and button text at least 4.5:1 (the page 7:1), muted text at least 3:1.

World skins are described under Themes; the AI side of the world (readable by AI, "Update the worldbuilding", AI questions) under AI layer. Build order: milestones 4a–4e.

- **Ownership rule:** World mode edits world files; Write mode edits chapter files. Each file has one writer, so the two modes never fight over a file.

## Sync engine

Sync is per file and local-first: the local copy is the truth, the cloud is a mailbox, and no file with unsynced local changes is ever overwritten. This fixes the previous version's two failures: everything synced as one large blob (which stalled and errored), and reconnecting pulled the cloud copy over newer local work.

**What syncs, and how**

| Tier | Examples | Rule |
| --- | --- | --- |
| Device-only | Window layout, split sizes, recent files, trash, doodles, sign-in tokens | Never synced |
| Derived | Search index, AI summaries, caches | Never synced; rebuilt locally |
| Settings | Themes, page, AI settings, keys | Never synced, except the personal dictionary (see Settings sync) |
| Content | Chapters, outlines, world entries, maps | Automatic, per file |
| History | Snapshots | Upload-only; pulled only on restore |

**Per-file tracking.** For each file, sync remembers its base: the hash both sides last agreed on. A file whose hash differs from its base has changed here. There is no separate queue: comparing hashes with the bases *is* the outbox, so it survives going offline, closing the app and crashes, and can always be rebuilt.

**Manifests.** Each sync unit (a series folder, a volume, a world) has a small manifest in the cloud of its files and hashes. One listing of the manifests shows which units changed; sync transfers only changed files, usually a single chapter.

**The pull rule** (this is what prevents lost work):

| Cloud changed? | Local changed? | Action |
| --- | --- | --- |
| Yes | No | Download the cloud version |
| No | Yes | Upload the local version |
| Yes | Yes | Keep both: save a conflict copy, show a quiet notice, never overwrite |
| No | No | Nothing |

**Conditional uploads.** A unit's manifest is replaced only if it is still the version this device last saw (R2's conditional write, checked by the storage itself). Otherwise the upload is refused and sync looks again: what changed there is compared file by file, and a file changed on both sides is a conflict.

**Deletions.** A deletion syncs as a marker. Every device moves its own copy into its own local trash rather than erasing it, so nothing is lost on any machine.

**Writing never waits.** Sync runs in the main process in the background; the editor never blocks on the network.

**Sync must prove itself.** Build an automated test harness alongside the engine, not after: two simulated devices editing the same and different files, the network cut mid-upload, the app killed mid-save, then reconnecting. The test passes only if no words are ever lost.

**As built in 7 (lean):**

- **No server code.** The app talks to the R2 bucket directly with the S3 API (signed requests, a few hundred lines, no SDK). R2's conditional writes (`If-Match`, `If-None-Match`) do the job a Worker and a D1 table would have. Connecting checks that the storage refuses a second "only if new" write, and won't start without it.
- **In the bucket** (under `library/`): `units/<unit>.json`, one manifest per unit (each file's hash, `null` once deleted, who changed it and when); `blobs/<sha256>`, each file's contents gzipped and named by its hash, so stored once and never changed (images are uploaded once even when renamed); `history/<volume>/<chapter>/<snapshot>.json.gz`.
- **On this computer** (`.ember-local/sync/`): per unit, the manifest last seen and each file's base; a cache of file hashes (by size, time and inode) so unchanged files aren't re-read. Losing either costs a careful re-check, never words: files that differ then count as changed on both sides, and both versions are kept.
- **When:** 2 seconds after the app opens, when a window comes back into focus, 30 seconds after writing pauses (at most 2 minutes while writing nonstop), every 5 minutes, and once more on quit (up to 8 seconds; anything left goes next time). An idle check is one listing request. Offline, it retries after 30 s, 1, 2 then 5 minutes.
- **Both changed:** a chapter or a world entry from the other computer becomes a copy beside this one, named "Arrival (copy from Mac, 2026-11-03 14:05)" (a chapter appears at the end of the volume; an entry's copy has no aliases), with a notice. Other files (outline, board, settings of a world) keep this computer's version and the other one is saved under `.ember-local/sync/conflicts/`; the outline mends itself (chapters on disk but not in it appear at the end).
- **Deleted elsewhere:** chapters, entries, maps, volumes, series and worlds go to this computer's Trash and can be restored (which syncs them back). A file edited here after being deleted there is kept and uploaded again, and the other way round. A deleted series takes its volumes only if none changed here.
- **An open chapter updates:** before sync writes the other computer's version of a chapter or entry that's open, the editor saves and pauses (the document lease), the old version is kept in history ("before an update from another computer"), and the page reloads and carries on. Text typed in that moment is never overwritten: it becomes a conflict instead.
- **History:** the last version of each chapter per finished day goes up; the History panel's "Get versions from the cloud" brings the other computer's into the list.
- **Settings → Sync: one token.** "Open Cloudflare" opens Cloudflare's token page already filled in (R2 edit permission, named for the app); the writer signs in, presses Create Token and pastes it. The app finds the account, makes its own bucket (`<app>-library`; it never uses a bucket holding anything else, and leaves other buckets alone), and works out the storage keys from the token (key id = the token's id, secret = SHA-256 of the token). The next computer pastes the same token and finds the same bucket. A bucket made by hand still works (folded away: address, key id, secret). If both the cloud and this library already hold work, it asks before putting them together. The key is kept with the system's secure storage (Electron safeStorage) where there is one. Status bar: "Synced", "3 changes to sync", "Syncing…", "Offline, 3 changes saved locally" or "Sync problem".
- **The harness** (`src/main/sync/sync.test.ts`): two computers make 120 random steps each run (edits of the same and different chapters, deletions, syncs with dropped requests and lost replies, the app killed mid-apply, typing while a download lands, restarts), then must agree exactly, and every version not replaced or deleted by the user must still exist. Planting either of two bugs (overwrite on conflict; skip the "changed meanwhile" check) makes it fail. Real libraries are tested too (`library.test.ts`), and the whole app end to end with two instances against an S3-like server.
- **Not built (lean):** clean-up of old blobs in the cloud (a year of writing is tens of MB of the 10 GB free); live sync while typing; merging two edits of one chapter.

### Sync audit (Nov 2026)

**Syncs automatically:** series (`series.json`, cover, saved AI conversations in `ai/`), volumes (`volume.json` with goals, chapter-heading choice and Finished; `outline.json`; every chapter; cover), worlds (`world.json` with pins and which parts are on; every entry; images; maps; relationships; templates; inbox; turned-down suggestions; board layout; relationship types), the personal dictionary, and one version per chapter per finished day of History (fetched on request).

**Never syncs:** `library.json`; the device folder (sync records, History newer than a day, Trash, set-aside conflicts, hash cache); app settings (theme, page, analysis, status bar, world display, export style, AI choice); keys and logins (Cloudflare token, ChatGPT login); window layout and the library's location; small view choices kept in the window (panel open, split size, pin bar, Rhythm/Echo, recent entries).

**Weak spots, and what 10c did about them:**
1. ~~A file other than a chapter or an entry changed on both computers kept this computer's version and set the other aside with only a notice.~~ Fixed (10c): the two are combined, from the version both last agreed on (fetched from the cloud; without it nothing counts as deleted). Lists of things with ids merge item by item (outline chapters and arcs, map regions and pins, templates, relationship types); records merge key by key (the board, settings files); lists of names merge as sets; a chapter moved to two places is listed once. AI conversations: the one that went further wins (with a rename from the other); continued differently on each, they become two conversations. Where both changed the same value, this computer's is kept and the other version goes to **Settings → Sync → Conflicts**, where it can be put back (the version it replaces is set aside in turn) or deleted. Chapters and entries still become copies side by side; images are set aside.
2. ~~The inbox is one file.~~ Fixed (10c): one file per item in `inbox/`. The old `inbox.json` is still read, and moved item by item (each written before the old file goes) the first time the inbox changes; a damaged one is reported and left alone.
3. ~~Map, board and template editors aren't paused while sync writes those files.~~ Fixed (10c): while sync puts the other computer's map, board, templates or relationship types in place, the world screen dims with "Updating from your other computer…" and reloads after. Each world view carries `syncGen`; saves send it back, and one made from a version sync replaced is refused ("This just changed on your other computer…") instead of undoing the other computer's change.
4. The dictionary's "latest change wins" uses each computer's clock.
5. A world's manifest lists every file and is uploaded whole on each change to that world: fine at today's size, about 300 KB a change at 2,000 entries. Split it per folder if worlds get that big.
6. Sync runs only while the app is open; quitting sends what's left (up to 8 seconds).
7. Not yet run against real Cloudflare for weeks; the harness and end-to-end runs use stand-ins.

## Smart Storage

**Measured after sync (Nov 2026): 20 MB, of which about 19 MB is images; all the writing and history is under 1 MB.** Compressing old volumes' text would save almost nothing yet, so the first steps go at what actually grows (below); Smart Storage itself was then dropped (Nov 2026): not needed. What matters is that old work never moves: **reading never writes.** Opening, scrolling or searching an old volume changes no file, so sync sends nothing for it until something in it is actually edited (tested in `storyTypes.test.ts`, and checked end to end).

**As built (space, before Smart Storage):**

- **Cloud clean-up:** once a week, each computer deletes blobs in the cloud that no manifest points at and that are over a month old (a month covers any computer partway through an upload; history copies are never touched). Re-using an old blob (say, after an undo back to old text) writes it again so it counts as new. The same pass repairs: a manifest pointing at a missing blob gets it uploaded again from a matching local file. A damaged manifest stops the pass with nothing deleted.
- **Sizes:** Settings → Library shows the library's size on this computer (writing and world notes, images, version history, trash, sync records); Settings → Sync shows its size in the cloud.
- **Finished books keep less history:** "Finished (keep less history)" in a volume's ⋯ menu (writing view) or its menu on the series page. Its chapters then keep everything from the last 2 weeks, one version a week back to 3 months, then one a month; applied at once when switched on. Off by default.

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

**As built (8, Nov 2026): only the personal dictionary syncs.** Settings stay on each computer (theme, page width, paper, status bar, analysis, world display, export style): they aren't writing, and screens differ. A word added to (or removed from) the dictionary on one computer is added (or removed) on the others at the next sync; `library/dictionary.json` in the cloud holds each word with when it last changed, and the latest change wins. When keys arrive (AI, ElevenLabs), each computer is set up on its own; nothing secret goes to the cloud.

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

**As built in 10a (local AI, Ollama):**

- **Off by default.** Settings → AI: "Use AI", the Ollama address (default `http://127.0.0.1:11434`), the model (default: the first one installed), and a live check ("✓ Ollama is running, with 3 models" or what's wrong and how to fix it: install Ollama, `ollama pull llama3.2`). AI settings stay on each computer. Off, nothing about AI appears anywhere.
- **The AI panel** (✦ on the writing view's rail, or the palette): Chat, Brainstorm, Ask the story, each its own conversation for the session. A chip says what it reads: the selection if there is one, else what's on screen; "Whole chapter" reads all of it (a chapter over 2,500 words is read in parts and summarised first). The world entries named in that text go with it (up to 6, as their text forms); "Ask the story" also gets the world digest and is told to answer only from what it's given. Answers stream in and can be stopped. Nothing in the chapter changes.
- **Main owns the AI:** one service in the main process (`src/main/ai`) talks to Ollama's API (installed models, streamed chat, JSON mode); windows send requests over IPC and get tokens back as events.
- **ChatGPT, signed in directly (10b):** "Answers from" in Settings → AI picks Ollama or ChatGPT. "Continue with ChatGPT" is Sign in with ChatGPT: OpenAI's sign-in page opens in the browser (OAuth with PKCE, the public client ChatGPT plans are used through) and comes back to a one-time address on this computer (`127.0.0.1:1455`). The login is kept on this computer only (`chatgpt.json` in the app's data folder, encrypted with the system's secure storage where there is one), refreshed when it runs out, and removed on Sign out. Answers come from the same service Codex uses (`chatgpt.com/backend-api/codex/responses`, streamed, `store: false`), on the plan's allowance: no API key, nothing to install. Grammar asks for JSON with a schema. Shows the account and plan, a model choice (from the service's list), and Sign out.
- **Saved conversations:** every Chat, Brainstorm and Ask conversation is saved with its story (`series/<id>/ai/<conversation>.json`, plain JSON) after each answer, so it syncs to the other computers. "Past conversations" in each tab lists them (title from the first message, when, how long) to reopen and carry on, or delete (moved to this computer's trash folder). Each question notes what the AI read ("what was on screen in “Arrival”, ~400 words"). The last 20 messages go with each new one as the model's memory of the conversation. A stopped answer keeps what had come.
- **The AI pane (replaces the side panel):** ✦ on the writing view's rail (or the palette) opens the AI beside the page as a pane, with the same divider as the world (drag it as wide as you like), a tab with Pop out (its own window, say on a second screen) and Close. Popped out, it asks the writing window what's on screen (through the main process). Wide, the conversation list runs down its left side (all tabs, newest first, with + New); narrow, ☰ slides it in. Answers are formatted (headings, lists, bold, quotes, code; drawn from parsed data, never raw HTML), in a readable column with Copy and Reply to this. Highlighting any part of an answer pops up "Reply to this": the reply goes with that part quoted. While an answer streams, the view follows it only if you're at the bottom; scroll up and it stays where you are.
- **Edit chapter (built; replaced the grammar check):** an **Edit chapter** box in the AI pane (or ⋯ → Edit with AI, or the palette, which tick it and fill in "Fix the spelling, grammar and punctuation."). Ticked, what you type is an instruction for the open chapter: fixes, "add the scene above where they reach the harbour", anything. A "before AI edit" version goes into History; the chapter goes to the AI as Markdown (paragraphs, headings, scene breaks, bold, italic, strike, underline, quotes, lists) with the conversation so far and the world's names; the whole edited chapter comes back as Markdown (no JSON), streamed ("Editing the chapter… 1,200 words written"). Blocks that came back unchanged keep their original nodes exactly (fonts, colours, alignment); changed and new ones are rebuilt from the Markdown. If the chapter changed while the AI worked, nothing is put in. The edit goes in as one undoable step, then a side by side: before on the left, after on the right, every change marked by the app (spelling and punctuation green, changed wording and new text amber), a warning if the chapter got much shorter. Undo this (per changed place), Undo all, or Keep; Keep saves an "after AI edit" version. Works beside the page (not in a popped-out AI window). The outcome is noted in the conversation.
- **Time limits:** every AI request gives up after a stretch of silence (ChatGPT 2 minutes, Ollama 5, which can be loading a model) and says so; a long answer that keeps arriving is fine.
- **Edit chapter and Update the world stay separate, but connected (agreed).** They change different things (prose vs world entries), suit different reviews (side by side vs a list of small suggestions in the Inbox) and happen at different times (edits while writing, the world once a chapter is done). After **Keep** on a chapter edit, a small offer: **Update the world from this chapter?** Either can also be asked for in words in the AI pane, and each runs its own review. Both share the same safety pieces: a time limit on every request with the AI's real error shown, a copy saved before anything changes, and every change worked out by the app rather than taken from the AI. Build order: Edit chapter first (it replaces the grammar check), then Update the world on the same pieces.
- **Not built yet (rest of 10):** the per-feature provider choice, continuity checks, the chapter-so-far summary for on-screen reads, and the world side below.

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

#### As built (10d)

- **Where it starts:** "Update the world" in the AI pane's header (the open chapter), the ⋯ menu and the command palette ("Update the world from this chapter (AI)"), and an offer in the AI pane after an Edit chapter is kept. Only with AI on and a world linked; otherwise no trace.
- **The pipeline** (`src/main/ai/worldUpdate.ts`): the app finds the entries named in the chapter (the name matcher) and sends their text forms with the fields each can take, the names of everything else, and the writer's earlier answers. The AI answers one JSON shape: summary, new things (person, place, faction, creature, event, system), facts, relationships, continuity and questions, each with the line it comes from. Ollama reads 1,500 words at a time (JSON mode), ChatGPT 12,000; part summaries are combined. The app checks everything: names resolve to entries (and aliases), fields to the entry's template (by label or id; link fields must name an entry), relationship types to the world's; quotes must be in the chapter (else dropped); a continuity note without a real quote is dropped; anything already in the world (same fact, same relationship, a known name) isn't suggested; limits of 30 suggestions, 10 notes, 3 questions. No lookup tools: the app does the lookups itself, which works with every model.
- **The inbox:** items now have a kind (captured, suggestion, continuity, question), the line they came from, and for suggestions the change itself. Reading a chapter again replaces what it found there before (captured lines are never touched). **Accept** makes the change from that chapter on (a new entry with its one-line note; a fact value with `from` the chapter; a relationship starting at the chapter) and keeps the line as a quote; one Undo takes it back out and returns the item. "Not this" and "Fine as it is" let items go (Undo returns them). **Questions** take an answer, kept in `answers/<id>.json` in the world (synced), told to the AI from then on, and never asked again.
- **Summaries:** kept per chapter in the volume (`summaries/<chapter-id>.json`, synced), with the hash of the chapter text they were made from, so a changed chapter shows as out of date.
- **Ask the whole story:** the AI pane's "Reads" choice (selection or screen, whole chapter, whole story). The whole story sends every chapter's summary in order plus the world digest; chapters without a current summary are summarised first ("Summarising chapters… 2 of 5") and kept.
- **Where you left off:** opening a story after 8 hours away shows the summaries of the last three chapters up to the open one, in a card that closes. Made from summaries already kept: nothing goes to the AI. Shown only when there are some.
- **The AI makes the changes itself** (the default; Settings → AI → "Only suggest them" goes back to accepting each). New things are made first, then the chapter's answer is checked again so facts and relationships can name them. Each change is listed in the inbox under **Done by the AI** with **Undo**, which takes back exactly what it added (the fact value and its quote, the relationship, or the entry it made, which goes to the trash); anything the writer changed since stays. "They look right: clear the list" clears it (Undo brings the list back). Continuity notes and questions still wait for the writer. Reading a chapter again keeps the list of what was done.
- **New names sorted by the AI:** with the AI on, the name catcher's list has **Sort these with the AI** (in the background): each name becomes an entry of the kind the AI decides, or is set aside as not a name (real holidays and festivals, days, months, titles on their own); all listed under Done by the AI. "Accept all from this chapter" (one kind for all) is hidden while the AI is on.
- **AI work runs in the background** (`src/main/ai/jobs.ts`): asking, editing and updating the world run in the main process, not in the AI pane. Closing the pane, switching chapters or going to the world doesn't stop or lose anything: the conversation is saved there (the question at once, the answer when it comes, or what came if stopped), and reopening the pane picks up a running job (it carries on streaming) or a finished one (an edit is then put in and shown side by side, if the chapter is still as it was sent). When work finishes, the window that asked shows a notice wherever the writer is ("The AI has answered", "The AI's edit of … is ready", "Read …: 3 suggestions…") with **Open the AI** or **Open the inbox**.
- **Open the inbox** (from the AI's note and the notice) opens the world at its inbox beside the page.
- **The test world** (`src/main/ai/testing/testWorld.ts`): three chapters and what each should produce. The normal tests run it with a scripted model (everything found, nothing extra); `npm run ai:eval` runs it against your Ollama (`AI_EVAL_MODEL` to pick one) and prints what it found, missed and added.


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

A theme is an identity, not a colour scheme. Most carry a **world skin** (see below) that dresses World mode and gives it the theme's own words. Built so far (milestone 13 was brought forward):

- **Everyday:** Light, Dark (defaults) and High Contrast (pure black and white, yellow accents, thick focus outlines). No skin.
- **With a world skin (21):**

| Theme | The feel | Signature touch |
| --- | --- | --- |
| Fantasy | Parchment, inked borders, engraved capitals | Sepia map with inked region borders; pages unfurl in |
| Cyberpunk | Near-black and navy, hot pink and acid green, techy mono | Neon wireframe regions with glow; glitch transitions |
| Arcade | Black cabinet, deep reds, pixel lettering | Pixel borders, pixel-grid map, blinking cursor |
| Storybook | Watercolour picture book, rounded lettering | Drop capital on every page; pages turn in |
| Magic Academy | A school spellbook at night, gold leaf | Lenses as house banners; a wax seal on every page |
| Noir | Black and white, typewriter, rain | The people board as a corkboard with string and pins; greyscale pictures |
| Isekai | The game system of another world | Entry pages as status windows (quick facts as stats); [System] notices |
| Comic Book | Halftone dots, thick ink, hard shadows | Titles in caption boxes; notices in speech bubbles; WHAM! |
| Blueprint | A drafting sheet, hand-lettered | Cyanotype maps; dimension lines; a title block on every page |
| ’90s Desktop | Grey windows on a teal desktop | Bevelled buttons; every lens and entry is a window with a title bar |
| Lo-fi Study | A rainy night in a lamp-lit room | Lined notebook pages; quick facts on sticky notes |
| Deep Space | A starship's bridge | HUD corner brackets; the map as a nav display; a T+ mission clock |
| Gothic Horror | A manor at midnight, blackletter in blood red | A flickering candle glow; portraits in oval cameos; ornate double frames |
| Steampunk | Brass, riveted copper, Victorian display type | Riveted brass plates; the scrubber as a brass gauge whose gear turns during playback |
| Wasteland | After the end: concrete, rust, stencil lettering | Hazard-stripe headers; a dusty, radiation-tinted map |
| Y2K Aero | Early-2000s glass and aqua sky | Glossy glass panels and shiny pill buttons; views float up like bubbles |
| Tarot | Gold on midnight among the stars | Entries as tarot cards with a name plate; chapters on the scrubber as moon phases; views turn like a drawn card |
| Atomic Age | 1950s pulp sci-fi: cream, turquoise, atomic orange | Boomerang-cornered panels, starbursts on titles, an orbiting atom |
| Trading Card | A collectible card game | Entries as cards with a shimmering holographic rarity border; quick facts as stat boxes; views are dealt in |
| Wild West | Weathered wood, saloon type | Entries as WANTED posters; rope borders on the map and board |
| Circus | Under the big top | Tent stripes, titles in blinking marquee bulbs, notices as ADMIT ONE ticket stubs, views bounce in |

- **Later:** more can be added as files. ('90s Desktop and High Contrast from the original list are done; the "starter set" of colour themes was replaced by the identity themes above.)

**World skins.** World mode should feel like the story. Each skinned theme carries:

- Frames, typography, map styling, transitions (the art: a CSS file scoped to the skin) and a **vocabulary** (a JSON file).
- Same layout and data underneath; a new skin is new art and words, not new code.
- **The writing page stays readable in every skin.** Immersion lives in World mode and the surrounding app.
- The vocabulary renames the sections, the built-in kinds of things and the Cast groups. Hovering a themed word shows the plain one; settings stay plain; a template you rename yourself keeps your name. Themed words can be turned off (Settings → World), and the skin can be Full, Plain or Minimal.

**Vocabulary** (in order: Where · Who · When · How · Inbox, then World and Now; Continent · Kingdom · City · District · Landmark · Wilds; Person · Faction · Family · Creature; Era · Event; Magic · Religion · Law · Technology · Custom; Cast groups: In the story · Waiting in the wings · Gone quiet · Left the story):

- **Fantasy:** Atlas · Folk · Chronicle · Lore · Scribe’s tray; Realm, This day. Land · Kingdom · City · Quarter · Wonder · Wilds; Hero · Order · House · Beast; Age · Legend; Arcana · Faith · Decree · Craft · Tradition. In the tale · Yet to arrive · Lost to the road · Fallen.
- **Cyberpunk:** Grid · NETDB · Logs · Protocols · Buffer; Net, Live. Sector · Zone · Sprawl · Block · Hotspot · Badlands; Runner · Corp · Clan · Bioform; Cycle · Incident; Netrunning · Cult · Policy · Chrome · Street code. Online · Queued · Ghosted · Flatlined.
- **Arcade:** Stages · Players · Replays · Unlocked · Loot; Game, Continue. World · Zone · Town · Area · Checkpoint · Bonus stage; Player · Guild · Team · Monster; Level · Cutscene; Power-up · Shrine · Rules · Gadget · Easter egg. Playing · Insert coin · Idle · Game over.
- **Storybook:** Kingdoms · Characters · Once Upon a Time · Enchantments · Bookmarks; Storyland, This page. Faraway land · Kingdom · Village · Lane · Enchanted place · Dark wood; Character · Company · Family · Talking beast; Long ago · Happening; Spell · Belief · Royal rule · Contraption · Tradition. On the page · Not yet in the tale · Fallen asleep · Happily ever after.
- **Magic Academy:** Grounds · Roster · Terms · Spells · Owl post; Academy, This term. Realm · Province · Town · Wing · Tower · Forbidden forest; Mage · House · Bloodline · Familiar; Age · Occurrence; Spell · Order · School rule · Artifact · Tradition. In class · Not yet enrolled · Absent · Departed.
- **Noir:** Scenes · Suspects · Case Log · Methods · Leads; The City, Tonight. Coast · State · City · Precinct · Joint · Outskirts; Person of interest · Mob · Family · Stray; Years · Case; Racket · Church · Law · Gear · Code. On the case · Unknown · Gone cold · Off the books.
- **Isekai:** Map · Party · Quest Log · Skills · Notifications; Other World, Current Quest. Continent · Kingdom · Town · Ward · Dungeon · Field; Adventurer · Guild · Clan · Monster; Age · Quest; Skill · Faith · System rule · Item · Custom. Active · Not yet met · Inactive · Fallen.
- **Comic Book:** Locations · Heroes & Villains · Issues · Powers · Fan Mail; Universe, This Issue. Dimension · Nation · City · Block · Hideout · Badlands; Character · Team · Dynasty · Monster; Age · Showdown; Power · Cult · Code · Gadget · Tradition. In this issue · Not yet introduced · On hiatus · Killed off.
- **Blueprint:** Site Plans · Personnel · Revisions · Specs · Drafts; Project, Current Rev. Region · Territory · Site · Sector · Structure · Undeveloped land; Staff · Department · Household · Specimen; Phase · Milestone; Process · Doctrine · Regulation · Component · Standard. Active · Pending · Inactive · Decommissioned.
- **’90s Desktop:** Explorer · Contacts · History · Control Panel · Clipboard; My Computer, Today. Drive · Folder · Subfolder · Directory · Shortcut · Unsorted; User · Workgroup · User group · Virus; Version · System event; Program · Protocol · Policy · Hardware · Preference. Online · Not installed · Idle · In the Recycle Bin.
- **Lo-fi Study:** Wanderings · Friends · Diary · Notes · Sticky Notes; Notebook, Tonight. Somewhere far · Country · Town · Neighbourhood · Favourite spot · Outdoors; Friend · Crowd · Family · Pet; Season · Memory; Little magic · Belief · House rule · Gadget · Habit. Around · Haven’t met yet · Haven’t heard from · Moved away.
- **Deep Space:** Star Charts · Crew · Mission Log · Tech · Transmissions; Starship, Stardate. Sector · System · Station · Deck · Outpost · Uncharted space; Crew member · Fleet · Lineage · Lifeform; Epoch · Mission; Psionics · Creed · Directive · Tech · Protocol. On board · In transit · Lost signal · Lost in space.
- **Gothic Horror:** Haunts · Souls · Omens · Rites · Whispers; Manor, Midnight. Cursed land · Dominion · Town · Parish · Crypt · Moors; Soul · Coven · Bloodline · Abomination; Dark age · Omen; Curse · Faith · Pact · Contraption · Rite. Among the living · Not yet risen · Vanished · Laid to rest.
- **Steampunk:** Charts · Registry · Ledger · Mechanisms · Telegrams; Empire, Present hour. Territory · Nation · Metropolis · Borough · Monument · Frontier; Citizen · Guild · Household · Automaton; Epoch · Incident; Aether · Creed · Statute · Invention · Custom. In service · Expected · Unaccounted for · Retired.
- **Wasteland:** Zones · Survivors · Before & After · Scrap · Radio; The Wastes, Today. Wasteland · Territory · Settlement · Sector · Ruin · Dead zone; Survivor · Gang · Clan · Mutant; Age · Incident; Anomaly · Cult · Code · Scrap tech · Ritual. Alive · Not yet found · Gone silent · Didn’t make it.
- **Y2K Aero:** Explore · Buddies · Archive · Plugins · Messages; The Web, Online now. Region · Country · City · Neighborhood · Hotspot · Outdoors; Buddy · Network · Family · Digipet; Season · Update; Feature · Fandom · Terms · Gadget · Trend. Online · Pending invite · Away · Signed off.
- **Tarot:** Realms · Figures · Readings · Arcana · Draws; The Arcana, The Present. Sphere · Dominion · City · House · Tower · Moonlit wilds; Figure · Court · Lineage · Beast; Cycle · Turning; Arcana · Faith · Decree · Instrument · Rite. In the spread · Yet to be drawn · Face down · Passed beyond.
- **Atomic Age:** Destinations · Personalities · Newsreels · Science · Mailbag; The Future, This Week. Hemisphere · Nation · Metropolis · Sector · Launch site · Proving grounds; Personality · Agency · Family · Alien; Decade · Headline; Atomic power · Faith · Regulation · Gizmo · Etiquette. On the air · Coming soon · Off the air · Cancelled.
- **Trading Card:** Lands · Champions · Expansions · Abilities · Pulls; Collection, Current set. Realm · Kingdom · Stronghold · Outpost · Shrine · Wildlands; Champion · Faction · House · Creature; Edition · Event card; Spell · Order · Ruling · Artifact · House rule. In play · In the deck · Benched · Graveyard.
- **Wild West:** Territory · Wanted · Tall Tales · The Code · Saddlebag; The Frontier, High noon. The West · Territory · Town · Side of town · Watering hole · Open range; Drifter · Gang · Family · Critter; Days · Shootout; Folk magic · Faith · The Law · Iron · Frontier way. In town · Riding in · Rode off · Boot Hill.
- **Circus:** Fairgrounds · Performers · Programme · Acts · Ticket booth; The Big Top, Showtime. Circuit · Country · Tour stop · Midway · Attraction · Back lot; Performer · Troupe · Family · Beast; Season · Show; Illusion · Superstition · Ringmaster’s rule · Rigging · Tradition. In the ring · Backstage · Off the bill · Final bow.

All fonts are bundled (OFL or Apache licensed), so themes work offline. Every theme's contrast is tested (text and buttons at least 4.5:1, the page 7:1, muted text 3:1). Settings lists themes in two groups: Everyday, and With a world skin.

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
5. **Layout:** split screen, tear-off windows, live updates across windows. (Done.)
6. **Import and export:** .docx import with preview; DOCX, PDF, EPUB, Markdown and Royal Road export. (Done.)
7. **Sync engine:** Cloudflare R2 with step-by-step setup instructions; manifests, pull rule, conditional uploads, conflict copies, and the failure test harness. Ship only when the harness passes. (Done, lean: no Worker, no D1, no SQLite.)
7b. **Story types:** single books, short stories and collections, worlds optional and unlinkable, smaller worlds. (Done; see Story types.)
8. **Settings sync:** only the personal dictionary syncs; everything else stays per computer. (Done. Smart Storage dropped: not needed.)
9. **World extras:** nothing left here; maps moved to 4b and time (the timeline) to 4d.
10. **AI layer** (in steps):
   - **10a: Chat.** Provider interface, Ollama, reading scope, brainstorm and chat pane, saved conversations. (Done.)
   - **10b: ChatGPT and Edit chapter.** Sign in with ChatGPT; Edit chapter with compare and per-change undo; time limits. (Done.)
   - **10c: Sync ready for the world AI.** (Done.) The inbox as one file per item; merge where possible (inbox and conversations by item, chapter order by chapter) and a Conflicts list to see and restore set-aside versions; pause the map, board and template screens while sync writes them. (Sync audit weak spots 1 to 3.)
   - **10d: Update the world.** (Done; see As built (10d).) Lookup tools, the "Update the worldbuilding" pipeline into the inbox, offered after Keep in Edit chapter and on demand; AI questions to the inbox; the test world. The same read of a chapter also:
     - saves a **chapter summary** (a few sentences, kept with the chapter's volume and synced), which makes possible **Ask the whole story** (questions answered across every chapter's summary, pointing to the chapter) and **Where did I leave off** (a short recap of the last few chapters when opening one after a break);
     - runs a **continuity check**: anything that contradicts the world (an eye colour that changed, someone in two places at once, the dead talking) goes to the inbox with its quote. Nothing changes by itself.
   - **10e: AI extras.** (Done.) The AI's feedback rules (from the cut companion): opinions only when asked, every problem with a specific fix, one new angle on pushback then drop it, a continuity slip mentioned once, at most one example line. One-click prompts above the AI's message box (Beta read, Pacing, What happens next?, Names that fit), plus the writer's own (Settings → AI, one per line); each sends at once with the "Reads" choice. ⋯ menu and palette: Write a blurb (three, in different tones), Write a synopsis, Write a Royal Road description (with tags); each opens the AI and sends it reading the whole story (summaries; missing ones made first). "Keep the world up to date by itself" (Settings → AI, off by default, `src/main/ai/autoWorld.ts`): a chapter that changed is read for the world 3 minutes after it was last changed, one at a time, only if its summary is out of date; quiet unless there's a question or something that may not fit. Not planned: autocomplete or "continue writing for me".
11. **Voice** (optional module, off by default; replaces the companion, which was cut: too fiddly, and voices for a character never sound right). Uses **VoiceStudio** (github.com/debpalash/voicestudio, a local ElevenLabs alternative) when it's there; it's only talked to, never bundled (AGPL).
   - **11a (done): who says what, the audiobook script, reading aloud with the computer's voices.**
     - Settings → Voice: on/off, the computer's voice and speed, "Try it".
     - **Who says what** (`src/main/ai/speakers.ts`, `src/shared/voice/script.ts`): the app splits each chapter into narration and quoted lines itself (a quote left open carries into the next paragraph; a line split by a tag is two quotes); the AI is asked one narrow question: who says each numbered line, and who tells the chapter if it's first person. Names match world entries (and aliases); "narrator" means the first-person narrator; unknown stays unknown. Kept per chapter in the volume (`speakers/<chapter-id>.json`, synced, with the text it was made from), so it's only redone for chapters that changed.
     - **The narrator:** first person → the chapter's POV character (the writer's POV wins; if the AI reads it as someone else, that's flagged in the inbox and nothing changes; with no POV set, the AI's narrator); third person → "Narrator". Different narrators per chapter follow the POV.
     - **Audiobook script for VoiceStudio** (⋯ menu and palette: this chapter, or the book/volume; a background job, then a save dialog): `# Ch 1: Title`, every line tagged (`[voice:Ashley] “Are you serious?”`) so it reads the same whether a tag carries on or not, narration tagged with the narrator, lines it can't place `[voice:Other]`, `[pause 1s]` at scene breaks, text tidied (line breaks inside a paragraph are not stops). In VoiceStudio's Audiobook page each name gets a voice in its Cast. (Its audiobook mode doesn't breathe between sentences; the normal mode does.)
     - **Read aloud from here** (⋯ menu and palette): the computer's voice, paragraph by paragraph from the cursor, the paragraph highlighted (an editor decoration), a short pause at scene breaks, Pause/Resume/Stop.
   - **11b (done): VoiceStudio live** (`src/main/voice/`). Found at `http://127.0.0.1:3900` (its `/.well-known/voicestudio-speech`), or another address + key in Settings → Voice (another computer on the home network, so the Intel Mac can use the Linux computer's). Talked to over its MCP endpoint (`/mcp/`, Streamable HTTP: initialize, then `tools/call`): `list_voices` → `[{id, name, type, personality}]`; `generate_speech` with `text`, `profile_id`, `speed`, `steps` (8 fast / 16 balanced / 32 best: Settings → Voice → Quality), `format: 'wav'` → base64 WAV (or an `audio_url`). Dictation: `POST /v1/audio/transcriptions` (OpenAI-style form).
     - **Voices for this story…** (⋯ menu): a VoiceStudio voice for the narrator, for anyone else, and per character (the world's people), kept with the story (`series.json` `voices`, synced; by voice name, so it works on any computer whose VoiceStudio has the same voices).
     - **Read aloud from here** uses VoiceStudio when it's running (else the computer's voice): who says what from the AI's marking (made first if needed); passages planned in `src/shared/voice/passages.ts` (same voice runs together, cut at sentence ends up to ~350 characters, the first short; no pause inside a voice, a breath between voices, a longer pause at scene breaks); text sent with plain punctuation (`forSpeech`: curly quotes, dashes and ellipsis characters make it stumble) and a language (Settings default `en`). Speech is made in order from where reading starts, only while the player is open; **playing waits until enough is made to go straight through** (`readyToPlay`, from how fast it's actually going, with a 15% margin; "Preparing… starting in about N seconds"), then the passages play back to back with their silent ends trimmed; if it still falls behind it says "Preparing…" and never skips. Speech made is kept on this computer (`.ember-local/voice-cache`), so reading again is instant and an edit only re-makes what changed.
     - **Dictate (VoiceStudio)** (⋯ menu): listens until "Stop and write it down", then inserts at the cursor; "quote … end quote" become quote marks; capitalised near-misses of the world's names are fixed ("Bran Ock" → Brannoch); the world's names are also passed to VoiceStudio as words to expect. Without VoiceStudio, the Mac's own dictation (Fn twice).
     - **Who's speaking in this chapter…** (⋯ menu, with the AI on): every line of dialogue with the narration just before it and who says it; change any. Fixes are kept in the chapter's marking (`fixed`), win over the AI's, and survive the chapter being marked again after edits.
     - **▶ Try** next to each voice in "Voices for this story…" (a short sample line), so a broken voice shows before a chapter (some cloned voices come out as noise: re-clone from a clean 10–30 s sample, or design one).
     - **Redo that bit** on the player: the passage playing is made again (it comes out differently each time) and replayed. **Language it speaks** in Settings → Voice (English by default; or each voice's own).
     - Still to do: making the audiobook from the app (VoiceStudio's audiobook route isn't in its API yet: the script export covers it); talking to the AI pane by voice (maybe).
12. *(Merged into 11.)*
12. **Layout round** (after the voice leftovers; the writer's list, Nov 2026):
   - The Settings gear only shows in the writing view; it should be reachable everywhere (bookshelf, World mode, the AI pane).
   - The ⋯ menu is getting cluttered (export, import, voice ×5, AI ×6, headings, Finished): group it (submenus like "AI ▸", "Voice ▸", "Export & import ▸") or move some to better places.
   - The status bar: items added later appear on the right instead of the left.
   - The people board: dragging portraits isn't smooth.
   - (More to come from the writer.)
12b. **From the audit** (`docs/audit-2026-11.md`; the writer agreed to all the broken and clutter items, and these additions):
   - **Manuscript view** (the writer's choice: **fully editable**): the whole book (or volume) as one continuous document, the **cover as page zero**, then a title page, chapter titles as headings the way a printed book shows them (the export heading settings), scene breaks. Typing anywhere edits that chapter: each chapter is its own section with a locked boundary (a heading can't be deleted or merged into the next by typing; joining or splitting chapters is the split/merge command), edits save to the right chapter file through the usual autosave, history and leases (a chapter open elsewhere shows read-only here). Opened by a **Manuscript** button, and by clicking the book/volume name above the chapter list in the binder. **Done** (src/renderer/src/manuscript): one ProseMirror document of isolating `chapterSection` nodes; a transaction guard refuses anything that changes the sequence of chapters or touches a read-only one (tested), so Backspace at a chapter's start and a select-all delete leave the chapters in place. Each changed chapter is saved by `chapter:save` (debounced, retried, flushed on close); leases are claimed per chapter, given up on request (shown read-only), and reloaded when changed elsewhere. Picking a chapter in the binder closes it. Laid out as sheets like the page view (same paper size; the cover and the title page are pages too), each chapter starting on a new page (`data-starts-page` blocks in pagination), scrolling inside its own area so the rail, binder and status bar stay put.
   - Chapter **synopsis and notes** (the stored notes shown; synopsis filled from the AI summary when there is one). **Done:** a `synopsis` field on chapters (default '' for old files); the **Synopsis and notes** rail panel edits both for the open chapter, saved as typed (patching only those fields, so the editor's saves never clash); with the AI on, "Write the synopsis with AI" uses the chapter's summary (made now if out of date, `ai:chapterSynopsis`) and fills an empty synopsis, or shows it beside the writer's own with "Use this instead of mine" / "Keep mine".
   - Chapter **status** (draft / revised / done) and colour labels. **Done:** `status` and `label` on chapters (unknown values read as none); set from the binder's right-click menu (Status, Colour label) or the palette ("Mark this chapter as…"); shown in the binder as a coloured dot and a small tag; a status filter (Any / Not done / Draft / Revised / Done) appears once any chapter has a status.
   - **Comments** on the text (highlight a passage, leave a note to self). **Done** (`src/renderer/src/editor/comments.ts`): a `comment` mark carrying its note (id, note, at), so comments move with the text, come back with undo, and save/sync/history with the chapter; exports ignore it; an AI edit keeps them on paragraphs it didn't change. Added from the right-click menu ("Add a comment"), Ctrl/⌘+Alt+M, the palette, or the Comments panel's button; the **Comments** rail panel lists them in reading order (click the passage to show it; the note saves on Enter or clicking away; Resolve removes the highlight, text kept, undoable); the card for the comment under the cursor is highlighted.
   - **Story-wide search and replace** (all volumes). **Done:** the find panel has **This book / Whole story** (shown when a story has more than one volume); results are grouped as "Book › Chapter"; a match in another book opens that book at the match with the search kept (the last search per story survives the switch); Enter steps through every book; Replace all covers every volume, each changed chapter kept in its history first.
   - **Split** a chapter at the cursor, **merge** two, **duplicate** one. **Done:** right-click a chapter in the binder (Split at the cursor, for the open one; Join the next chapter onto this one; Duplicate), the palette, or right-click in the text with no selection ("Split the chapter here"). Split writes the new chapter ("… (part 2)", same arc, right after) before shortening the old one, whose whole text is kept in history (`before-split`). Join asks first, puts a scene break between, appends notes and synopsis, keeps the first one's text in history (`before-merge`) and moves the joined chapter to the trash only after its words are saved in the first. Duplicate copies everything to "… (copy)" right after it.
   - **Backups to a folder** (a zip now and then; sync isn't a backup). **Done** (`src/main/backup.ts`, Settings → Backups): choose a folder (outside the library), then Back up now or automatically every 6 hours / day / week; keep the newest 5–50 (older ones to the system trash). Each backup is `library-backup-<date>-<time>.zip` with everything except this computer's local data folder; written under a hidden `.partial` name, synced to disk and only then renamed, so a failed or interrupted backup leaves nothing that looks complete. Settings are per computer. Restore: unzip and choose the folder in Settings → Library.
   - **Typewriter scrolling** and true **full screen**. **Done:** Typewriter scrolling (Settings → Writing, or the palette; off by default) keeps the line being typed in the middle of the page area while typing or moving with the keys (a click leaves the page where it is), with room below the last line. Full screen (F11 / ⌃⌘F, the View menu, or the palette) fills the screen with just the page (focus mode in the active pane); Esc or the button leaves both.
   - World: a **search box**, **tags** on entries, a **picture gallery** per entry, free **lore pages**, **export the world** (a series bible). **Done (first four):** a search box at the top of World mode's side panel (Ctrl/⌘+F; names, other names, tags, facts and page text, best first; arrows + Enter; `#tag` lists every entry with the tag); **tags** on an entry page (+ tag, suggestions from the world's tags, one of each ignoring case; click one to list the entries with it; kept when entries merge); **Pictures** on an entry page (add or drop images, stored once by hash; captions; open larger with ← →; Use as portrait; Take it off; undoable); a **Lore page** kind (How, no form fields, just the page; every skin has its own word for it).
   - Not wanted: an outline/corkboard view; writing stats and deadline goals.
   - **Book mode** (one of the last things, after the rest; **read-only**): it starts closed, showing **only the cover**; clicking it opens the book to a spread with the **title page on the left and Chapter 1 beginning on the right**, then on as a real open book: two book-sized pages side by side, turned by dragging a page (forward or back) or clicking a bottom corner, with a page-turn animation (skipped in Lighter mode). Built on the Manuscript view's pagination. **Done** (`src/renderer/src/book/`): a **Book** button beside Manuscript (or the palette) opens it over the window; each chapter is laid out in 2:3 book-sized CSS columns (one column = one page, every chapter from a new page), title page = page 0; spread −1 is the closed cover (centred), spread s shows pages 2s and 2s+1; a turn is a **page curl** (`book/curl.ts`): the corner held (top or bottom) follows the pointer, kept within reach of the spine; the fold is the perpendicular bisector between the corner and the pointer; the part beyond it is shown from the back (the next page) reflected across the fold, with shadows along the crease and under the lifted part; turns are animated with requestAnimationFrame (not CSS transitions, whose end event never came when a drag ended exactly at the start or the end, which used to jam turning); click the cover or a bottom corner, drag a page past a quarter, or ← → / PageUp / PageDown / Home / End; Go to chapter…; page numbers; no animation in Lighter mode or with reduced motion; Esc closes.
13. **Themes:** done early (after 4e): High Contrast and eighteen more skinned themes (see Themes). ~~Left for later: the faint glow on the active line in Cyberpunk.~~ Done: the paragraph with the cursor gets `active-block` (`editor/activeBlock.ts`); Cyberpunk gives it a faint neon text glow while the page has focus.
14. **Remaining modules:** publishing, author's notes. (Doodle pad and relationship web cut, Nov 2026: the pad isn't needed and the people board already is the web.) **Done: publishing and author's notes**, per story and off by default (⋯ → This book, or the palette; no trace when off; `series.modules`). Author's notes: before/after notes on each chapter (Royal Road's two boxes) in the Synopsis & notes panel under "For readers", each with Copy; never part of the chapter text or exports. Publishing: each chapter Posted (date, link) or Scheduled (date) or not; a **Publishing** rail panel lists every chapter of the story (all volumes) with a summary (posted and last date, scheduled and next date, written but not posted yet, how many of those are marked Done); the binder shows a small posted/scheduled marker and has a Publishing submenu (Posted today / Scheduled / Not posted). **World export done:** World mode ⋯ or the palette → a PDF series bible (`src/main/export/worldBible.ts`): title page, contents, then Where/Who/When/How with each entry's portrait, kind, other names, tags, facts (links by name), page, relationships and pictures with captions.

15. **Speed** (Nov 2026): a second full audit on a big test library (90 chapters, about 196,000 words, a world of 300 entries) with every screen and request timed: `docs/audit-2026-11b.md`. The refactoring plan to make everything answer within about a tenth of a second: `docs/speed-plan.md` (run the built app and package it; a speed log; keep worlds and story text in memory and send changes instead of reloads; load screens when first opened; per-paragraph work while typing; incremental Manuscript and Book layout; long lists and pictures; plus the audit's fixes).

16. **Writer requests** (Nov 2026), done:
    - **More than one POV per chapter.** A chapter keeps a list of POVs (chips in the chapter's POV box). Scene headings that name a person ("Mara", "Mara interlude", "Mara's POV") count too: the binder shows every POV, its filter matches any, and the world's POV lists include them.
    - **Test scenes.** Alternate takes, practice, cut text: ordinary chapter files listed under `tests` in the outline (with the chapter they're kept with), not in the reading order. They save, sync, keep history and count toward words; the Manuscript, Book mode and exports leave them out; the world and find read them. In the binder under their chapter; drag one onto the page to put its text in (it goes to the trash, with Undo); right-click selected text → Move to a test scene.
    - **The AI never answers blind.** Whatever it reads, it first looks up the question: chapter summaries that touch it, the world entries it names, then passages of the story itself; the answer is marked "Looked at …". Brainstorming also reads the two chapters before. "Whole story, word for word" sends the story as written, or reads it in parts keeping running notes when it's too long for the model. Files can be attached to a conversation (📎: .txt, .md, .docx, .html): their text stays on this computer (the library's local folder), the conversation and a note of the file sync.

17. **AI characters, rebuilt** (Nov 2026). The first attempt's ten "role" profiles, evidence pickers and 52-rule style list are replaced (they're in git history). The Roundtable stays, with its cast drawn from the new characters plus the five genre specialists. Now, in `src/shared/ai/personas/`:
    - **Ten brainstorming partners** (Nora, Theo, Iris, Max, Ruth, Sam, Dev, June, Gus, Kit). All run the same full feedback checklist; only taste, opinions, a stated bias and voice differ. No backstories.
    - **Ten guest stars**, AI portrayals of real creators (Harmon, Tarantino, Rifujin na Magonote, Natsume, Houser, Hirsch, MacFarlane, King, McCarthy, Akutami): their own lens, "strong at" and "lighter on". Picking one as the main AI shows a notice the first time.
    - **Second opinion** under any answer: the same question to another character or a specialist.
    - **Ten specialists** (Roundtable and second opinions only, never the main AI): five genres (Fantasy, Science Fiction, Horror, Mystery, Comedy) and five crafts (Interpersonal, Inner Monologue, Pacing, Tension, Hooks & Endings). Each looks only at its own area and says so briefly when there is nothing to fix there.
    - **A short anti-slop list** with bad → plain examples, for every character. Prompts are about a third the size they were.

18. **The AI asks questions** (Nov 2026). When asked to ("Ask me questions", or in its own words), or when it truly needs to know something, the AI plans its questions first and sends them as one block. The panel shows them one at a time ("Question 4 of 20"): ready answers only where they help, one maybe marked recommended with its reason (only when the story gives one), always a box for your own answer, Skip, and "That's enough". The answers go back in one message and the AI sums up what was decided, what's strong and weak (with fixes) and anything that contradicts the story. Progress is saved in the conversation. `src/shared/ai/questions.ts`, `QuestionFlow.tsx`.

19. **Guest stars from real material; the writer as a guest star; adaptive characters** (Nov 2026).
    - Guest cards can hold what the person has said matters (from their books and interviews), a few short real quotes with sources, how they come across when they talk, true stories from their public record, and a whole example answer. Guest stars may talk about their real lives as publicly known, never invented. All ten rebuilt this way (King, Harmon, Tarantino and Rifujin tested on the same scene with the writer; Natsume, Houser, Hirsch, MacFarlane, McCarthy and Akutami built from research, to be checked in use).
    - **George G. Baker**, the writer's own pen name, as an eleventh guest star: built from the writer's own creative profile, prose samples, real messages and two answers they wrote for it. Told to think independently, push back, and never act as the authority on the writer's work.
    - **Adaptive characters** (Settings → AI, off by default): a character marked adaptive learns as you talk. George learns the writer's lasting creative views from their own messages (one small extra request after a longer message; never story facts). Learned notes go into his instructions, are listed in Settings to delete, and sync between computers the same way as the dictionary. Later, the writer's own story characters can be marked adaptive too.

20. **Roundtable fixes** (Nov 2026): a time limit (when 70% is used, the rest of the debate is skipped so it still ends with final proposals and a vote; an estimate shows before starting); the Figurehead writes a neutral summary after the vote (agreements, splits and why, ideas worth keeping) beside everyone's own proposals; Save boxes on the summary and each final proposal start a normal chat with your partner holding the picks; open phases shuffle the speaking order; the phase instructions are rewritten plainly. The Figurehead's mid-debate interruptions are gone; the briefing, the private reconsideration, both discussions and up to 12 seats stay. Only your partner sits at the table, with the specialists and guest stars.

21. **Story characters** (Nov 2026): talk to your own characters. They live in Settings → AI → "Your story characters" (pick a world and a person); the same section also sits at the bottom of a person's world page (AI on only): make the card with AI from the page and the chapters they appear in (shown to edit before it saves), copy the blank template to fill with any AI, or paste a filled one (answers may sit after the label or on the lines under it, in bold, as headings or as list items). The card is plain labelled text, one file per character in the world (`ai-characters/`), so it syncs with the world. They show under "Your characters" in the AI picker and in Second opinion. How they answer follows the question: about the work ("what do you think of this chapter") they answer as a reader of their own story; to them ("why did you…") they answer from inside it; unclear means the work. They know the story only up to the chapter you have open, for every reading scope and for what they've learned. With Adaptive characters on, each one named in a chapter picks up a few notes when the world is updated from it (listed on the page, each deletable). Not in the Roundtable yet.

22. **AI on the page** (Nov 2026; the writer's choice of what to build: 1 now, 2 next, 3 explained, no AI-written scenes).
    - **AI on a selection (done):** right-click selected text on the page → **AI ▸** (only with the AI on, only in the page's text): Fix spelling and grammar (shown with what changed struck out and highlighted), Other ways to say it (three), Tighten (two), Loosen (two), Better word (for up to four words: up to eight that fit the sentence), In a character's voice… (pick one of your story characters; a short note on what fits, and two rewrites closer to them). Results show in a small box by the selection; **Use** puts one in place as one undoable step, only if the text there hasn't changed; Esc or × leaves the page alone; Try again asks again. The AI sees the selection with some text either side. `src/shared/ai/selection.ts` (prompts and a forgiving reader of the reply), `ai:selection`, `SelectionAiBox`.
    - **AI notes on a chapter (done):** Comments panel → "AI notes on this chapter" (also ⋯ → AI and the palette). The AI reads the chapter as it is now, in parts of about 1,200 words, with what the world says about whoever is named and the earlier chapters' summaries, and notes only real problems: continuity, unclear bits (who's speaking, who "she" is), slips (tense or POV, a name spelled two ways, sitting down twice) and accidental repeats; never taste, praise or rewrites. Each note becomes a comment marked as the AI's (blue, dotted, "AI note", Dismiss) on the exact words it quotes; notes whose words aren't there are dropped. A new read replaces the AI's old notes and leaves the writer's own comments alone; Clear AI notes takes them all off. The text itself never changes. **With the AI off they leave no trace:** no button, not listed, no underline, no tooltip. `src/shared/ai/pageNotes.ts`, `aiNotesTr` in `editor/comments.ts`, `ai:pageNotes`.
    - **Find by describing it (done):** Find panel → **Words / Describe it** (the switch only shows with the AI on). Describe a scene in your own words ("where Josh lies to Sara about the van"); the AI picks up to three likely chapters from their summaries and the passages that share words with the description (every chapter when there are 60 or fewer, else the 40 sharing the most), then finds the paragraph in each. Results show the chapter, the paragraph's opening and why it fits; clicking one opens the chapter at that paragraph (or at its top if it can't be pinned down). Chapters not yet read for the world have no summary, so they're found only by their words, and the panel says how many. `src/shared/ai/findScene.ts`, `ai:findScene`.
    - **Loose threads tracker:** proposed (AI suggests threads to the inbox, the writer accepts; the writer can start one by hand; trial on 10–15 chapters first). The writer isn't convinced yet. **Voice check across the book:** not wanted for now.
    - **Not doing:** "What could happen next?" (the writer builds ideas out in the AI pane) and AI-written scenes.
