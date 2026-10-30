# Ember

A personal desktop app for writing novels and building the worlds they live in.
See [PLAN.md](PLAN.md) for the full build plan and ground rules.

**Status:** Milestones 1–4 are done.

- **Foundation:** library file format, main-process file service with safe
  writes, typed IPC.
- **Bookshelf:** series and worlds as covers, series pages, cover images,
  right-click menus, inline renaming, and a local trash with restore.
- **Writing core:**
  - binder with arcs, drag-and-drop and scene jump points
  - the TipTap page editor and autosave (which also runs when a window closes)
  - word counts and goals
  - light and dark themes stored as data files
  - adjustable page width
- **Writing polish:**
  - spellcheck with a personal dictionary
  - find and replace across a volume
  - focus mode
  - version history with preview and restore
  - the command palette (Ctrl/Cmd+K)
  - a Diagnostics panel and a customisable status bar
  - Rhythm and Echo highlights (all computed locally)
- **World, step 4a (pages):**
  - World mode in four lenses (Where, Who, When, How) plus an inbox; no categories to set up
  - entry pages in reading mode: templates, quick facts, facts that change over time, a free-written page, portraits
  - linking by typing names and with `@`; "Linked here" on the other side
  - the Cast view (in the story, waiting in the wings, gone quiet, left the story) and list views
  - the world beside the page (in this chapter; waiting and gone quiet), hover cards as of the current chapter
  - one-click capture from a chapter, and the name catcher (new names, to the inbox)
  - palette search, quick add (Ctrl/Cmd+Alt+N), back/forward, recent and pinned, undo, merge, safe deletes
  - text forms of every entry and a world digest (for AI later)
- **World, step 4b (the map):**
  - import a map image; regions by auto-detect (border lines, land and sea, colour areas), magic wand with preview and add/cut, merge, split and trace (OpenCV.js, local)
  - pins for cities and landmarks, and a pin bar of places not on the map yet, grouped by region
  - regions linked to places; hover for names, click to open; nested maps of places
  - nearby places from touching regions (and sketch roads), on place pages and in the text forms
  - the unplaced tray (drag people onto the map), territory colours, a travel sketch when there's no map
  - settings: map on/off, lighter mode
- **World, step 4c (the people board):**
  - a board of portraits; drag one onto another to link them (type, family kin, words, start/end, over)
  - coloured lines, several types shown as bands, dashed when over, a legend that hides types
  - groups drawn as frames around their members; editable relationship types per world
  - a family tree view and a sortable list; relationships on entry pages and in the text forms
- **World, step 4d (time):**
  - one timeline: eras and events placed before the story or during a chapter; the When lens's Timeline view
  - a time scrubber above the map and board: drag it and the whole world shows that moment; play through the story
  - move people by dragging their portrait at a moment; faint trails and gliding portraits
  - event pins on the map; map versions from an event ("the map changes here")
  - the timeline in the text forms; settings for the scrubber and for trails
- **World, step 4e (skins):**
  - Fantasy, Cyberpunk and Arcade themes, each with a world skin: art, fonts, map styling, transitions and its own words (Atlas / Chronicle / Lore, NETDB / Logs / Protocols, Stages / Players / Unlocked)
  - skins are data files; Settings → World: full, plain or minimal skin, themed words on or off
  - the writing page stays plain and readable in every skin; lighter mode keeps skins cheap

## Requirements

- Node.js 22 or newer and npm
- Arch Linux: `sudo pacman -S nodejs npm`
- macOS: `brew install node`

## Running

```sh
npm install
npm run dev      # start with hot reload
npm run build    # production build into out/
npm start        # run the production build
```

## Checks

```sh
npm run check    # typecheck, lint, format, branding rule, tests
npm test         # tests only
```

## Layout

| Path                | What lives there                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ |
| `app.config.ts`     | The app's name, ID, data folder and URL scheme. The **only** place the name appears. |
| `src/shared/`       | Code used by both sides: file format schemas, IDs, the IPC contract.                 |
| `src/main/`         | Main process. Owns all disk access (and later network and AI).                       |
| `src/main/fs/`      | Safe (atomic) writes, per-unit locking, JSON read/validate.                          |
| `src/main/library/` | The library service: series, volumes, outlines, chapters, worlds.                    |
| `src/preload/`      | The bridge that exposes `window.api` to renderer windows.                            |
| `src/renderer/`     | React UI. Views only: no Node, no direct file access.                                |
| `scripts/`          | Repo tooling (the branding check).                                                   |

## Library format

A library is a folder of plain JSON files, readable without the app:

```
library.json                                  library id and format version
series/<series-id>/series.json                name, linked world, volume order
series/<series-id>/cover.<ext>                optional cover image
series/<series-id>/volumes/<volume-id>/
  volume.json                                 name, settings, goals
  cover.<ext>                                 optional cover image
  outline.json                                arcs and chapter order
  chapters/<chapter-id>.json                  TipTap JSON + type, POV, notes
  manifest.json                               hash of every file (for sync)
worlds/<world-id>/
  world.json  timeline.json  manifest.json   (+ optional cover.<ext>)
  entries/<entry-id>.json
.ember-local/                                 device-only, never synced
```

Every file carries a `formatVersion`. Fields the app doesn't recognise are kept
when it saves, so an older build never strips data written by a newer one.

## Renaming the app

Edit `app.config.ts` and replace the icon. `npm run check:branding` fails if
the name appears anywhere else in code or config.
