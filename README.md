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
- **World core:**
  - World mode with your own categories (section templates) and entries (sections, aliases, linked entries)
  - appearances in chapters
  - linked names with hover cards and Ctrl/Cmd+click
  - quick add from selected text
  - POV linked to characters

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
