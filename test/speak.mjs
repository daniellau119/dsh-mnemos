/**
 * test/speak.mjs — 主動開口：只有兩道條件
 *
 *   1. **谷時** —— 尖峰時段說不出去
 *   2. **模型自主判斷** —— 沒有配額、沒有冷卻、沒有打分，插件不替它決定
 *
 * 這個測試驗的就是「沒有多餘門檻」這件事本身：
 * 每一條斷言都是在確認某個「本來很容易手滑加上去的門檻」**不存在**。
 *
 * 跑在臨時家目錄（DSH_SILT_HOME），不碰真帳本。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { inValley } from '../lib/duty.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) pass += 1
  else {
    fail += 1
    console.log(`  ✗ ${label}`)
  }
}
const eq = (a, b, label) => ok(a === b, `${label}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`)
const section = (t) => console.log(`\n${t}`)

/** 找一個確定落在谷時 / 尖峰的時刻，用真實的 inValley 判斷，不靠猜。 */
function findTimes() {
  const base = Date.parse('2026-11-19T00:00:00+08:00')
  let valley = null
  let peak = null
  for (let m = 0; m < 7 * 24 * 60 && (!valley || !peak); m += 5) {
    const t = base + m * 60000
    const v = inValley(t)
    if (v.ok && !valley) valley = t
    // 尖峰必須是工作日才算數（週末全天都是谷時）
    if (!v.ok && !peak && new Date(t).getDay() !== 0 && new Date(t).getDay() !== 6) peak = t
  }
  return { valley, peak }
}

const home = mkdtempSync(join(tmpdir(), 'silt-speak-'))
process.env.DSH_SILT_HOME = home

try {
  const store = new Store(home, { enabled: true, speak: true })
  store.load()
  store.cfg = { ...store.cfg, enabled: true, speak: true }
  store.valleyOf = (now) => inValley(now)

  const { valley, peak } = findTimes()
  ok(valley !== null, '找得到谷時樣本')
  ok(peak !== null, '找得到尖峰樣本')

  section('1 · 第一道：谷時')
  const gPeak = store.speakGate(peak)
  ok(gPeak.ok === false, '尖峰時段不允許開口')
  ok(gPeak.reasons.some((r) => r.includes('谷時')), '理由說的是谷時')
  const gValley = store.speakGate(valley)
  ok(gValley.ok === true, '谷時允許開口')

  section('2 · 第二道：本人許可（不是門檻，是開關）')
  store.cfg = { ...store.cfg, enabled: false }
  ok(store.speakGate(valley).ok === false, '總開關關著就不說')
  store.cfg = { ...store.cfg, enabled: true, speak: false }
  ok(store.speakGate(valley).ok === false, 'speak 關著就不說')
  store.cfg = { ...store.cfg, speak: true }
  ok(store.speakGate(valley).ok === true, '兩個都開著就允許')

  section('3 · 沒有每日上限')
  // 已經說了 50 次，仍然允許
  store.runtime.speakLog = Array.from({ length: 50 }, () => ({ at: new Date(valley).toISOString(), kind: 'share', deferred: false }))
  store.runtime.lastSpokeAt = new Date(valley).toISOString()
  const gMany = store.speakGate(valley)
  ok(gMany.ok === true, '今天已經說了 50 次，還是允許 —— 沒有配額')
  eq(gMany.spokenToday, 50, '數字看得到，但只用來參考')
  ok(!gMany.reasons.some((r) => r.includes('上限')), '理由裡沒有「上限」這種東西')

  section('4 · 沒有冷卻間隔')
  // 上一秒剛說過，現在還是允許
  store.runtime.lastSpokeAt = new Date(valley - 1000).toISOString()
  const gGap = store.speakGate(valley)
  ok(gGap.ok === true, '上一秒才說完，還是允許 —— 沒有冷卻')

  section('5 · 沒有「他正在忙」的判斷')
  store.runtime.lastHumanAt = new Date(valley - 60000).toISOString()
  const gBusy = store.speakGate(valley)
  ok(gBusy.ok === true, '本人一分鐘前還在說話，也照樣允許 —— 那是模型自己該掂量的')
  eq(gBusy.humanBusy, undefined, 'gate 裡沒有 busy 這個欄位')

  section('6 · 沒有打分、沒有門檻')
  const state = store.speakState(valley)
  eq(state.threshold, undefined, '狀態裡沒有門檻分數')
  eq(state.score, undefined, '狀態裡沒有分數')
  eq(state.maxPerDay, undefined, '狀態裡沒有每日上限')
  eq(state.gapHours, undefined, '狀態裡沒有冷卻間隔')
  ok(typeof state.note === 'string' && state.note.includes('谷時'), '說明寫清楚規則是谷時')

  section('7 · defer 記帳，但不擋下一次 say')
  const before = store.runtime.lastSpokeAt
  store.recordSpeak({ kind: 'share', deferred: true, reason: '沒什麼值得說的' })
  eq(store.runtime.lastSpokeAt, before, 'defer 不動 lastSpokeAt')
  ok(store.runtime.speakLog.at(-1).deferred === true, 'defer 有進 speakLog')
  ok(store.speakGate(valley).ok === true, 'defer 之後仍然允許開口')

  section('8 · say 之後仍然允許立刻再說（沒有冷卻）')
  store.recordSpeak({ kind: 'share', text: '今天看到一件有意思的事。' })
  ok(Boolean(store.runtime.lastSpokeAt), 'say 之後 lastSpokeAt 有值')
  ok(store.speakGate(valley).ok === true, '剛說完，谷時裡隨時可以再說')

  section('9 · 本人回話只記錄，不上閘')
  eq(store.runtime.speakAckedAt, null, '剛開口 ⇒ 還沒有回話')
  store.noteHumanTurn({ source: 'turn' })
  ok(Boolean(store.runtime.speakAckedAt), '本人回話 ⇒ acked 有值')
  ok(store.speakGate(valley).ok === true, '回話不改變能不能說')
  eq(store.speakState(valley).acked, true, '狀態看得到有沒有下文')

  section('10 · chain 仍然完好')
  const chain = store.verify({ force: true })
  ok(chain.ok === true, `哈希鏈完好（${chain.count} 筆）`)
  ok(chain.count >= 3, 'defer / send / ack 都落了帳')
} finally {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 臨時目錄清不掉不影響結論 */
  }
  delete process.env.DSH_SILT_HOME
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
