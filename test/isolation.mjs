// Prove DSH_SILT_HOME isolates writes from the real ledger.
//
//   node test/isolation.mjs
//
// 會用一個臨時目錄當家，往裡面寫記憶與設定，然後確認真帳本一個 byte 都沒變。
// 這是給「測 store 的寫入路徑」用的 —— 沒有這個開關，測試會污染本人的記憶。
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL = join(homedir(), '.dsh', 'silt', 'ledger.jsonl')
const realBefore = existsSync(REAL) ? readFileSync(REAL, 'utf8').length : -1

// Simulate the plugin resolving its home with the override set.
const sandbox = mkdtempSync(join(tmpdir(), 'silt-test-'))
process.env.DSH_SILT_HOME = sandbox

const { Store } = await import(new URL('../lib/store.js', import.meta.url).href)

// Mirror index.js: env override wins.
const home = process.env.DSH_SILT_HOME || REAL.replace(/\\ledger\.jsonl$/, '')
console.log('sandbox home:', home)
console.log('is sandbox:', home === sandbox)

const s = new Store(home).load()
s.cfg = { ...s.cfg, enabled: true }

// These all write.
s.tuneInjection({ injectBudget: 2000 }, { reason: 'test', actor: 'model' })
const r = s.writeMemory(
  { tier: 3, title: '測試條目', body: '這是測試寫入的內容', domain: 'other', dims: ['personality'] },
  { actor: 'model', sessionId: 'test-session', callId: 'test-call' },
)
console.log('remember ok:', r.ok)

const sandboxLedger = join(sandbox, 'ledger.jsonl')
console.log('sandbox ledger created:', existsSync(sandboxLedger))
console.log('sandbox records:', readFileSync(sandboxLedger, 'utf8').split('\n').filter(Boolean).length)

const realAfter = existsSync(REAL) ? readFileSync(REAL, 'utf8').length : -1
console.log('\nreal ledger size before:', realBefore)
console.log('real ledger size after :', realAfter)
const untouched = realBefore === realAfter
console.log('REAL LEDGER UNTOUCHED:', untouched)

rmSync(sandbox, { recursive: true, force: true })
console.log('sandbox cleaned up')
process.exit(untouched ? 0 : 1)
