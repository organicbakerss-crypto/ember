# Working on this repo

Read `PLAN.md` before starting a milestone. Its ground rules are hard constraints:

- **Core stays basic.** Optional modules are off by default and leave no trace in the UI when off.
- **Never lose words.** Every disk write goes through `writeFileAtomic` / `writeJsonFile`.
  Unreadable files are reported, never overwritten or deleted. Nothing (sync, AI, import)
  replaces user text without the user seeing it first.
- **Light branding.** The app name lives only in `app.config.ts`; `npm run check:branding`
  enforces it. No name in component names, CSS classes, file formats or storage keys.
- **Plain data.** Library files are plain JSON with a `formatVersion`; schemas are loose so
  unknown fields survive a save.
- **Main owns disk, network and AI.** Renderer code is views only and talks to main through
  the typed contract in `src/shared/ipc.ts` (inputs validated with zod in main).

Conventions:

- Run `npm run check` before committing (typecheck, lint, prettier, branding, tests).
- New IPC request: add its input schema to `ipcInputs` and result type to `IpcResults`,
  then a handler in `src/main/ipc.ts`. TypeScript will fail until all three exist.
- Writes to one sync unit (a volume or a world) go through the library's `KeyedLock`.
- Test file-layer changes with crash/corruption cases, not only the happy path.
