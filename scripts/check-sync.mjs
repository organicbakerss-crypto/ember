/**
 * Checks what a Cloudflare token can see, for sync problems. Prints account
 * ids, bucket names and whether each account's storage address answers.
 * Never prints the token. Usage: node scripts/check-sync.mjs  (it asks for the token)
 */
import tls from 'node:tls'
import { createInterface } from 'node:readline/promises'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const token = (process.env.CF_TOKEN ?? (await rl.question('Paste the Cloudflare token: '))).trim()
rl.close()
const api = async (path, headers = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  })
  return res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }))
}
const say = (...a) => console.log(...a)
const errs = (r) => (r.errors ?? []).map((e) => `${e.code ?? ''} ${e.message}`).join('; ')

const handshake = (host) =>
  new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      resolve(`ok (${s.getProtocol()})`)
      s.end()
    })
    s.on('error', (e) => resolve(`FAILED: ${e.code ?? ''} ${e.message.split('\n')[0]}`))
    s.on('timeout', () => {
      resolve('FAILED: timed out')
      s.destroy()
    })
  })

const verify = await api('/user/tokens/verify')
say('user token check:', verify.success ? `ok, status ${verify.result.status}` : errs(verify))
const accounts = await api('/accounts')
if (!accounts.success) {
  say('accounts:', errs(accounts))
  process.exit(1)
}
say(`accounts: ${accounts.result.length}`)
for (const a of accounts.result) {
  say(`\naccount "${a.name}"  id=${a.id}  (id length ${a.id.length})`)
  if (!verify.success) {
    const v = await api(`/accounts/${a.id}/tokens/verify`)
    say('  account token check:', v.success ? 'ok' : errs(v))
  }
  for (const j of ['default', 'eu', 'fedramp']) {
    const b = await api(
      `/accounts/${a.id}/r2/buckets`,
      j === 'default' ? {} : { 'cf-r2-jurisdiction': j },
    )
    say(
      `  buckets (${j}):`,
      b.success
        ? b.result.buckets.map((x) => `${x.name} [${x.location ?? '?'}]`).join(', ') || '(none)'
        : errs(b),
    )
  }
  for (const host of [`${a.id}.r2.cloudflarestorage.com`, `${a.id}.eu.r2.cloudflarestorage.com`]) {
    say(`  storage address ${host}:`, await handshake(host))
  }
}
say(`\nnode ${process.version}`)
