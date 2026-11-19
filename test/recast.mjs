/**
 * test/recast.mjs — 重述：同一件事，換一種理解
 *
 * 這是「讓她像個人」而不是「像同一個人」的關鍵一環：
 * 人不是把舊事一路刪短的 —— 半年後再想起「他總在深夜工作」，
 * 事實沒變，但理解變成「他在用夜晚躲掉白天」。
 *
 * 驗的就是這條路走得通，而且不會被壓縮公式綁死。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { TIERS } from '../lib/model.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) pass += 1
  else {
    fail += 1
    console.log(`  x ${label}`)
  }
}
const eq = (a, b, label) => ok(a === b, `${label} → got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const section = (t) => console.log(`\n${t}`)

const home = mkdtempSync(join(tmpdir(), 'silt-recast-'))
process.env.DSH_SILT_HOME = home

const LONG = '他總是深夜還在改東西。零點、一點、兩點，帳號都還亮著。問他在忙什麼，他說沒事。'.repeat(3)

try {
  const store = new Store(home, { enabled: true })
  store.load()
  store.cfg = { ...store.cfg, enabled: true }

  const made = store.writeMemory(
    { tier: 3, title: '他總在深夜工作', body: LONG, domain: 'other', dims: ['personality'], importance: 0.6 },
    { sessionId: 's-test', actor: 'model' },
  )
  ok(made.ok, '先寫一條 T3')
  const id = made.memory.id

  section('1 · 壓縮模式：有 targetLen 就守上限')
  const shorter = store.condense({ id, title: '他總在深夜工作', body: '零點到兩點都還亮著。', targetLen: 80 }, { sessionId: 's-test' })
  ok(shorter.ok, '壓縮到 80 字以內 → 成功')
  eq(shorter.mode, 'condense', '回傳標明是 condense')

  section('2 · 重述模式：不看 targetLen')
  const made2 = store.writeMemory(
    { tier: 3, title: '他總在深夜工作', body: LONG, domain: 'other', dims: ['personality'], importance: 0.6 },
    { sessionId: 's-test', actor: 'model' },
  )
  const id2 = made2.memory.id
  // targetLen 給 1：壓縮模式必被退，重述模式不看它
  const recast = store.condense(
    { id: id2, title: '他用夜晚躲掉白天', body: LONG, mode: 'recast', targetLen: 1 },
    { sessionId: 's-test' },
  )
  ok(recast.ok, 'recast 忽略 targetLen → 成功（condense 模式同條件會被退）')
  eq(recast.mode, 'recast', '回傳標明是 recast')
  eq(recast.tier, 3, '重述永遠留在 T3，不因長度沉成 T2')

  section('3 · 重述留下痕跡，原條仍在帳本')
  const after = store.memories.get(recast.memory.id)
  eq(after.recastFrom, id2, 'recastFrom 指向原條')
  eq(after.recastCount, 1, 'recastCount = 1')
  const old = store.memories.get(id2)
  eq(old.archived, true, '原條被歸檔（不進注入）')
  ok(!!old.body, '但原條內容還在（可審計）')

  section('4 · 重述不能無限膨脹')
  const huge = store.condense(
    { id: recast.memory.id, title: 'x', body: 'y'.repeat(TIERS[3].maxChars + 100), mode: 'recast' },
    { sessionId: 's-test' },
  )
  ok(!huge.ok, `超過 T3 上限 ${TIERS[3].maxChars} 字 → 拒絕`)

  section('5 · 作廢跟重述是兩回事')
  const made3 = store.writeMemory(
    { tier: 3, title: '他說他明天去面試', body: '他親口說的，語氣很確定。', domain: 'other', dims: ['communication'], importance: 0.7 },
    { sessionId: 's-test', actor: 'model' },
  )
  const voided = store.voidMemory(made3.memory.id, { reason: '他後來沒去，那句是隨口說的' })
  ok(voided.ok, '作廢成功')
  eq(store.memories.get(made3.memory.id).voided, true, '標成作廢')
  ok(!store.activeMemories().some((m) => m.id === made3.memory.id), '作廢的不進注入')
  ok(store.activeMemories().some((m) => m.id === recast.memory.id), '重述過的新版仍然進注入')

  section('6 · 作廢的不能重述')
  const onVoided = store.condense({ id: made3.memory.id, title: 'x', body: 'yy', mode: 'recast' })
  ok(!onVoided.ok, '對作廢的條目重述 → 拒絕')

  section('7 · 帳本記的是兩種不同的事')
  const kinds = store.records.map((r) => r.kind)
  ok(kinds.includes('memory.recast'), '有 memory.recast')
  ok(kinds.includes('memory.void'), '有 memory.void')
  const chain = store.verify({ force: true })
  ok(chain.ok === true, `哈希鏈完好（${chain.count} 筆）`)
} finally {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清不掉不影響結論 */
  }
  delete process.env.DSH_SILT_HOME
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
