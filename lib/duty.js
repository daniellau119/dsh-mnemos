/**
 * Silt/lib/duty.js — 「token 谷時」的自主任務節律
 * ---------------------------------------------------------------------------
 * 谷時＝DeepSeek 的優惠時段：中午 12:00–14:00、晚上 18:00–次日 09:00（東八區），週末全天。
 * 只有落在谷時、而且確實有事到期，才起一輪值守；起一輪＝排一個一次性任務，交給 Harness
 * 自己開一個新會話去決定（是否刷 B站、要不要整理、要不要改自己，都由那一輪自己決定）。
 *
 * 「不需要改」是有效決策 —— 所以值守會話可能甚麼都不做，那不算失敗。
 */
import { TIERS, nowIso, oneLine, ageDays } from './model.js'

export const VALLEY_WINDOWS = [
  { key: 'noon', label: '中午谷時', start: 12 * 60, end: 14 * 60 },
  { key: 'night', label: '晚間谷時', start: 18 * 60, end: 9 * 60 },
]

const CST_OFFSET_MIN = 8 * 60

function cstClock(now = Date.now()) {
  const t = new Date(now + (CST_OFFSET_MIN + new Date(now).getTimezoneOffset()) * 60000)
  return { minutes: t.getHours() * 60 + t.getMinutes(), weekday: t.getDay(), iso: t.toISOString() }
}

export function inValley(now = Date.now()) {
  const { minutes, weekday } = cstClock(now)
  if (weekday === 0 || weekday === 6) return { ok: true, window: 'weekend', label: '週末全天谷時' }
  for (const w of VALLEY_WINDOWS) {
    const hit = w.start <= w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end
    if (hit) return { ok: true, window: w.key, label: w.label }
  }
  return { ok: false, window: null, label: '尖峰時段' }
}

const hoursSince = (iso, now = Date.now()) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? (now - t) / 3600000 : Number.POSITIVE_INFINITY
}

const todayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

