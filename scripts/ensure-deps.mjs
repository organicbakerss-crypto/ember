// Runs before `npm run dev` and `npm start`: if any package the app lists is
// missing, or not the version package-lock.json pins (say, after a
// `git pull` that added a font), runs `npm install` first. When everything
// is already installed it does nothing, so launching stays quick.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

const pkg = read(join(root, 'package.json'))
const lock = existsSync(join(root, 'package-lock.json'))
  ? read(join(root, 'package-lock.json'))
  : { packages: {} }

const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
const stale = names.filter((name) => {
  const installed = join(root, 'node_modules', name, 'package.json')
  if (!existsSync(installed)) return true
  const wanted = lock.packages?.[`node_modules/${name}`]?.version
  return wanted !== undefined && read(installed).version !== wanted
})

if (stale.length) {
  const shown = stale.slice(0, 5).join(', ') + (stale.length > 5 ? ', …' : '')
  console.log(`New or updated packages (${shown}): running npm install…`)
  const result = spawnSync('npm', ['install'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error('npm install failed. Fix the error above, then run npm run dev again.')
    process.exit(result.status ?? 1)
  }
}
