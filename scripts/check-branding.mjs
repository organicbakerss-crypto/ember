#!/usr/bin/env node
/**
 * Light branding rule: the app's name lives only in app.config.ts.
 *
 * Reads the current name from the config (so this keeps working after a
 * rename) and fails if it appears in any other code or config file.
 * Markdown docs are exempt; they talk about the app by name.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = 'app.config.ts'
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const SKIP_FILES = new Set([CONFIG, 'package-lock.json'])
const SKIP_EXTENSIONS = new Set(['.md', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.webp'])

const config = readFileSync(join(root, CONFIG), 'utf8')
const name = /^\s*name:\s*'([^']+)'/m.exec(config)?.[1]
if (!name) {
  console.error(`Could not find the app name in ${CONFIG}.`)
  process.exit(2)
}

// Matches the name as a word or at the start of an identifier (".<name>-local",
// "<name>Store"), but not inside a longer ordinary word.
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pattern = new RegExp(`(?<![a-z])${escaped}`, 'i')
const hits = []

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full)
      continue
    }
    const rel = relative(root, full)
    if (SKIP_FILES.has(rel) || SKIP_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
  }
}
walk(root)

if (hits.length) {
  console.error(`"${name}" appears outside ${CONFIG}. Read it from the config instead:\n`)
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
console.log(`Branding OK: "${name}" only appears in ${CONFIG}.`)
