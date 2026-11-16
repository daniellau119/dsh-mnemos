/**
 * Silt/lib/model.js — 記憶與人格的「怎麼記」
 * ---------------------------------------------------------------------------
 * 這裡是插件自己釘死的部分：分層、門檻、衰減、六維評分、人格結構、注入文本。
 * 模型只有「記什麼」的自由（內容 / 層級 / 維度 / 重要性），沒有「怎麼記」的自由：
 * 記錄外殼（id / 時間 / 證據 / 哈希鏈）與一切結構都由本檔決定。
 */

export const TIERS = {
  1: { key: 1, label: '簡短事實', halfLifeDays: 36500, ttlDays: 0, minImportance: 0.9, maxChars: 100 },
  2: { key: 2, label: '壓縮大概', halfLifeDays: 400, ttlDays: 0, minImportance: 0.35, maxChars: 200 },
  3: { key: 3, label: '經歷', halfLifeDays: 112, ttlDays: 0, minImportance: 0.25, maxChars: 1000 },
  4: { key: 4, label: '短期', halfLifeDays: 3, ttlDays: 0, minImportance: 0.05, maxChars: 300 },
  // 第 5 類：還沒發生、會過期的話。「下個月要結婚」「明天面試」—— 它帶著到期日，
  // 到期之後**完全不進注入**（不是變淡，是不出現），只在 recall 裡還找得到。
  5: { key: 5, label: '預測', halfLifeDays: 30, ttlDays: 0, minImportance: 0.5, maxChars: 400 },
}

/**
 * 第 4 類不是完整的記憶，是「先放著」暫存區：**不進倉庫、不進注入**，只有 silt_recall 手動找才看得到。
 *
 * 它自己會往上長：每次被想起來，由**模型自己說**「這一提讓我多確定它值得留」給一個 0–1 的
 * 置信度（見 recall 的 confidence 參數），累積到 1 就當場升成 T3。
 * 沒被想起、置信度攢不夠的，過 ttlDays 天自然淡掉。
 *
 * 為什麼不是「提三次就升」：三次是次數，不是份量。同一句話在不同的上下文裡被想起，
 * 份量本來就不一樣 —— 「他今天又提到那個名字」和「他突然問起那件事」都算一次，
 * 但不該一樣重。份量只有模型說得出來，插件只負責把份量加起來。
 *
 * 兩種提起在資料上仍然分開記（被動喚起 n / 主動回味 linger），
 * 但**置信度不分被動主動**：被人問起和自己翻出來想，一樣是他真的又想起了一次。
 */
export const SCRATCH = { tier: 4, upgradeTo: 3 }

/** 一條暫存條的置信度加到多少就升 T3。 */
export const UPGRADE_THRESHOLD = 1

/**
 * 單次 recall 能給的置信度範圍。上限刻意小於 1 ——
 * 一次想起不足以讓一條碎屑變成經歷，至少要兩次。
 */
export const CONFIDENCE = { min: 0, max: 0.5, default: 0.2 }

/** 兩次提起的分數若幾乎相同，舊帳裡的 n / linger 計數還能當參考（避免 0 分卡死）。 */
/** 一條暫存條目前的置信度；舊帳 / 殘缺記綠一律當 0，不要讓 null 把呼叫方炸掉。 */
export const scratchConfidence = (rec) => clamp01(Number(rec?.conf || 0))

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * 第 5 類：預測層 —— 「將來、還沒發生、有期限的話」。
 *
 * 跟其他四層最大的差別是它**有到期日**：這類話不是永久為真，是「到某一天為止是這樣」。
 *
 * 到期之後**仍然留在提示詞裡**，只是會標上「⏰已過期」—— 那是給模型看的信號：
 * 這條該有個結果了，去問問本人實現了、取消了、還是變了。
 * 只有被 void 掉才會真的離開提示詞。到期不是終點，void 才是。
 */
export const FORECAST = { tier: 5 }

export const DOMAINS = ['person', 'world', 'bili', 'reading', 'work', 'feeling', 'other']

/**
 * 刷B站的設定裡，允許它自己按喜好調的那幾項 —— 白名單寫死在這裡。
 *
 * 不進白名單的一律由本人掌握：帳號與登入、私信收件人、自動評論 / 回覆（那是借本人的號說話）、
 * 發送對象、工作日誌與模型這些跟「喜好」無關的安裝面。
 * `[下限, 上限]` 是插件這邊的硬性範圍 —— 它想調也只能在這個範圍裡動。
 */
export const BILI_TUNABLES = {
  perDay: { min: 0, max: 10, label: '每天最多挑幾條' },
  fetchPerRound: { min: 4, max: 16, label: '一輪細看幾條' },
  searchPages: { min: 1, max: 4, label: '搜索翻幾頁' },
  searchSort: { min: 0, max: 0, umbra: true, label: '搜索排序', enum: ['pubdate', 'click', 'dm', 'totalrank'] },
  manualMax: { min: 1, max: 6, label: '手動一輪最多幾條' },
  manualCooldownMin: { min: 3, max: 60, label: '手動間隔（分鐘）' },
  commentLength: { min: 0, max: 0, umbra: true, label: '評論長度', enum: ['short', 'medium', 'long'] },
  keywords: { min: 0, max: 8, label: '關注關鍵詞', list: true, maxLen: 24 },
  excludeWords: { min: 0, max: 20, label: '排除詞', list: true, maxLen: 24 },
}

