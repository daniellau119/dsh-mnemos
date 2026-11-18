// Verify the new continuous target: no cliff on interruption, R stretches the clock.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-plan-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { makeDuty } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/duty.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const K = 0.14
const FLOOR = 120
const target = (base, days, R) => Math.round(Math.max(FLOOR, base * Math.pow(1 + K * (days / Math.pow(1.2, Math.min(10, R))), -0.5)))

console.log('1) formula shape (base 975, never recalled)')
for (const d of [7, 14, 21, 28, 56, 90, 112, 180, 365]) {
  console.log(`       day ${String(d).padStart(3)} -> ${target(975, d, 0)} chars`)
}
ok(target(975, 7, 0) === 693, `day 7 = 693 (got ${target(975, 7, 0)})`)
const drop7 = (975 - target(975, 7, 0)) / 975 * 100
console.log(`       first compression drops ${drop7.toFixed(1)}%`)
ok(drop7 < 30, `first drop under 30% (got ${drop7.toFixed(1)}%)`)

console.log('\n2) recall stretches the clock')
const r0 = target(975, 30, 0)
const r10 = target(975, 30, 10)
console.log(`       day 30, R=0  -> ${r0}`)
console.log(`       day 30, R=10 -> ${r10}`)
ok(r10 > r0, 'R=10 keeps more than R=0 at the same age')

console.log('\n3) no cliff: the drop per round stays gentle even after a long idle')
// 舊階梯在 day 187 一次從 975 塌到 184（掉 81%）。新公式在 day 365 是 135，
// 而且它是「那一天本來的長度」，不是一次補完 —— 中斷多久，算出來就是多久該有的樣子。
const longIdle = target(975, 365, 0)
console.log(`       day 365 -> ${longIdle}`)
ok(longIdle > 120, `a year-old memory is still above the floor (got ${longIdle})`)
ok(target(975, 180, 0) > longIdle, 'day 180 is longer than day 365 (still shrinking)')
// 真正的「無斷崖」證據：任何兩天之間的落差都不超過第一天的跌幅
const drop1 = (975 - target(975, 7, 0)) / 975
let worst = 0
let prevT = 975
for (let d = 7; d <= 400; d += 7) {
  const t = target(975, d, 0)
  worst = Math.max(worst, (prevT - t) / prevT)
  prevT = t
}
console.log(`       worst single-step drop = ${(worst * 100).toFixed(1)}% (first step was ${(drop1 * 100).toFixed(1)}%)`)
ok(worst <= drop1 + 0.001, 'no later step drops more than the first one')

console.log('\n4) floor and monotonicity')
ok(target(975, 9999, 0) >= FLOOR, 'never below the 120 floor')
let prev = 975
let mono = true
for (let d = 7; d <= 400; d += 7) {
  const t = target(975, d, 0)
  if (t > prev) mono = false
  prev = t
}
ok(mono, 'target shrinks monotonically with age')

console.log('\n5) live condensePlan on a real store')
{
  const s = new Store(process.env.DSH_SILT_HOME).load()
  s.cfg = { ...s.cfg, enabled: true }
  const w = s.writeMemory(
    { tier: 3, title: '一段經歷', body: '內容'.repeat(487), domain: 'other', dims: ['personality'] },
    { actor: 'model', sessionId: 'x', callId: 'c' },
  )
  const id = w.memory.id
  const stored = s.memories.get(id)
  const len = String(stored.title).length + String(stored.body).length
  console.log(`       stored len = ${len}`)

  const duty = makeDuty({ ctx: { get: () => null, effect: () => {}, on: () => {} }, store: s, log: () => {} })
  const planNow = duty.condensePlan()
  console.log(`       plan on day 0 (not due): ${planNow.length} items`)
  ok(planNow.length === 0, 'not due yet -> not in the plan')

  // Backdate it 30 days and re-plan.
  s.memories.set(id, { ...stored, bornAt: new Date(Date.now() - 30 * 86400000).toISOString() })
  const plan30 = duty.condensePlan()
  console.log(`       plan on day 30: ${plan30.map((p) => `${p.len} -> ${p.targetLen}`).join(', ') || 'none'}`)
  ok(plan30.length === 1, 'due after 30 days -> listed')
  ok(plan30[0]?.targetLen < len, 'target is shorter than current')
  ok(plan30[0]?.targetLen === target(len, 30, 0), 'target matches the formula')
}

rmSync(process.env.DSH_SILT_HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
