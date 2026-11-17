// A T3 that becomes a T2 keeps the date the event happened, not the date it settled.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-t2-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const fresh = () => {
  const s = new Store(process.env.DSH_SILT_HOME + '-' + Math.random().toString(36).slice(2)).load()
  s.cfg = { ...s.cfg, enabled: true }
  return s
}

console.log('1) condensing an old T3 into a T2 keeps the original date')
{
  const s = fresh()
  const w = s.writeMemory(
    { tier: 3, title: '三年前的舊事', body: '這件事發生在很久以前', domain: 'other', dims: ['personality'] },
    { actor: 'model', sessionId: 's1', callId: 'c1' },
  )
  const id = w.memory.id

  // Backdate the T3 to 2023, then condense it below 200 chars so it becomes a T2.
  const old = { ...s.memories.get(id), firstSeen: '2023-03-05', bornAt: '2023-03-05T00:00:00.000Z' }
  s.memories.set(id, old)

  const res = s.condense(
    { id, title: '舊事', body: '一句話講完', targetLen: 200 },
    { actor: 'model', sessionId: 's1' },
  )
  ok(res.ok, 'condense succeeded')
  ok(res.tier === 2, `became a T2 (got ${res.tier})`)

  const t2 = s.memories.get(res.memory.id)
  console.log(`       T2 firstSeen = ${t2.firstSeen} | bornAt = ${t2.bornAt?.slice(0, 10)}`)
  ok(String(t2.firstSeen).startsWith('2023'), `firstSeen kept the 2023 date (got ${t2.firstSeen})`)
  ok(String(t2.bornAt).startsWith(String(new Date().getFullYear())), 'bornAt is today (when it settled)')

  const line = s.injectionText().split('\n').find((l) => l.includes('舊事'))
  console.log(`       prompt line: ${line}`)
  ok(String(line).includes('2023'), 'the prompt shows the original year, not this year')

  rmSync(process.env.DSH_SILT_HOME + '', { recursive: true, force: true })
}

console.log('\n2) a still-T3 condense keeps its date too (already worked, guarding it)')
{
  const s = fresh()
  const w = s.writeMemory(
    { tier: 3, title: '還在 T3 的經歷', body: '內容'.repeat(50), domain: 'other', dims: ['personality'] },
    { actor: 'model', sessionId: 's1', callId: 'c1' },
  )
  const id = w.memory.id
  const old = { ...s.memories.get(id), firstSeen: '2024-07-01', bornAt: '2024-07-01T00:00:00.000Z' }
  s.memories.set(id, old)

  const res = s.condense(
    { id, title: '還在 T3 的經歷', body: '裡'.repeat(300), targetLen: 1000 },
    { actor: 'model', sessionId: 's1' },
  )
  ok(res.ok, 'condense succeeded')
  ok(res.tier === 3, 'still a T3 (body longer than 200)')
  const next = s.memories.get(res.memory.id)
  console.log(`       firstSeen = ${next.firstSeen}`)
  ok(String(next.firstSeen).startsWith('2024'), 'the T3 kept 2024')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