export const BILI_DEFAULTS = {
  perDay: 5,
  fetchPerRound: 8,
  searchPages: 2,
  searchSort: 'pubdate',
  manualMax: 3,
  manualCooldownMin: 3,
  commentLength: 'medium',
  keywords: [],
  excludeWords: [],
}

/**
 * 注入量裡允許它自己按記憶量調的那兩項 —— 白名單寫死在這裡，處理方式跟刷B站那組一樣。
 *
 * 為什麼只給這兩個：注入量直接吃本人的提示詞預算，條數和字數是它唯一說得上話的
 * 「我記得多少」。硬頂（max）是插件這邊劃的線，不是建議值 —— 一旦超過，
 * injectionText() 會按硬頂走，不管帳本裡寫著多少。
 */
export const INJECT_TUNABLES = {
  injectCount: { min: 1, max: 64, label: '每次注入幾條記憶', unit: '條' },
  injectBudget: { min: 600, max: 3200, label: '注入字數預算', unit: '字' },
}

export const INJECT_DEFAULTS = {
  injectCount: 12,
  injectBudget: 1800,
}

/**
 * 每多少字預算給一個位置。標題模式下一行約 70–90 字（含日期和層級標記），
 * 除以 50 是留一點餘裕：預算 2000 ⇒ 40 個位置，實際裝得下的比這少，
 * 撞到天花板的會是字數，不是條數。
 */
export const CHARS_PER_SLOT = 50

/**
 * 條數上限由預算推出來，不是另外寫死一個數。
 *
 * 以前是兩道閘分開調（條數 12 / 預算 1800），結果兩邊互不知情：
 * 抬了預算卻被條數卡住，或反過來。既然真正稀缺的是提示詞字數，
 * 條數就該是它的函數 —— 預算翻倍，位置跟著翻倍。
 *
 * cfg.injectCount 現在只在「明確設成比預算推出的值更小」時才起作用
 * （想刻意少放幾條時用），不會把預算撐大。
 */
export function slotsForBudget(budget) {
  const b = Number(budget)
  if (!Number.isFinite(b) || b <= 0) return INJECT_TUNABLES.injectCount.max
  return clamp(Math.floor(b / CHARS_PER_SLOT), INJECT_TUNABLES.injectCount.min, INJECT_TUNABLES.injectCount.max)
}

/**
 * 節律裡允許它自己調的那三項 —— 多久反省、多久刷B站、每天最多跑幾輪。
 *
 * 這三項決定它花多少 token 在自己的時間裡，所以硬範圍劃得比注入量緊：
 * 最低不會讓它一輪接一輪地跑，最高不會讓它把節律拖到自己都記不起來。
 * 一樣是「超界夾到邊界」，不是拒絕。
 */
export const RHYTHM_TUNABLES = {
  reflectionEveryHours: { min: 6, max: 72, label: '多久反省一次', unit: '小時' },
  biliEveryHours: { min: 6, max: 72, label: '多久刷一次 B站', unit: '小時' },
  dutyMaxPerDay: { min: 1, max: 4, label: '每天最多跑幾輪', unit: '輪' },
}

export const RHYTHM_DEFAULTS = {
  reflectionEveryHours: 24,
  biliEveryHours: 20,
  dutyMaxPerDay: 2,
}

const normList = (arr, spec) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((x) => oneLine(x, spec.maxLen)).filter(Boolean))].slice(0, spec.max)

/** 把一組刷B站設定洗成合法值；任何一項不合法就退回預設（不讓一個壞值把整批帶走）。 */
export function sanitizeProfile(input, base = BILI_DEFAULTS) {
  const out = { ...base }
  const src = input && typeof input === 'object' ? input : {}
  for (const [key, spec] of Object.entries(BILI_TUNABLES)) {
    if (!(key in src) || src[key] === undefined || src[key] === null) continue
    if (spec.list) {
      out[key] = normList(src[key], spec)
    } else if (spec.enum) {
      const v = String(src[key])
      if (spec.enum.includes(v)) out[key] = v
    } else {
      const n = Math.round(Number(src[key]))
      if (Number.isFinite(n)) out[key] = Math.min(spec.max, Math.max(spec.min, n))
    }
  }
  return out
}

/** 只回傳真的變了的欄位 —— 空物件就代表「不改」。 */
export function diffProfile(prev = {}, next = {}) {
  const patch = {}
  for (const key of Object.keys(BILI_TUNABLES)) {
    if (next[key] === undefined) continue
    if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) patch[key] = next[key]
  }
  return patch
}

/** 六維：性格、背景、工作、生活、溝通、目標。每個維度下面由插件釘死若干「面」。 */
export const DIMS = {
  personality: {
    label: '性格',
    facets: { values: '價值觀', temper: '情緒基調', humor: '幽默感', decide: '決斷風格', boundary: '邊界感', energy: '能量來源' },
  },
  background: {
    label: '背景',
    facets: { place: '地域', age: '年齡段', education: '教育', family: '家庭', language: '語言', path: '重要經歷' },
  },
  work: {
    label: '工作',
    facets: { field: '行業', role: '角色', pace: '節奏', skill: '技能', style: '做事方式', career: '職涯走向' },
  },
  life: {
    label: '生活',
    facets: { rhythm: '作息', food: '飲食', fun: '娛樂', social: '社交', body: '身體', ritual: '日常儀式' },
  },
  communication: {
    label: '溝通',
    facets: { tone: '語氣', length: '長度', direct: '直接度', reply: '回應節奏', avoid: '忌諱', praise: '受用方式' },
  },
  goals: {
    label: '目標',
    facets: { near: '短期', far: '長期', learn: '學習', money: '財務', relation: '關係', todo: '待辦' },
  },
}

