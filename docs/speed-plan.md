# Speed plan: making everything snappy

**Goal:** everything a writer does answers within about a tenth of a second, and typing never waits. This must hold on a big library, not a toy one. The measurements behind this plan are in `docs/audit-2026-11b.md`.

## Targets

There are two test libraries, and both are checked in the **built** app after every round. A change that breaks a target doesn't go in.

- **Big:** 90 chapters, about 196,000 words, a world of 300 entries.
- **Stress:** 30 books, 750 chapters, **2.84 million words**, and a world of 1,000 entries. One book is a size ladder of single chapters of 500, 1k, 2k, 5k, 10k, 20k, 30k, 50k and 100k words.

**The rule:**

- What a writer waits for may depend on what's **on screen**. It must not depend on how long the chapter is, or how big the library is.
- Whole-chapter and whole-library work happens once and is then kept up to date piece by piece, or runs in the background without ever freezing the screen.

| Action                                                   | Today (built, stress library)             | Target                          |
| -------------------------------------------------------- | ----------------------------------------- | ------------------------------- |
| Start → bookshelf                                        | 2.0 s                                     | < 1 s                           |
| Bookshelf after a new chapter, rename or move            | rebuilt in 1.1 s (re-reads every chapter) | < 20 ms                         |
| Open a chapter, 2k / 30k / 100k words                    | 0.11 / 0.6 / 3.1 s                        | < 0.15 s at any size            |
| Screen frozen after opening, 30k / 100k words            | 0.76 / 4.6 s                              | never more than 50 ms at a time |
| Frozen at each pause in typing, 30k / 100k words         | 0.47 / 2.9 s                              | never more than 50 ms           |
| Typing, key → screen (30k / 100k words)                  | 23 / 59 ms median                         | < 16 ms at any size             |
| World beside / World mode (1,000 entries)                | 1.0 s                                     | < 0.2 s                         |
| Any world change shown (save, undo, sync)                | reloads everything                        | < 20 ms                         |
| Find in the whole story (2.84M words)                    | 1.7 s                                     | < 0.3 s                         |
| Name catcher (inbox), AI summaries list, publishing list | 3.4 / 2.2 / 2.3 s                         | < 0.2 s                         |
| Manuscript / Book mode of a 100k-word book               | 6.6 / 6.3 s frozen                        | < 0.3 s, never frozen           |
| Saving a chapter                                         | grows with the book                       | the same at any size            |

**Why bigger chapters are slower (profiled):**

- About 95% of the freeze after opening a long chapter is **page-break layout**. It finds where every line of the whole chapter starts on screen, one line at a time, which costs about 15 ms per 1,000 words.
- It runs twice on opening, and again at every pause in typing.
- Everything else (building the page, word counts, highlights) is under 0.1 s even at 30,000 words.

## 0. Run the real app, not the dev build (first, almost free)

Today the app is run with `npm run dev`, which is 2–3× slower everywhere:

- it loads every screen twice on purpose (React's strict mode);
- it builds code on first use;
- it uses React's slower development version.

The fixes:

- **Package Ember** as a real app: an AppImage or pacman package for Arch, and a `.dmg` for the Intel Mac. It starts from the launcher like any app.
- **Until then, use `npm run build && npm start`**, which runs the built app.
- **Keep `npm run dev` for working on the code only.**

## 1. Measure where it actually is (before changing anything)

- **A speed log.** Every request to the main process and every screen load records how long it took. **Settings → Speed** shows the slowest recent ones, with a "Copy" button to send them over.
- **Why it comes first:** the 10–15 s wait when opening the world beside didn't reproduce here (0.6 s). The log shows exactly what's slow on your own computer and library.
- **A speed check script** (`npm run speed`) builds the big test library and times every action in the table above, in the built app.

## 2. Main process: stop re-reading everything

1. **Keep the world in memory.** Each world's parsed entries, maps, relationships, inbox and board stay loaded once read.
   - A save updates the copy in memory as well as the file.
   - A sync write, or a file changed outside the app, refreshes just that file.
   - Name links (names typed on a page) are worked out per entry, and redone only for entries whose page or a name changed.
   - **Result:** opening the world costs only the time to send it over, not a read of 300+ files.
2. **Send changes, not reloads.** After a save, World mode receives "this entry changed" with the new entry, and patches what it shows. Today it reloads the whole world after every change. Undo, sync and the AI's changes work the same way.
3. **Keep the story's text in memory too.** Per chapter, keep its plain paragraphs, word count and a fingerprint, and refresh only the chapter that was saved. Everything that reads the whole story then reads memory instead of disk:
   - the name catcher;
   - "where does this name appear";
   - AI summaries;
   - the publishing list;
   - word counts on the bookshelf;
   - volume stats;
   - story-wide search.
4. **A bookshelf that doesn't re-read the library.** Word counts per chapter are kept in memory and on disk (with a fingerprint of the file), and refreshed only for the chapter that changed. A new chapter, rename or move then updates the shelf in milliseconds, instead of re-reading all 2.8 million words.
5. **Saves that don't grow with the book.** The manifest (sync's list of files) is updated in memory and written at most once a second, batching several saves into one write. Writing the chapter itself is unchanged and stays crash-safe: the manifest can always be rebuilt from the files, as sync already does when one is missing.
6. **Heavy jobs off the main process.** The name catcher, the world digest for the AI, and exports run in a worker thread, so a long job can't hold up saving or opening things.

## 3. Screens: draw only what's needed, when it's needed