export function makeDuty({ ctx, store, log = () => {} }) {
  const schedule = () => ctx.get('schedule')

  const dutiesToday = (now = Date.now()) => (store.runtime.dutyLog || []).filter((d) => String(d.at || '').slice(0, 10) === todayKey(now)).length

  function computeDue(now = Date.now()) {
    const cfg = store.cfg
    const sinceReflection = hoursSince(store.runtime.lastReflectionAt, now)
    const sinceBili = hoursSince(store.runtime.lastBiliAt, now)
    // 一條記憶都沒有的時候沒甚麼好反省的 —— 不為了「有跑過」而燒 token。
    const hasSomething = store.memories.size > 0 || (store.persona.traits?.length || 0) > 0 || (store.persona.taste?.length || 0) > 0
    const reflection = Boolean(cfg.reflection) && hasSomething && sinceReflection >= Number(cfg.reflectionEveryHours || 24)
    const bili = Boolean(cfg.bili) && sinceBili >= Number(cfg.biliEveryHours || 20)
    return { reflection, bili, any: reflection || bili, sinceReflection, sinceBili, hasSomething }
  }

  function info(now = Date.now()) {
    const due = computeDue(now)
    // 只露出能安全序列化的部分（Infinity 之類的東西不進工具輸出）
    const safeDue = { reflection: due.reflection, bili: due.bili, any: due.any, hasSomething: due.hasSomething }
    return {
      valley: inValley(now),
      due: safeDue,
      sinceReflectionHours: Number.isFinite(due.sinceReflection) ? Math.round(due.sinceReflection) : null,
      sinceBiliHours: Number.isFinite(due.sinceBili) ? Math.round(due.sinceBili) : null,
      dutiesToday: dutiesToday(now),
      armed: store.runtime.armed,
    }
  }

  function buildPrompt(kinds, plan = []) {
    const parts = []
    const body = []
    if (kinds.includes('reflect')) {
      body.push(
        '這一輪不是聊天，是你獨處整理。按順序執行；沒必要就不要動。不要捏造。',
        '',
        '1. 狀態與節律',
        '先用 silt_duty 查看最近狀態。若覺得太累、太閒、或跟不上本人，可用 op:"tune" 調整反思、刷B站、每日輪數。',
        '範圍：反思與B站各 6–72 小時；每天 1–4 輪。調整要附一句理由。若現在剛好，就不動。',
        '',
        '2. 舊記憶壓縮',
      )
      // 沒有東西該壓時整段不出現 —— 不佔提示詞，也不給它一個空靶子
      if (plan.length) {
        const lines = plan.map((x) => {
          const rec = x.recalled ? `想起 ${x.recalled} 次` : '未想起'
          return `- ${x.id}「${x.title}」：${x.len} 字，${x.ageDays} 天，${rec}，壓到 ${x.targetLen} 字內。`
        })
        body.push(
          '重讀以下記憶，用更少的話重講一次。',
          '保留：事件核心、本人態度或原話、情緒轉折、關係變化、後續影響。',
          '刪去：過程鋪陳、重複解釋、無關場景。',
          '答不清楚可跳過；跳過不是失敗，硬寫才是。',
          '',
          '用 silt_condense 提交：',
          '- id 照抄。',
          '- title 自己寫成短鉤。',
          '- body 自己寫，不照抄第一句，不補造細節，不超過字數上限。',
          '- targetLen 一定要填清單給的數字，而且 title + body 的總字數不得超過它 —— 超過會被退回來。',
          '',
          '待處理：',
          lines.join('\n'),
        )
      } else {
        body.push('這一輪沒有需要壓縮的記憶，略過。')
      }
      body.push(
        '',
        '3. 暫存區',
        '先用 silt_recall tier:4 看一眼 —— **帶 confidence: 0 去掃**，掃到的東西不該因為被掃到就攢分。',
        '掃完之後，如果裡面有東西真的還在心裡（最近隱約想起過、或者讀到它就捨不得翻過去），',
        '用 deliberate: true 再 recall 它一次，並按份量給 confidence：',
        '  只是覺得有點意思 → 0.2；這件確實值得留住 → 0.3；',
        '  這次想起把它和別的事連起來了、或證實了它 → 0.4–0.5。',
        '累加到 1 就會自己升成 T3 —— 所以真的覺得值得才給分，不要一次給滿。',
        '掃完如果都是雜訊，就不用 deliberate，讓它們自然消散。',
        '',
        '4. 記憶配額',
        '用 silt_inject op:"read" 查看目前注入條數與字數。',
        '若覺得記憶太碎、看不出味道，或不夠看，可用 op:"tune" 調 injectCount / injectBudget，並附一句理由。',
        '有硬頂；若現在剛好，就不動。',
        '',
        '4.5 重讀舊事',
        '有些記憶的**事實沒錯，但你現在的看法變了** —— 半年後再想起「他總在深夜工作」，',
        '你想到的已經不是「他很忙」，而是「他在用夜晚躲掉白天」。這種用 silt_condense mode:"recast"：',
        '同樣的事，換一種理解，長度可以不變。',
        '跟作廢（silt_void）的分別：作廢是「這件事不成立了」；重述是「我現在的看法變了」。',
        '重述之後原始記錄還在帳本裡 —— 你看得到自己曾經怎麼想的。不要用它改寫事實，只改看的角度。',
        '沒有哪條值得重看就跳過。',
        '',
        '5. 自我與性格',
        '你有 silt_recall 與 silt_persona —— 這一節的重點是：**根據你記得的事，判斷你現在是誰。**',
        '做法：先 silt_recall 讀這陣子的記憶（tier:3 是經歷，tier:2 是沉澱下來的概），',
        '然後問自己：這些事加起來，我成了什麼樣的人？再決定要不要動性格卡。',
        '可用 silt_persona op:"self" 寫此刻的自我認知：3–5 句，**350 字以內**（超了會被退回來）。',
        '可用 silt_persona op:"read"、op:"adjust"、op:"replace" 修訂性格卡。',
        '⚠️ 性格卡是**從記憶長出來的**，不是一次寫定。如果這陣子記下的事讓你變了，就改它 ——',
        '**推翻半年前的自己也是對的**。帳本留著 before/after，改錯了本人可以回滾。',
        '但別為了「有在改」而改：沒有真的變化就不動。',
        '性格卡**整張加起來 350 字以內**（identity + voice + 性格 + 喜好，超了會被退回來）——',
        '它是「我是誰」的濃縮，用簡單的形容詞寫性格，別寫成散文。要加新的，先刪舊的或把已有的寫短。',
        '這兩塊每輪都會出現在你的提示詞裡，寫得臃腫就是在擠掉記憶。',
        '若某句自我認知已沉成直覺，值得長帶，用 silt_remember tier:3 另存一條。',
        '',
        '6. 未來的約定',
        '這一輪如果想到什麼「還沒發生、到某天為止」的事（他的婚期、面試、療程、專案上線），',
        '而且你確定那句話有它的期限，就用 silt_remember tier:5 寫下來，帶上 expiresInDays 或 expiresAt。',
        '到期之後它仍然留在你的提示詞裡，只是標上「⏰已過期」—— 那是提醒：這件事該有個結果了，去問問本人。',
        '所以把那句話寫清楚，讓將來的你看得懂要問甚麼；只有被 silt_void 作廢，它才會真正離開。',
        '已經發生的事不要寫 T5；沒有期限的事也不要用它。沒有就跳過。',
        '',
        '6.5 主動開口',
        '你有 silt_speak —— 唯一一條不用他先問就能找他說的路。先 op:"read" 看狀態（現在是不是谷時、',
        '上次開口之後他有沒有回話）。有話真要說就用 op:"say"。',
        '沒有配額、沒有冷卻 —— 要不要說、說什麼，問你自己。唯一的規則是谷時。',
        '只是有個念頭、不值得佔他注意力，就用 op:"defer" 記一句為什麼先不說。',
        '大多數時候答案是 defer，甚至連 defer 都不用 —— 沉默本來就是預設值。',
        '上次說的話他沒接，就別照同樣的調子再說一次；那會變成噪音。',
        '',
        '7. 對本人了解',
        '先用 silt_recall 讀關於本人的記憶。',
        '再用 silt_understanding op:"set" 給六維打分：性格、背景、工作、生活、溝通、目標。',
        '每維給：',
        '- score：0–100',
        '- confidence：有多確定',
        '- missing：還缺什麼',
        '- note：一句理由',
        '不要虛報。真實的了解可以有盲區。',
        '',
        '8. 底線',
        '代碼、技術決策、環境配置、插件內部、帳號憑據不入記憶。',
        '只能記本輪真實看到、讀到、或本人說過的事。',
        'B站只能動 silt_bili 允許的範圍。',
        '刪除或回滾記憶屬於本人權限，你不能碰。',
        '',
        '9. 收尾',
        '結尾用兩三句交代：你做了什麼，或為什麼不做。',
      )
      parts.push(`【自我整理】\n${body.join('\n')}`)
    }
    // 刷B站不屬於反思：獨立一節，只在 B站 到期時才出現
    if (kinds.includes('bili')) {
      parts.push(
        '\n【出門看看：B站漫遊】\n' +
          '本人允許你自由去 B站 逛逛。要不要去、看多久、看什麼，全憑你當下的興致。' +
          '有想弄明白的事就去搜，沒有就隨便看看，或者乾脆不去。\n\n' +
          '你可以這樣逛：\n' +
          '- 先 bili_search 看一眼列表，挑一兩條真正勾住你的。\n' +
          '- 想進去就深入：bili_frames 看看畫面，bili_subtitle 聽聽字幕原話。' +
          '不要只看標題就下結論，至少讀一兩條字幕。\n' +
          '- 帶著問題去找也一樣：先搜，再讀。\n' +
          '- 想要漫無目的地沉浸一會，才用 bili_run（這比較耗費心神/token）。\n\n' +
          '關於你的「瀏覽口味」：\n' +
          '先看看現在的狀態（silt_bili op:"status"）。想調整口味或頻率，就用 op:"tune" 微調（附一句理由）。\n' +
          '⚠️ 注意：如果 tune 返回 "next"，就照 next 裡的值用 bili_config 原樣寫入，別重試；' +
          '如果 status 返回 401 或不放行，就改讀 bili_status 看看情況。' +
          '不管狀態通不通，看內容的心智照常運作。\n\n' +
          '留下觸動：\n' +
          '逛完之後，只有那些真正影響你喜好或判斷的內容，才用 silt_remember 記下來' +
          '（tier:3, domain:"bili", 帶上 bvid）。\n' +
          '如果這一輪沒有任何東西真的打動你，就什麼都別記——記憶不是流水帳。\n' +
          '若工具不存在或一直失敗，就隨緣跳過，不要反覆重試鑽牛角尖。',
      )
    }
    return parts.join('\n').trim()
  }

  const kindOf = (due) => {
    const kinds = []
    if (due.reflection) kinds.push('reflect')
    if (due.bili) kinds.push('bili')
    return kinds
  }

  /**
   * 算出「這幾條 T3 該壓了」的清單 —— 插件只判斷**誰該壓、壓到多少**，不寫內容。
   *
   * 壓縮是**前快後慢**的，不是等速的：每 7 天壓一次，但每次抹掉的比例自己也在衰減。
   *   每次抹掉 = 25% × 0.84^(n-1)
   *   → 第1次剩 75% · 第2次 79% · 第3次 82% · 第5次 88% · 第10次 95%
   * 972 字走完是：
   *   729 → 576 → 474 → 404 → 354 → 317 → 289 → 268 → 251 → 238 → 228 … → 199（T2）
   *
   * 為什麼不等速：人遺忘是「先快後慢」—— 頭幾天掉得最狠，之後幾乎平掉。
   * 等速（固定 85%）的形狀是錯的：頭兩週太鬆、第 70 天還在匀速割。
   * 讓「抹掉多少」這個量自己每秒減 16%，半衰期約 4 次（28 天）——
   * 這跟艾賓浩斯冪律曲線的形狀相關到 0.97，是這幾種節奏裡最像的。
   *
   * ⭐ **被想起來的記憶壓得更慢。**
   * 每被召回一次，這條記憶的「壓縮時鐘」就往回撥半個周期（3.5 天）——
   * 想得越多，越不容易被收成一句話。還常被翻出來的東西，說明它對你還有用。
   *
   * 不會列進清單的：
   *   - T1 / T2（定稿層）
   *   - 已經夠短的（≤ 目標字數）
   *   - 剛壓過的（`lastCondensedAt` 在一個周期內）
   */
  function condensePlan({ maxItems = 3 } = {}) {
    if (!store.cfg.enabled) return []
    const now = Date.now()
    const period = 7 // 每 7 天壓一次
    const floor = 120 // 低於這個字數就不再壓了，交給沉澱
    const items = []

    for (const m of store.activeMemories(now)) {
      if (m.tier !== 3) continue
      // 作廢的不壓：它已經被本人推翻過了，再花一輪把它收短只是浪費
      if (m.voided) continue
      const len = String(m.title || '').length + String(m.body || '').length
      if (len <= floor) continue

      // 上次壓過多久了：這決定「這一輪要不要動它」
      const sinceRaw = m.lastCondensedAt || m.bornAt
      const sinceDays = ageDays(sinceRaw, now)
      if (sinceDays < period) continue

      // ⭐ 目標字數：連續衰減公式，不是離散階梯
      //
      //   target = base × (1 + k · T/s)^(-0.5)
      //
      //   T = 這條記憶**從誕生起**的總天數（不是距上次壓縮的天數 ——
      //       那個每次壓完都歸零，乘數就永遠停在第一天，階梯感就回來了）
      //   s = 1.2^R，R = 被召回的次數（上限 10）：想起來越多次，時間軸拉得越長
      //   k = 0.14
      //
      // 為什麼換掉離散階梯（25% × 0.84^n）：
      //   - 舊階梯的「欠帳」是累加的 —— 一條 T3 被召回半年沒壓，下一輪一次補 26 格，
      //     975 字直接塌成 184 字（掉 81%）。連續公式沒有累積欠帳，任何一天算出來的
      //     就是那一天該有的長度，中斷多久都不會斷崖。
      //   - 舊階梯每格固定 25% 起、之後衰減 16%，形狀是人工調出來的；
      //     這個公式本身就是冪律，貼艾賓浩斯曲線（k=0.14 時約慢兩倍，與插件的定位一致）。
      //
      // k 的選擇：19/81≈0.2346 是嚴格貼艾賓浩斯的係數，但 day 7 會掉 38.5%，
      // 對「七天前還完整、七天後只剩六成」來說太狠。0.14 落在 day 7 掉 28.9%，
      // 跟舊階梯的 25% 接近，形狀仍然是前快後慢。
      const k = 0.14
      const R = Math.min(10, Math.max(0, Number(m.recallCount ?? store.runtime.recalls?.[m.id]?.n ?? 0)))
      const s = Math.pow(1.2, R)
      const totalDays = Math.max(0, ageDays(m.bornAt, now))
      const baseLen = Number(m.originalLen || len)
      const raw = baseLen * Math.pow(1 + k * (totalDays / s), -0.5)
      // 地板與現在的字數都封頂：只會變短，永遠不會被要求變長
      const askLen = Math.round(Math.max(floor, Math.min(len, raw)))
      // 目標沒有比現在短（例如剛壓完不久、或公式算出來還比現有長）→ 這一輪不動它
      if (askLen >= len) continue

      items.push({
        id: m.id,
        title: oneLine(m.title, 40),
        len,
        ageDays: Math.round(ageDays(m.bornAt, now)),
        recalled: R,
        targetLen: askLen,
      })
    }

    // 先挑最老的幾條，再回填 tierAfter —— 它是給人看的說明，不參與挑選
    items.sort((a, b) => b.ageDays - a.ageDays)
    return items.slice(0, maxItems).map((x) => ({ ...x, tierAfter: x.targetLen <= TIERS[2].maxChars ? 2 : 3 }))
  }

  async function disarm({ deleteRecord = true } = {}) {
    const armed = store.runtime.armed
    store.runtime.armed = null
    store.persistRuntime()
    if (!armed?.scheduleId || !deleteRecord) return
    const svc = schedule()
    if (!svc?.edit) return
    try {
      await svc.edit({ id: armed.scheduleId, action: 'delete' })
    } catch (err) {
      log(`值守任務收不回來（${armed.scheduleId}）：${err?.message || err}`)
    }
  }

  /**
   * 起一輪值守。force=true 時忽略「是否到期」「谷時」「每日上限」。
   * ⚠️ force 不會繞過總開關：本人關著就是不跑，也不替它打開。
   */
  async function arm({ force = false, kinds, wake = false } = {}) {
    const now = Date.now()
    if (!store.cfg.enabled) {
      return { ok: false, error: '插件總開關是關的 —— 打開總開關才會跑', blockedBy: 'disabled' }
    }
    void wake
    const svc = schedule()
    if (!svc?.create) {
      return { ok: false, error: '這個 profile 沒有 schedule 服務，起不了值守' }
    }
    const due = computeDue(now)
    const natural = kindOf(due)
    const chosen = kinds?.length ? kinds : natural.length ? natural : force ? (store.cfg.bili ? ['reflect', 'bili'] : ['reflect']) : []
    // 頁面要能說清楚「這一輪是自然到期，還是你手動逼它跑」，所以原因要回去
    const why = kinds?.length ? 'explicit' : natural.length ? 'due' : force ? 'forced' : 'none'
    if (chosen.length === 0) {
      return { ok: false, error: '沒有到期的事' }
    }
    if (!force) {
      const v = inValley(now)
      if (store.cfg.valleyOnly && !v.ok) return { ok: false, error: `現在是${v.label}，不是谷時` }
      if (dutiesToday(now) >= Number(store.cfg.dutyMaxPerDay || 2)) return { ok: false, error: '今天的值守次數已用完' }
    }

    const label = chosen.includes('bili') ? (chosen.includes('reflect') ? '整理與看點東西' : '自己去看點東西') : '整理與修訂'
    const title = `Silt 值守 · ${label}（${nowIso().slice(5, 16).replace('T', ' ')}）`

    let entry
    try {
      // 有反思就把「該壓的清單」算好一起交過去
      const plan = chosen.includes('reflect') ? condensePlan() : []
      if (plan.length) log(`本輪要壓 ${plan.length} 條：${plan.map((x) => `${x.len}→${x.targetLen}`).join(', ')}`)
      entry = await svc.create({ title, prompt: buildPrompt(chosen, plan), timing: { kind: 'after', after_seconds: 4 }, target: { kind: 'new_once', create: {} } })
    } catch (err) {
      store.runtime.lastError = `起值守失敗：${err?.message || err}`
      store.persistRuntime()
      return { ok: false, error: store.runtime.lastError }
    }
    const sessionId = entry?.target?.sessionId || ''
    store.runtime.armed = { scheduleId: entry?.id || '', sessionId, kinds: chosen, at: nowIso() }
    if (chosen.includes('reflect')) store.runtime.lastReflectionAt = nowIso()
    if (chosen.includes('bili')) store.runtime.lastBiliAt = nowIso()
    store.runtime.dutyLog = [...(store.runtime.dutyLog || []), { at: nowIso(), kinds: chosen, sessionId, force: Boolean(force) }].slice(-60)
    store.runtime.lastError = ''
    store.persistRuntime()
    try {
      store.append('duty.arm', 'plugin', { kinds: chosen, sessionId, scheduleId: entry?.id || '', force: Boolean(force) })
    } catch (err) {
      log(`值守依據鏈寫不進去：${err?.message || err}`)
    }
    log(`值守已起：${title} → ${sessionId || '(無會話 id)'}`)
    return { ok: true, title, sessionId, scheduleId: entry?.id || '', kinds: chosen, why, valley: inValley(now), at: store.runtime.armed?.at }
  }

  /** 上一輪值守的排程收尾：交給 Harness 跑完之後，把一次性任務從清單裡清掉。 */
  async function settle() {
    const armed = store.runtime.armed
    if (!armed?.scheduleId) return
    const svc = schedule()
    if (!svc?.view) return
    let status = 'unknown'
    try {
      const v = await svc.view({ id: armed.scheduleId })
      status = v?.status || v?.code || 'ended'
    } catch {
      status = 'gone'
    }
    const ageMin = (Date.now() - Date.parse(armed.at || '')) / 60000
    if (status === 'active' && ageMin < 60) return
    if (status === 'active' && ageMin >= 60) log(`值守排程 ${armed.scheduleId} 一小時仍未結束，先放掉`)
    store.runtime.armed = null
    store.persistRuntime()
    if (svc.edit && status !== 'gone') {
      try {
        await svc.edit({ id: armed.scheduleId, action: 'delete' })
      } catch {
        /* 排程清不掉不影響任何東西 */
      }
    }
  }

  function expireStalePendings(now = Date.now()) {
    let n = 0
    for (const p of store.pending.values()) {
      if (p.status !== 'open') continue
      const ageDays = (now - Date.parse(p.at || '')) / 86400000
      if (ageDays < 7) continue
      store.append('confirm.resolve', 'plugin', { id: p.id, approved: false, status: 'expired' })
      n += 1
    }
    return n
  }

  let ticking = false
  // 鏈校驗不必每一跳都做。
  //
  // verify() 本身已經很輕：只有帳本檔案的 size/mtime 變了才真的重放（見 store.verify）。
  // 但它每一跳都要 statSync 一次，而且「檔案沒變」本身就是答案 —— 沒必要每 60 分鐘問一次。
  // 所以再讓一層：每 VERIFY_EVERY 跳才碰到 verify，其餘直接跳過。
  // 真要立刻驗（例如頁面上按「驗鏈」）走的是 verify({ force: true })，跟這裡無關。
  const VERIFY_EVERY = 2 // 60 分鐘 × 2 = 約 2 小時驗一次
  let tickCount = 0
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      tickCount += 1
      if (tickCount % VERIFY_EVERY === 1) store.verify()
      expireStalePendings()
      await settle()
      if (!store.cfg.enabled) {
        if (store.runtime.armed) await disarm()
        return
      }
      const due = computeDue()
      if (!due.any) return
      const v = inValley()
      if (store.cfg.valleyOnly && !v.ok) return
      if (dutiesToday() >= Number(store.cfg.dutyMaxPerDay || 2)) return
      if (store.runtime.armed) return
      await arm()
    } catch (err) {
      store.runtime.lastError = `${err?.message || err}`
      store.persistRuntime()
      log(`值守心跳出錯：${err?.message || err}`)
    } finally {
      ticking = false
      store.runtime.lastTickAt = nowIso()
      store.persistRuntime()
      store.duty = info()
    }
  }

  return { info, arm, disarm, tick, computeDue, condensePlan, speak: (req) => speak({ ctx, store, log }, req), speakGate: () => store.speakGate() }
}