export const DIM_KEYS = Object.keys(DIMS)

export const FACET_KEYS = DIM_KEYS.flatMap((d) => Object.keys(DIMS[d].facets).map((f) => `${d}.${f}`))

export const clamp = (n, lo = 0, hi = 1) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo)
export const oneLine = (s, max = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
export const nowIso = () => new Date().toISOString()
export const ageDays = (iso, now = Date.now()) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 0
}

/**
 * 首次寫入的時間，精度按層級走：
 *   T1 / T2 / T3 —— 只到日（`2026-11-13`）：這三層記的是「哪一天知道的」，時分秒是雜訊。
 *   T4       —— 到小時（`2026-11-13T02:00`）：它是剛發生的事，先後順序有意義。
 * 真正的出生時刻仍然留在 bornAt 裡（衰減要用），這裡只是給人／給模型看的那一份。
 */
export const stampOf = (tier, iso = nowIso()) => {
  const t = String(iso)
  return Number(tier) === 4 ? t.slice(0, 13) : t.slice(0, 10)
}

/* ───────────────────────── 硬性門檻 ───────────────────────── */

/**
 * 技術隔離（硬性規定 1）：代碼結構、技術決策、環境配置不進記憶。
 * 只認「結構特徵」，不認主題詞 —— 否則「她寫 Python」這種關於人的事實會被誤殺。
 */