0. **Page breaks that don't freeze (first: this is the long-chapter freeze).**
   - Measure whole paragraphs, one cheap measurement each. Look at individual lines only in the paragraph that crosses the bottom of a page.
   - Lay out the pages on screen first, then the rest in small slices that never block a click or a key.
   - While typing, re-measure only from the changed paragraph onwards, and only up to where the breaks stop moving.
   - Never run the layout twice for one change.
   - **Result:** opening a 100k-word chapter freezes for no more than 50 ms, and pausing while typing freezes for nothing.

1. **Load screens when first opened.** World mode, maps, the board, Book mode, the Manuscript, the AI pane, voice, Settings and the export dialogs each become a separate piece that loads when used. Start-up then loads only the bookshelf and the writing view.
2. **Typing does only the work of the paragraph being typed in.**
   - Word count, scenes, comments and stats update for the changed paragraph only.
   - Whole-chapter updates (the binder's scene list, the comments list) wait until typing pauses.
   - Rhythm/Echo and the linked-name highlights recompute only the changed paragraph.
3. **Switching chapters:**
   - Keep the editor and swap its text instead of building a new one.
   - Show the page first; do the page-break layout and analysis right after, in idle time.
   - Read the next and previous chapters ahead, so switching to them is instant.
4. **Manuscript:**
   - Lay out pages chapter by chapter, only for the chapters on screen and nearby. The rest is done in idle moments, without freezing.
   - Page breaks are measured per chapter and kept, so editing one chapter re-measures only that chapter.
5. **Book mode:**
   - Count pages chapter by chapter in idle moments, starting with the first.
   - Only the four pages a turn can show are drawn, each with only its own page's text (not the whole chapter).
   - "Go to chapter" waits only for the chapters before it.
6. **Long lists draw only the rows on screen:** the Cast cards, the map's "not on the map yet" tray, search results, the binder for very long books, and the inbox.
7. **Pictures at the size they're shown:**
   - Make a small copy of each portrait when it's added (about 128 px), and a screen-sized copy of each map (about 2,000 px).
   - Load the full map only when zooming in.
   - Show a soft "loading" state instead of a grey box.
   - Decode pictures off the main screen thread.
8. **Work out once per change, not on every redraw.** The name index, name matcher, timeline and "last seen" are computed once per version of the world, not on each render.

## 4. Fixes from the audit (alongside)

1. **People board:**
   - a readable starting layout (groups by faction and family, not one ring);
   - filters: only this chapter's people, one faction, or a person and their links;
   - names shown on hover when crowded;
   - zoom.
2. **World search** shows its results over the side panel, without pushing the lenses away, and the sideways scrollbar goes.
3. **One view switch** at the top of the writing view: **Page · Manuscript · Book**. "World beside" is drawn the same size as the other buttons.
4. **When → Not on the timeline yet:** compact rows (name, then "Place…" on hover), drag onto the timeline, and only the first few shown with "Show all".
5. **Entries of an unknown kind** show as "Other kind", not quietly under How.
6. **The map shows a loading state** while it decodes (see 3.7).

## Order of work

1. **Section 3.0** (page breaks that don't freeze): the long-chapter freeze, felt now.
2. **Section 0 and section 1** (the built app, packaging, the speed log and the speed check on both test libraries), so every later round is measured.
3. **Section 2** (memory instead of disk, sending changes). This fixes the world beside, World mode, search, the inbox and saves.
4. **Section 3.1–3.3** (start-up, typing, chapter switching).
5. **Section 3.4–3.5** (Manuscript and Book mode).
6. **Section 3.6–3.8 and section 4** (long lists, pictures, the audit fixes).

After each round: the speed check, the full tests, and a real-app run. Nothing that keeps your words safe changes:

- writes stay atomic;
- unreadable files are reported, not replaced;
- sync keeps its rules.

## Progress

### Round 1 (Nov 2026): non-freezing page breaks, typing, the bookshelf

**What changed:**

- **Page breaks** (`editor/pagination.ts`):
  - **Measuring:** each paragraph gets one measurement. Lines are measured only in the paragraph that crosses a page edge, with one position lookup per page instead of one per line.
  - **While typing:** pages before the changed paragraph are kept. An edit inside one paragraph that doesn't change its height relays nothing.
  - **Slicing:** the work runs in 12 ms slices, with the pages on screen done first.
  - **Running once:** it no longer runs twice on opening (fonts and size changes only trigger it when they really change something).
  - **Safety:** pending cursor moves and keys are read before each update, and an out-of-date layout is never applied.
  - **Checked:** every line sits inside a page after opening, adding and deleting, at 5k and 30k words, the same as before.
- **Typing:** word count, scenes, comments and stats update half a second after typing stops instead of on every key. The word count recounts only the paragraph that changed.
- **Bookshelf:** each chapter's word count is kept while its file is unchanged (same size and time). Files changed by sync are recounted.

**Results** (stress library, built app):

|                                              | Before      | After         |
| -------------------------------------------- | ----------- | ------------- |
| 30k chapter: frozen after opening            | 0.76 s      | 0             |
| 30k chapter: frozen at each pause in typing  | 0.47 s      | 0             |
| 30k / 100k chapter: typing median            | 23 / 59 ms  | 13 / 24 ms    |
| 100k chapter: shown / frozen after opening   | 3.1 / 4.6 s | 0.48 / 0.18 s |
| 100k chapter: frozen at each pause in typing | 2.9 s       | 0.05 s        |
| Manuscript of a 100k-word book: frozen       | 6.6 s       | 0.05 s        |
| Bookshelf list (2.84M words)                 | 1.1 s       | 0.05 s        |