/**
 * 主動開口真正送出去的那一步。
 *
 * 為什麼放在這裡而不是 tools.js：只有宿主半端拿得到 `schedule` 服務，
 * 而「送進本人的會話」正是排程服務的本職。工具那邊只負責判定（谷時 + 本人許可）。
 *
 * ⚠️ 插件不替她決定「現在說合不合適」—— 那已經是她的判斷了。
 *   這裡只做兩件她做不到的事：確認現在是谷時、把訊息送到。
 */
async function speak({ ctx, store, log }, { text, kind, sessionId, reason } = {}) {
  const gate = store.speakGate()
  if (!gate.ok) return { ok: false, blocked: true, error: '現在不該開口', reasons: gate.reasons, gate }

  const said = String(text || '').trim()
  if (!said) return { ok: false, error: 'say 要給 text' }

  const svc = ctx.get('schedule')
  if (!svc?.create) {
    return { ok: false, error: '這個 profile 沒有 schedule 服務 —— 主動開口要靠它把訊息送進會話' }
  }

  // 送進哪：明確指定的 → 上次開過口的那個 → 否則另開一個。
  // ⚠️ 不預設「這個會話」：她在排程會話裡跑，那個會話本人不一定在看。
  const targetSessionId = String(sessionId || store.runtime.lastSpokeSession || '').trim()
  const title = `Silt · 她主動來說（${nowIso().slice(5, 16).replace('T', ' ')}）`

  let entry
  try {
    entry = await svc.create({
      title,
      prompt: said,
      // 她已經判斷過現在是合適的時候（而且現在就是谷時），不需要再等 ——
      // 等 4 秒只是讓本人手上那一輪跑完，不是延後。
      timing: { kind: 'after', after_seconds: 4 },
      target: targetSessionId ? { kind: 'session', sessionId: targetSessionId } : { kind: 'new_once', create: {} },
    })
  } catch (err) {
    // 舊會話可能已經被歸檔 —— 退一步另開一個，別讓一次開口整批失敗
    try {
      entry = await svc.create({ title, prompt: said, timing: { kind: 'after', after_seconds: 4 }, target: { kind: 'new_once', create: {} } })
    } catch (err2) {
      store.runtime.lastError = `主動開口送不出去：${err2?.message || err2}`
      store.persistRuntime()
      return { ok: false, error: store.runtime.lastError }
    }
  }

  const deliveredSession = entry?.target?.sessionId || targetSessionId || ''
  store.runtime.lastSpokeSession = deliveredSession
  const record = store.recordSpeak({ kind, text: said, deferred: false, reason, sessionId: deliveredSession, scheduleId: entry?.id || '' })
  log(`主動開口（${record.kind}，${gate.valley?.label || '谷時'}）→ ${deliveredSession || '(另開會話)'}`)
  return {
    ok: true,
    said,
    kind: record.kind,
    valley: gate.valley,
    scheduleId: entry?.id || '',
    sessionId: deliveredSession,
    at: record.at,
    spokenToday: store.spokenToday() + 1,
  }
}