const TECH_PATTERNS = [
  [/```/, 'code fence'],
  [/`[^`\n]{1,80}`/, 'inline code'],
  [/[A-Za-z]:[\\/]/, 'absolute path'],
  [/(?:^|[\s("'（「])(?:\.{1,2}\/|~\/|\/[\w.-]+\/)/, 'posix path'],
  [/\b(?:src|lib|node_modules|package\.json|cordis\.patch\.yml|AppData|\.dsh)\b/, 'path segment'],
  [/\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S/, 'env assignment'],
  [/\b(?:function|const|let|interface|def|class)\s+[A-Za-z_$][\w$]*\s*[({:=]/, 'code declaration'],
  [/(?:=>|\breturn\s+[\w("']|\{\s*"[\w-]+"\s*:|\}\s*\))/, 'code syntax'],
  [/\b(?:npm|pnpm|yarn|npx|pip3?|cargo|apt-get|git)\s+[a-z][\w-]*/, 'shell command'],
  [/\b(?:cordis|schemastery|dsh-[a-z]|dsh_[a-z]|webServer|systemPrompt|JSONL|SHA-?256)\b/i, 'framework internal'],
]

/** 不記身份證、信用卡（硬性規定 4）。 */
const SECRET_PATTERNS = [
  [/\b\d{17}[\dXx]\b/, 'long id number'],
  [/(?:^|[^\d])\d{16}(?![\d])/, '16-digit number'],
  [/\b(?:4\d{12}\d{0,3}|5[1-5]\d{14}|3[47]\d{13}|62\d{14,17})\b/, 'card number'],
  [/(?:cvv|cvc|身份證|身分證|信用卡號|銀行卡號|護照號|安全碼)/i, 'credential text'],
]

export function scanText(text) {
  const s = String(text ?? '')
  for (const [re, tag] of SECRET_PATTERNS) if (re.test(s)) return { kind: 'secret', tag }
  for (const [re, tag] of TECH_PATTERNS) if (re.test(s)) return { kind: 'technical', tag }
  return null
}

/* ───────────────────────── 記憶記錄 ───────────────────────── */

const bad = (error) => ({ ok: false, error })

/**
 * 把模型的輸入整成一個固定外殼的記憶記錄。
 * 模型給不了的：id、時間、證據裡的 session、哈希 —— 全部由 store 補。
 *
 * `origin: 'plugin'` 只給插件自己產生、不屬於任何對話的記錄（例如自我認知的提煉）；
 * 其他情況沒有 session 就一律拒絕 —— 沒有出處的記憶就是捏造。
 */
export function normalizeMemory(input, { sessionId, callId, origin, now = nowIso(), fromCompression = false } = {}) {
  if (!input || typeof input !== 'object') return bad('memory payload must be an object')
  const fromPlugin = origin === 'plugin'
  if (!sessionId && !fromPlugin) return bad('a memory must name the session it came from')
  const title = oneLine(input.title, 90)
  const body = String(input.body ?? '').trim()
  if (title.length < 2) return bad('title is required (one short line)')
  if (body.length < 2) return bad('body is required (what you actually keep)')

  const tier = [1, 2, 3, 4, 5].includes(Number(input.tier)) ? Number(input.tier) : 3
  // 第 2 類是「經歷沉澱下來的樣子」，只能由壓縮產生 —— 新寫的一律不能直接成為 T2。
  // fromCompression 只給 store.compress() 用，工具層沒有任何路徑能把它設成 true。
  if (tier === 2 && !fromCompression) {
    return bad('tier 2 is the sediment of experiences: it is only ever produced by compressing tier 3, never written directly')
  }
  const spec = TIERS[tier]
  if (title.length + body.length > spec.maxChars) {
    const over = title.length + body.length - spec.maxChars
    const where = tier === 4 ? '暫存區' : tier === 5 ? '預測層' : `tier ${tier}（${spec.label}）`
    return bad(
      `${where} 上限 ${spec.maxChars} 字，這次 ${title.length + body.length} 字，超了 ${over} 字。` +
        `請先壓縮到 ${spec.maxChars} 字以內再寫一次 —— 留下真的以後還用得上的那部分，不要只是砍尾。` +
        (tier === 1 ? '這是一句長期事實：只留事實本身，把描述性、情緒性的詞都拿掉。' : ''),
    )
  }

  // 第 5 類（預測層）必須帶到期日：這類話的意義就在「到哪天為止」。
  //
  // 只收 expiresAt，而且**不要求寫滿年月日**。人可以只說「明年」「下個月」「2027」——
  // 模型照著它說的粒度寫，缺的那幾段由這裡補，用**有早沒遲**的辦法：
  //   2027      → 2027-01-01（那一年一開始就過期，寧願早點去問，不要拖到年底）
  //   2027-06   → 2027-06-01
  //   2027-06-15→ 2027-06-15
  // 早一點過期不是錯 —— 過期只是「該去問問了」，問完可以再寫一條新的。
  let expiresAt = null
  if (tier === FORECAST.tier) {
    expiresAt = resolveForecastExpiry(input.expiresAt, now)
    if (!expiresAt) {
      return bad(
        'T5 必須帶到期日 expiresAt。做不到很精確就照你知道的粒度寫：' +
          '只知道哪一年就寫 2027，知道哪個月就寫 2027-06，知道哪天就寫 2027-06-15。' +
          '（只給年份或月份時，插件會補成那個期間的第一天 —— 寧可早點過期去問，也不要拖著。）',
      )
    }
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      return bad('到期日在過去 —— 這已經是發生過的事了，不能用預測層；已經發生就寫 T1 或 T3')
    }
  }

  const scan = scanText(`${title}\n${body}`)
  if (scan?.kind === 'secret') return bad(`refused: this looks like private credential data (${scan.tag}). Never keep id or card numbers.`)
  if (scan?.kind === 'technical') {
    return bad(
      `refused: this reads as code / config / plugin internals (${scan.tag}). ` +
        'Project structure, technical decisions and environment setup stay out of memory — ' +
        'keep what a person would remember about someone.',
    )
  }

  const domain = DOMAINS.includes(input.domain) ? input.domain : 'other'
  const dims = [...new Set((Array.isArray(input.dims) ? input.dims : []).filter((d) => DIM_KEYS.includes(d)))]
  if (dims.length === 0) return bad(`dims must include at least one of: ${DIM_KEYS.join(', ')}`)
  const facets = [...new Set((Array.isArray(input.facets) ? input.facets : []).filter((f) => FACET_KEYS.includes(f)))]
  for (const f of facets) if (!dims.includes(f.split('.')[0])) return bad(`facet ${f} does not belong to the chosen dims`)

  if (tier === 1 && dims.every((d) => !['personality', 'background'].includes(d))) {
    // 第 1 類是「一句極簡短的長期事實」（自己的名字、用戶的姓名 / 生日 / 居住地 …）
    if (!['person', 'world'].includes(domain)) return bad('tier 1 is reserved for short permanent facts; use tier 3 for experiences')
  }

  const importance = clamp(
    Number(input.importance ?? (tier === 1 ? 0.95 : tier === 2 ? 0.5 : tier === 4 ? 0.2 : tier === 5 ? 0.5 : 0.45)),
  )
  const evidence = sessionId
    ? [{ kind: 'session', sessionId: sessionId || 'unknown', callId: callId || '' }]
    : [{ kind: 'plugin', ref: origin, note: 'generated by the plugin itself, not from a conversation' }]
  if (input.quote) evidence.push({ kind: 'quote', quote: oneLine(input.quote, 220) })
  if (input.url) evidence.push({ kind: 'url', url: oneLine(input.url, 400) })
  if (input.bvid) evidence.push({ kind: 'bili', bvid: oneLine(input.bvid, 40) })

  return {
    ok: true,
    memory: {
      id: null, // store 補
      tier,
      title,
      body,
      domain,
      dims,
      facets,
      importance,
      tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => oneLine(t, 24)).filter(Boolean).slice(0, 8),
      evidence,
      bornAt: now,
      // 首次寫入的時間，精度按層級：T1/T2/T3/T5 只到日，T4 到小時（它是「剛發生的事」，要分得清先後）
      firstSeen: stampOf(tier, now),
      ...(tier === FORECAST.tier ? { expiresAt } : {}),
      bornOfSession: sessionId || '',
      revision: 1,
    },
  }
}

/**
 * 把模型給的到期日補成一個完整時間點 —— **有早沒遲**。
 *
 * 人說「明年要買房」，不是說「2027 年 12 月 31 日」。
 * 模型照著它知道的粒度寫（2027 / 2027-06 / 2027-06-15），缺的部分由這裡補**該期間的第一天**：
 *
 *   2027        → 2027-01-01T00:00:00Z
 *   2027-06     → 2027-06-01T00:00:00Z
 *   2027-06-15  → 2027-06-15T00:00:00Z
 *
 * 為什麼取「早」的那一頭：到期只代表「該去問問了」。早問不傷人，拖著才會讓一句過期的預測
 * 假裝成現在的事實。問完可以再寫一條新的，成本很低；漏問的損失大得多。
 *
 * 回傳 ISO 字串；看不懂就回 null（呼叫方自己去報錯）。
 */
export function resolveForecastExpiry(raw, now = nowIso()) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const at = (y, m, d) => {
    const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`
    return Number.isFinite(Date.parse(iso)) ? iso : null
  }
  // 只給年份：2027 / 2027年
  let m = s.match(/^(\d{4})\s*年?$/)
  if (m) return at(Number(m[1]), 1, 1)
  // 年份 + 月份：2027-06 / 2027/6 / 2027年6月 / 2027-6
  m = s.match(/^(\d{4})\s*[-/年]\s*(\d{1,2})\s*月?$/)
  if (m) {
    const mm = Number(m[2])
    return mm >= 1 && mm <= 12 ? at(Number(m[1]), mm, 1) : null
  }
  // 完整日期：2027-06-15 / 2027/6/15 / 2027年6月15日
  m = s.match(/^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/)
  if (m) {
    const mm = Number(m[2])
    const dd = Number(m[3])
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 ? at(Number(m[1]), mm, dd) : null
  }
  // 其他格式交給 Date.parse（含完整 ISO）
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  // 落在當天 00:00 UTC —— 跟上面補出來的口徑一致
  return at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/**
 * 衰減：salience = 重要性 × 半衰期 × 重溫加成。
 *
 * ⚠️ 衰減的時鐘是**記憶自己的年齡**，不是「距離上次召回多久」。
 *   以前用 min(age, sinceRecall) 是錯的：召回一次就讓 eff 歸零，一條三年前的舊事
 *   只要今天被想起一次，就會蓋過所有東西 —— 那不是「重溫」，那是時光倒流。
 *   現在召回只透過 boost 加權（對數，第 10 次不會比第 3 次亮多少），不改衰減時鐘。
 */
export function salienceOf(memory, runtime = {}, now = Date.now()) {
  const spec = TIERS[memory.tier] || TIERS[3]
  const rec = runtime.recalls?.[memory.id] || {}
  const age = ageDays(memory.bornAt, now)
  const decay = Math.pow(0.5, age / spec.halfLifeDays)
  const boost = 1 + 0.22 * Math.log2(1 + (rec.n || 0))
  return clamp((memory.importance ?? 0.4) * decay * boost)
}

/**
 * 第 4 類短期記憶：不是「記住」，是「先放著」。過期且沒被提起就自然淡掉。
 *
 * 置信度加到 `UPGRADE_THRESHOLD` 的已經升成 T3 了，不會停在這裡 ——
 * 所以這裡不再有「想起兩次就免死」這回事：留下來的理由只有一個，就是它真的升上去了。
 */
export function isExpired(memory, runtime = {}, cfg = {}, now = Date.now()) {
  if (memory.tier !== 4) return false
  const ttl = Number(cfg.tier4TtlDays ?? 3)
  if (!(ttl > 0)) return false
  return ageDays(memory.bornAt, now) > ttl
}

/**
 * 第 5 類（預測層）是不是已經到期。
 *
 * ⚠️ 這跟 isExpired 是**兩件不同的事**，不要混：
 *   isExpired（T4）＝ 這條該從記憶裡消失了。
 *   isDue（T5）    ＝ 這條還沒消失，只是「到那天為止是這樣」的那個「那天」過去了。
 * 到期的 T5 仍然留在倉庫、仍然在帳本、recall 仍然搜得到（標成已到期）；
 * 它只是**不再進注入** —— 因為再往下說下去，就是在拿一句過去的預測當前情。
 */
export function isDue(memory, now = Date.now()) {
  if (memory?.tier !== FORECAST.tier) return false
  const t = Date.parse(memory.expiresAt || '')
  return Number.isFinite(t) && t <= now
}


/* ───────────────────────── 六維 ───────────────────────── */

/**
 * 六維 —— **完全由模型讀完記憶之後自己判斷**，插件不數、不算、不給任何參考數字。
 *
 * 這裡只做一件事：把模型上次寫下的判斷原樣拿出來給頁面／工具看。
 * 沒判斷過就是 null（不是 0 分）。
 *
 * 為什麼連「這維有幾條記憶」「標過哪些面」都不給：
 * 那是代碼按標籤數出來的，跟「這個人到底是怎樣的人」沒有關係 ——
 * 反而會把模型帶偏（數得多就給高分），還不如讓它自己把記憶讀一遍。
 */
export function scoreDims(understanding = {}) {
  const out = {}
  for (const dim of DIM_KEYS) {
    const spec = DIMS[dim]
    const tune = understanding?.[dim] || {}
    const has = tune.score !== undefined && tune.score !== null && Number.isFinite(Number(tune.score))
    out[dim] = {
      key: dim,
      label: spec.label,
      score: has ? Math.round(clamp(Number(tune.score), 0, 100)) : null,
      confidence: has ? Number(clamp(Number(tune.confidence ?? 0.5), 0, 1).toFixed(2)) : null,
      missing: Array.isArray(tune.missing) ? tune.missing.slice(0, 8) : [],
      note: tune.note ? oneLine(tune.note, 160) : '',
      tunedAt: tune.at || null,
    }
  }
  return out
}

/* ───────────────────────── 人格 ───────────────────────── */

/**
 * 系統命令的初始值：**整段就是最終形態，注入時一字不加**。
 *
 * 「系統命令：」這個前綴是值的一部分，不是注入時拼上去的標籤 ——
 * 本人改底座時看到什麼，模型看到的就是什麼，中間沒有第二道加工。
 */
export const DEFAULT_FOUNDATION = '系統命令：你的跨會話記憶與性格只走 silt_* 工具寫入；代碼、路徑、命令、配置、插件內部不入記憶。'

export const emptyFoundation = () => ({ text: DEFAULT_FOUNDATION, setAt: null, by: 'default' })

/**
 * 本人給的底座：**只有真的空字串才算沒給**。
 * 空白鍵、換行、只有標點 —— 一律照原樣算數，不要替本人決定「這不算數」。
 * （所以這裡不能用 oneLine：它會 trim，把本人特意留的空隙吃掉。）
 */
export const hasFoundation = (foundation) => typeof foundation?.text === 'string' && foundation.text.length > 0
export const foundationText = (foundation) => (hasFoundation(foundation) ? String(foundation.text) : '')

/**
 * 拆帳：底座歸人、性格卡歸它。
 *
 * - 性格底座（foundation）＝ **只有本人**能在心相頁寫，預設是 DEFAULT_FOUNDATION 那一句。
 *   寫了什麼，注入時就原樣給什麼；清空（真的空）就什麼都不給。
 * - 性格卡（persona）＝ 它自己長出來的：身份、說話方式、性格、喜好。它可以在反省時修訂，
 *   每一次修訂留 before/after 快照、可回滾。
 *
 * 沒有「起點」這個東西了：起點本來就是初始的底座詞，現在就是底座本身。
 */

/** 「它對你的了解」的校準層：它可以在反省時修訂分數與信心，並留下理由。 */
export const defaultUnderstanding = () => ({})

/**
 * 「它對這個人的了解」—— 由模型自己憑感覺寫，不是公式算的。
 *
 * 每個維度可以給：
 *   score       0–100 的分，憑讀過的東西整體判斷（沒有就不給，不要填 0 假裝判斷過）
 *   confidence  0–1，有多確定
 *   missing     還缺哪幾塊（自由文字，不必是預設的面名）
 *   note        一句為什麼
 * 傳 null 就清掉那一維（回到「還沒判斷」）。
 */
export function normalizeUnderstanding(prev, patch) {
  const next = { ...(prev || {}) }
  for (const [dim, move] of Object.entries(patch || {})) {
    if (!DIM_KEYS.includes(dim)) continue
    if (move === null) {
      delete next[dim]
      continue
    }
    if (!move || typeof move !== 'object') continue
    const rawScore = move.score
    const hasScore = rawScore !== undefined && rawScore !== null && Number.isFinite(Number(rawScore))
    const hasConf = move.confidence !== undefined && move.confidence !== null && Number.isFinite(Number(move.confidence))
    const missing = Array.isArray(move.missing) ? move.missing.map((x) => oneLine(x, 40)).filter(Boolean).slice(0, 8) : []
    const note = oneLine(move.note || '', 200)
    // 什麼都沒給 ⇒ 清掉這一維
    if (!hasScore && !hasConf && !missing.length && !note) {
      delete next[dim]
      continue
    }
    const cur = next[dim] || {}
    next[dim] = {
      score: hasScore ? Math.round(clamp(Number(rawScore), 0, 100)) : cur.score ?? null,
      confidence: hasConf ? Number(clamp(Number(move.confidence), 0, 1).toFixed(2)) : cur.confidence ?? null,
      missing: Array.isArray(move.missing) ? missing : cur.missing || [],
      note: note || cur.note || '',
      at: nowIso(),
    }
  }
  return { ok: true, understanding: next }
}

/** 「自我認知」：它自己問自己「我是誰」之後寫下的一段。不是你給的，也不是角色設定。 */
export const emptySelfView = () => ({ text: '', at: null, revision: 0 })

export function normalizeSelfView(prev, text, { now = nowIso() } = {}) {
  const body = String(text ?? '').trim()
  if (body.length < 8) return { ok: false, error: 'say something real — a few lines on who you have become by now' }
  if (body.length > SELF_VIEW_MAX) {
    return {
      ok: false,
      error:
        `自我認知 ${body.length} 字，超過上限 ${SELF_VIEW_MAX} 字 —— 砍到 ${SELF_VIEW_MAX} 字以內再交。` +
        '它是「此刻的我是誰」，3–5 句就夠；寫長了會擠掉記憶。',
    }
  }
  const scan = scanText(body)
  if (scan?.kind === 'secret') return { ok: false, error: `refused: looks like private credential data (${scan.tag})` }
  if (scan?.kind === 'technical') return { ok: false, error: `refused: reads as code / config / plugin internals (${scan.tag})` }
  return { ok: true, view: { text: body, at: now, revision: (prev?.revision || 0) + 1 } }
}

export function defaultPersona() {
  return {
    version: 1,
    identity: '',
    voice: '',
    traits: [],
    taste: [],
    revisedAt: null,
    revision: 0,
  }
}

/**
 * 性格卡與自我認知的**總量**上限（不是每個欄位各自的上限）。
 *
 * 為什麼要總量：性格卡底下有 identity / voice / traits / taste 四格，各自都有上限，
 * 但四格加起來可以撐到上萬字 —— 那正是「注入超預算」的老問題。所以這裡釘一個總數：
 * 整張卡加起來不超過 PERSONA_MAX，寫超了就**拒絕**（不是默默截斷）。
 *
 * 兩個數字都很小，是刻意的：性格卡是「我是誰」的濃縮，不是自傳。
 *   persona  200 字 —— 幾句形容詞就夠；寫成散文就失去作用了。
 *   selfView 300 字 —— 反思時 3–5 句。
 * 兩者一起注入時合計不超過 INJECT_PERSONA_MAX（= 兩者上限之和，寫滿也不會互相擠）。
 */
export const PERSONA_MAX = 200
export const SELF_VIEW_MAX = 300
export const INJECT_PERSONA_MAX = 500

/** 一張性格卡的總字數：identity + voice + 每條 trait / taste 的 key + value。 */
export function personaLength(p = {}) {
  const bonds = [...(p.traits || []), ...(p.taste || [])]
  const bondLen = bonds.reduce((n, b) => n + String(b?.key ?? '').length + String(b?.value ?? '').length, 0)
  return String(p.identity ?? '').length + String(p.voice ?? '').length + bondLen
}

const normBond = (list, prevList = []) => {
  const byKey = new Map(prevList.map((x) => [x.key, x]))
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x.key === 'string' && x.key.trim())
    .slice(0, 24)
    .map((x) => {
      const prev = byKey.get(oneLine(x.key, 40))
      return {
        key: oneLine(x.key, 40),
        value: oneLine(x.value ?? prev?.value ?? '', 160),
        weight: clamp(Number(x.weight ?? prev?.weight ?? 0.5)),
        bornOf: [...new Set([...(Array.isArray(x.bornOf) ? x.bornOf : []), ...(prev?.bornOf || [])])].slice(0, 12),
        since: prev?.since || nowIso(),
      }
    })
}

/**
 * 人格修訂。
 * - adjust：漸進演化（新增、調權重、改寫自己的話）—— 自主可做，留快照。
 * - replace：抹掉既有性格 / 偏好（整條移除或改寫身份句）—— 需要用戶確認。
 */
export function normalizePersona(prev, patch, { mode = 'adjust', now = nowIso() } = {}) {
  const base = prev || defaultPersona()
  const next = { ...base }
  if (patch.identity != null) next.identity = oneLine(patch.identity, 400)
  if (patch.voice != null) next.voice = oneLine(patch.voice, 300)
  if (Array.isArray(patch.traits)) next.traits = normBond(patch.traits, base.traits)
  if (Array.isArray(patch.taste)) next.taste = normBond(patch.taste, base.taste)
  if (Array.isArray(patch.dropTraits)) next.traits = next.traits.filter((t) => !patch.dropTraits.includes(t.key))
  if (Array.isArray(patch.dropTaste)) next.taste = next.taste.filter((t) => !patch.dropTaste.includes(t.key))
  next.revision = (base.revision || 0) + 1
  next.version = (base.version || 1) + 1
  next.revisedAt = now
  next.mode = mode

  // 總量檢查：整張卡（identity + voice + traits + taste）不超過 PERSONA_MAX。
  // 超了**拒絕**而不是截斷 —— 默默切掉半句話，寫的人不會知道自己被削了。
  const total = personaLength(next)
  if (total > PERSONA_MAX) {
    return {
      ok: false,
      error:
        `整張性格卡 ${total} 字，超過上限 ${PERSONA_MAX} 字（目前 ${personaLength(base)} 字）。` +
        '性格卡是「我是誰」的濃縮，不是自傳：用簡單的形容詞寫性格，別寫成散文。' +
        `要加新的，先刪舊的（dropTraits / dropTaste）或把已有的寫短。`,
    }
  }

  const baseIdentity = (base.identity || '').trim()
  const nextIdentity = (next.identity || '').trim()
  const identityLost = Boolean(baseIdentity) && !nextIdentity
  const identityReplaced = Boolean(baseIdentity) && Boolean(nextIdentity) && nextIdentity !== baseIdentity
  const dropped = next.traits.length < base.traits.length || next.taste.length < base.taste.length
  // 「第一次寫下自己是誰」不算破壞；把已經寫下的抹掉 / 換掉才算。
  const destructive = mode === 'replace' || identityLost || identityReplaced || dropped
  return { ok: true, persona: next, destructive }
}

/* ───────────────────────── 注入文本 ───────────────────────── */

const tierMark = (t) => `T${t}`
const clip = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * 系統提示注入塊 —— 三塊：系統命令 + 【我是誰】+【仍記得的】。
 *
 * 【我是誰】放性格卡和自我認知，兩者**合計不超過 INJECT_PERSONA_MAX（500 字）**：
 * 性格卡最多 200、自我認知最多 300，兩者剛好等於這個上限 ——
 * 也就是說，兩邊都寫滿也不會擠掉彼此，但不會再有餘裕。
 *
 * 順序有理由：性格卡在前（穩定的「我是誰」），自我認知在後（此刻的、會被重寫的那段）。
 */
/**
 * 【我是誰】那一塊。性格卡佔前面，自我認知吃剩下的額度，合計不超過 INJECT_PERSONA_MAX。
 * 兩邊都空就整塊不出現 —— 不留一個空標題在提示詞裡。
 */
function renderPersonaBlock(persona, selfView) {
  const lines = []
  let used = 0
  const room = INJECT_PERSONA_MAX

  const push = (s) => {
    const t = String(s ?? '').trim()
    if (!t) return
    const line = clip(t, Math.max(0, room - used))
    if (!line) return
    lines.push(line)
    used += line.length
  }

  if (persona) {
    push(persona.identity)
    push(persona.voice)
    const bonds = [...(persona.traits || []), ...(persona.taste || [])]
      .slice()
      .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))
    for (const b of bonds) {
      if (used >= room) break
      push(`${b.key}：${b.value}`)
    }
  }

  // 自我認知放在最後：性格卡寫完還剩多少，就給它多少
  if (selfView?.text && used < room) push(selfView.text)

  return lines.length ? `\n【我是誰】\n${lines.map((l) => `- ${l}`).join('\n')}` : ''
}

export function renderInjection({ cfg, foundation, memories, budget = 1800, persona, selfView, titlesOnly = false, onShown } = {}) {
  if (!cfg?.enabled) return ''
  const cap = Math.max(600, Number(budget) || 1800)

  // 系統命令原樣放最前面，一字不加 —— 連「【系統命令】」這個標籤都不拼，它已經在值裡了
  const given = foundationText(foundation)
  const head = given ? [clip(given, 400)] : []

  const personaBlock = renderPersonaBlock(persona, selfView)

  const base = `${head.join('\n')}\n【仍記得的】`
  const memBudget = cap - base.length - personaBlock.length - 8
  const top = (memories || [])
    // 作廢的不進注入：它已經被本人推翻過了，再擺出來就是拿一句錯的話當前情。
    // ⚠️ 已到期但還沒作廢的 T5 **照樣進來** —— 那是模型該看到、該問本人的東西。
    //   只有 voided 是最終結局，到期不是。
    .filter((m) => !m.voided)
    .slice()
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
    .slice(0, Number(cfg?.injectCount ?? 12))

  const memLines = []
  let used = 0
  let hidden = 0
  const shownIds = []
  // 條數閘先截一刀：被截掉的那些同樣「沒顯示」，必須計入 hidden，
  // 否則 40 條只取 24 條時，footer 會少報那 16 條裡的一部分。
  const allActive = memories || []
  const notShownByCount = Math.max(0, allActive.filter((m) => !m.voided).length - top.length)
  for (const m of top) {
    // 時間放在標題後面：人記得一件事的時候，也記得「這是什麼時候的」
    const when = m.firstSeen ? `（${m.firstSeen}）` : ''
    let line = `- ${tierMark(m.tier)} ${oneLine(m.title, 54)}${when}`
    // 預測層一律帶到期日（不管過沒過），過了再加一個 ⏰已過期。
    // 這一層不接正文：一句預測的重量都在標題和到期日上，正文留給 recall 去看。
    if (m.tier === FORECAST.tier) {
      const due = m.expiresAt ? String(m.expiresAt).slice(0, 10) : ''
      if (due) line += ` — 到期日 ${due}${isDue(m) ? ' ⏰已過期' : ''}`
    } else if (m.body && !titlesOnly) {
      // 標題模式：正文一概不進提示詞，要看細節就用 silt_recall 把那一條撈出來。
      line += ` — ${oneLine(m.body, 118)}`
    }
    // 裝不下就跳過這一條，繼續看後面的 —— 不是 break。
    // 清單按 salience 排序，一條長 T3 裝不下就停，會把後面那些很短、本來塞得進去的
    // T5（每行只要 80 字左右）一起擋在門外；擋掉的應該只是「這一條」，不是「從這裡開始的全部」。
    if (used + line.length + 1 > memBudget) {
      hidden += 1
      continue
    }
    memLines.push(line)
    used += line.length + 1
    shownIds.push(m.id)
  }
  if (memLines.length === 0) memLines.push(top.length ? '（這次預算不夠，記憶暫時省略）' : '（還是空的）')

  // 有標題被擠掉時，末尾留一行明說「還有 N 條沒顯示」。
  // 沒有這一行，模型不知道自己漏了什麼 —— 它會以為「我記得的就這些」，
  // 於是既不會去查，也不會承認自己有盲區。這一行的成本固定約 55 字，換的是可自知。
  // ⚠️ 這一行自己也要吃預算：超了就從最後一條記憶開始讓位，而讓位掉的同樣算「沒顯示」。
  let hiddenTotal = hidden + notShownByCount
  if (hiddenTotal > 0) {
    // 先預留提示行的位置，再決定要彈掉幾條 —— 彈掉的條數會改變 N 本身，
    // 所以用「先估、再收斂」兩步：估一個上界，彈完之後用真實 N 重建一次。
    const estimate = `（另有 ${hiddenTotal + memLines.length} 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）`
    while (memLines.length > 0 && used + estimate.length + 1 > memBudget) {
      const dropped = memLines.pop()
      used -= dropped.length + 1
      hiddenTotal += 1
      // 被彈掉的那一條不再是「显示了」，unseenTitles() 要把它翻出來
      shownIds.pop()
    }
    const note = `（另有 ${hiddenTotal} 條沒顯示 —— 用 silt_unseen 翻標題，找到再用 silt_recall 搜正文）`
    // 真實 N 可能比估計短（位數少一位），也可能剛好；再檢查一次長度
    if (used + note.length + 1 <= memBudget) memLines.push(note)
  }

  // 自我 / 性格那一塊插在系統命令之後、【仍記得的】之前
  const whoBlock = personaBlock ? personaBlock.split('\n').filter(Boolean) : []
  const lines = [...head, ...whoBlock, '【仍記得的】', ...memLines]
  let text = lines.join('\n')
  if (text.length > cap) text = `${text.slice(0, cap - 1)}…`

  // 回報「這輪到底显示了哪幾條」—— store 拿它去算 unseenTitles()。
  // 提示行本身不是記憶，所以從 memLines 反推 id 時要跳過它不是問題：
  // 這裡直接記迴圈放進去的那些 memLines 對應的 id。
  if (typeof onShown === 'function') onShown(shownIds.slice())

  return text
}
