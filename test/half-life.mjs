// 召回延長半衰期：驗證新公式，並確認壓縮永遠先於淡出。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SILT_HOME = mkdtempSync(join(tmpdir(), 'silt-half-'))
const { Store } = await import('file:///E:/deepseek-harness/智能管家/silt/lib/store.js')
const {
  RECALL_HALF_BASE,
  RECALL_HALF_CAP,
  TIERS,
  salienceOf,
} = await import('file:///E:/deepseek-harness/智能管家/silt/lib/model.js')

let pass = 0
let fail = 0
const ok = (c, l) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)))

const mem = (tier, ageDays) => ({
  id: 'm1', tier, importance: 0.4,
  bornAt: new Date(Date.now() - ageDays * 86400000).toISOString(),
})
const rt = (n) => ({ recalls: { m1: { n } } })

console.log('1) 半衰期隨召回次數延長')
{
  const base = TIERS[3].halfLifeDays
  for (const R of [0, 3, 10]) {
    const hl = base * Math.pow(RECALL_HALF_BASE, Math.min(RECALL_HALF_CAP, R))
    console.log(`       R=${String(R).padStart(2)} -> 有效半衰期 ${Math.round(hl)} 天`)
  }
  ok(base * Math.pow(RECALL_HALF_BASE, 10) > 600, 'R=10 時 T3 半衰期超過 600 天')
}

console.log('\n2) 同齡的記憶，被召回過的 salience 更高')
{
  const a = salienceOf(mem(3, 200), rt(0))
  const b = salienceOf(mem(3, 200), rt(10))
  console.log(`       age 200, R=0  -> ${a.toFixed(4)}`)
  console.log(`       age 200, R=10 -> ${b.toFixed(4)}`)
  ok(b > a, '被召回 10 次的更亮')
  ok(b / a > 2, `差距 > 2 倍（實際 ${(b / a).toFixed(2)}×）`)
}

console.log('\n3) 沒有 boost 了：R=0 與 R=1 在 age=0 時 salience 相同')
{
  // 舊公式下 R=1 會讓人 1.22 倍；新公式把 R 放進半衰期，age=0 時還看不出差別
  const a = salienceOf(mem(3, 0), rt(0))
  const b = salienceOf(mem(3, 0), rt(1))
  console.log(`       age 0, R=0 -> ${a.toFixed(4)} | R=1 -> ${b.toFixed(4)}`)
  ok(Math.abs(a - b) < 1e-9, '剛出生時看不出差別（衰減還沒開始）')
}

console.log('\n4) 半衰期真的變長：走過 112 天時，R=10 的還遠沒掉一半')
{
  const plain = salienceOf(mem(3, 112), rt(0))
  const recalled = salienceOf(mem(3, 112), rt(10))
  const base = 0.4
  console.log(`       age 112, R=0  -> ${(plain / base * 100).toFixed(1)}%（應約 50%）`)
  console.log(`       age 112, R=10 -> ${(recalled / base * 100).toFixed(1)}%`)
  ok(Math.abs(plain / base - 0.5) < 0.01, 'R=0 在 112 天正好掉一半')
  ok(recalled / base > 0.85, `R=10 在 112 天還有 85% 以上（實際 ${(recalled / base * 100).toFixed(0)}%）`)
}

console.log('\n5) 壓縮永遠先於淡出（T3）')
{
  const K = 0.14
  const LEN = 975
  const compressDay = (R) => {
    for (let d = 1; d < 6000; d++) {
      if (LEN * Math.pow(1 + K * d / Math.pow(RECALL_HALF_BASE, R), -0.5) <= 200) return d
    }
    return 6000
  }
  // salience 掉到 5% 以下視為看不見：age = halfLife × log2(0.4/0.05)
  const fadeDay = (R) => Math.round(TIERS[3].halfLifeDays * Math.pow(RECALL_HALF_BASE, R) * Math.log2(0.4 / 0.05))
  let allGood = true
  for (const R of [0, 3, 5, 8, 10]) {
    const c = compressDay(R)
    const f = fadeDay(R)
    const good = c < f
    if (!good) allGood = false
    console.log(`       R=${String(R).padStart(2)}: 壓縮 ${String(c).padStart(4)} 天，淡出 ${String(f).padStart(4)} 天 → ${good ? '壓縮先 ✓' : '順序錯了'}`)
  }
  ok(allGood, '每一檔都是壓縮先於淡出')
}

console.log('\n6) 上限：召回超過 10 次不再延長')
{
  const a = salienceOf(mem(3, 300), rt(10))
  const b = salienceOf(mem(3, 300), rt(50))
  console.log(`       R=10 -> ${a.toFixed(6)} | R=50 -> ${b.toFixed(6)}`)
  ok(Math.abs(a - b) < 1e-9, 'R=10 與 R=50 結果相同（封頂）')
}

console.log('\n7) T1 幾乎不淡')
{
  const s = salienceOf(mem(1, 3650), rt(0))
  // 半衰期 36500 天（100 年），十年只走 0.1 個半衰期 → 掉約 7%
  const expect = 0.4 * Math.pow(0.5, 3650 / TIERS[1].halfLifeDays)
  console.log(`       T1 十年後 salience = ${s.toFixed(4)}（理論 ${expect.toFixed(4)}）`)
  ok(s > 0.36, 'T1 十年後掉不到 10%')
  ok(Math.abs(s - expect) < 1e-6, '符合半衰期公式')
}

rmSync(process.env.DSH_SILT_HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
