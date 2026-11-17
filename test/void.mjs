// After voiding a memory: does it still reach the prompt, or silt_unseen, or recall?
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-void-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const s = new Store(process.env.DSH_SILT_HOME).load()
s.cfg = { ...s.cfg, enabled: true, injectBudget: 2000 }

const keep = s.writeMemory(
  { tier: 1, title: '有效的事實', body: '這條沒被作廢', domain: 'person', dims: ['background'] },
  { actor: 'model', sessionId: 'x', callId: 'c' },
).memory

const gone = s.writeMemory(
  { tier: 1, title: '要被作廢的事實', body: '這條會被作廢掉', domain: 'person', dims: ['background'] },
  { actor: 'model', sessionId: 'x', callId: 'c' },
).memory

console.log('before void: injection mentions it?', s.injectionText().includes('要被作廢的事實'))

const v = s.voidMemory(gone.id, { reason: '本人說記錯了', actor: 'model' })
console.log('void ok:', v.ok)
console.log('content untouched:', s.memories.get(gone.id).body === '這條會被作廢掉')
console.log('voided flag:', s.memories.get(gone.id).voided)

const text = s.injectionText()
console.log('\n1) prompt')
console.log('       contains voided title :', text.includes('要被作廢的事實'))
console.log('       contains kept title   :', text.includes('有效的事實'))
ok(!text.includes('要被作廢的事實'), 'voided memory is NOT in the prompt')
ok(text.includes('有效的事實'), 'non-voided memory IS in the prompt')

console.log('\n2) silt_unseen')
s.injectionText()
const u = s.unseenTitles({ page: 0, pageSize: 40, shownIds: s.runtime.shownIds || [] })
const titles = u.titles.map((t) => t.title)
console.log('       total:', u.total, '| unseen:', u.unseen, '| titles:', titles)
ok(!titles.some((t) => t.includes('要被作廢')), 'voided memory is NOT in silt_unseen')
ok(u.total === 1, 'only the kept one counts as active')

console.log('\n3) silt_recall (default) — by design it still finds it, flagged voided')
{
  // 作廢是「我當時知道的是這樣，後來發現不是」，不是「這件事沒發生過」。
  // 所以 recall 照樣搜得到，只是帶著 voided: true —— 模型看得出這條已經被推翻。
  const hits = s.recall({ query: '作廢', limit: 10, sessionId: 'q' })
  const found = hits.find((h) => h.title.includes('要被作廢'))
  console.log('       hits:', hits.map((h) => h.title))
  console.log('       voided flag on the voided one:', found?.voided)
  ok(Boolean(found), 'still findable by default search')
  ok(found?.voided === true, 'and carries voided: true')
  const kept = hits.find((h) => h.title.includes('有效的事實'))
  ok(kept && !kept.voided, 'the live one is not flagged')
}

console.log('\n4) silt_recall with includeArchived (should find it, flagged)')
const all = s.recall({ query: '作廢', limit: 10, includeArchived: true, sessionId: 'q2' })
const found = all.find((h) => h.title.includes('要被作廢'))
console.log('       found:', Boolean(found), '| voided flag:', found?.voided)
ok(Boolean(found), 'still findable when explicitly asking for archived')
ok(found?.voided === true, 'and it is flagged voided: true')

console.log('\n5) the ledger still has the original content')
const led = s.records.filter((r) => r.kind === 'memory.void')
ok(led.length === 1, 'one memory.void record written')
ok(led[0].payload.snapshot?.before?.body === '這條會被作廢掉', 'ledger keeps the original body')

rmSync(process.env.DSH_SILT_HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
