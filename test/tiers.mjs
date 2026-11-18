// 新半衰期（T2 720 / T3 180 / T4 7）的驗證
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-tiers-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const { TIERS, isExpired, salienceOf } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

console.log('1) 新的基準半衰期')
ok(TIERS[2].halfLifeDays === 720, `T2 = 720（實際 ${TIERS[2].halfLifeDays}）`)
ok(TIERS[3].halfLifeDays === 180, `T3 = 180（實際 ${TIERS[3].halfLifeDays}）`)
ok(TIERS[4].halfLifeDays === 7, `T4 = 7（實際 ${TIERS[4].halfLifeDays}）`)
ok(TIERS[5].halfLifeDays === 30, 'T5 保持 30')
ok(TIERS[1].halfLifeDays === 36500, 'T1 保持 36500')

console.log('\n2) T2/T3 比例 = 4 倍')
ok(720 / 180 === 4, '720 / 180 = 4')

console.log('\n3) T4 半衰期終於起作用（TTL 30 > 半衰期 7）')
{
  const mem = (age) => ({ id: 'x', tier: 4, importance: 0.4, bornAt: new Date(Date.now() - age * 86400000).toISOString() })
  for (const d of [0, 7, 14, 28]) {
    console.log(`       age ${String(d).padStart(2)} 天 -> salience ${(salienceOf(mem(d), {} ) / 0.4 * 100).toFixed(1)}%`)
  }
  const s7 = salienceOf(mem(7), {})
  ok(Math.abs(s7 / 0.4 - 0.5) < 0.01, '7 天正好掉一半')
  // TTL 30 天內還活著，31 天淘汰
  const s = new Store(process.env.DSH_SILT_HOME).load()
  s.cfg = { ...s.cfg, tier4TtlDays: 30 }
  ok(!isExpired(mem(29), {}, s.cfg), '29 天還活著')
  ok(isExpired(mem(31), {}, s.cfg), '31 天淘汰')
}

console.log('\n4) T3 在 180 天時亮度剛好一半（壓縮 175 天落 T2）')
{
  const mem = (age) => ({ id: 'y', tier: 3, importance: 0.4, bornAt: new Date(Date.now() - age * 86400000).toISOString() })
  const v = salienceOf(mem(180), {})
  console.log(`       T3 age 180 -> ${(v / 0.4 * 100).toFixed(1)}%`)
  ok(Math.abs(v / 0.4 - 0.5) < 0.01, '180 天 = 半衰期，掉一半')
}

console.log('\n5) 召回延長仍然有效')
{
  const mem = { id: 'z', tier: 3, importance: 0.4, bornAt: new Date(Date.now() - 180 * 86400000).toISOString() }
  const a = salienceOf(mem, { recalls: { z: { n: 0 } } })
  const b = salienceOf(mem, { recalls: { z: { n: 10 } } })
  console.log(`       180 天, R=0 -> ${(a / 0.4 * 100).toFixed(0)}% | R=10 -> ${(b / 0.4 * 100).toFixed(0)}%`)
  ok(b > a, 'R=10 更亮')
}

rmSync(process.env.DSH_SILT_HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
