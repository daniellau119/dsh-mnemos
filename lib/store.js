/**
 * mnemos/lib/store.js — 不可靜默抹除的依據鏈 + 可回滾的快照
 * ---------------------------------------------------------------------------
 * 只有一個真檔案：`<家>/ledger.jsonl`（append-only）。當前記憶、人格、待確認清單、
 * 快照清單全部是它的「投影」—— 由 head 重放出來，不是另一份可被隨手改寫的狀態檔。
 *
 * 每筆記錄：
 *   { v, seq, ts, kind, actor, payload, prev, hash }
 *   hash = sha256(canonical({v,seq,ts,kind,actor,payload,prev}))
 *   prev = 上一筆的 hash（創世記 prev = 64 個 0）
 *
 * 「不可靜默抹除」＝ 任何一筆被抽掉 / 改動，重放時 hash 鏈會在那一點斷掉，
 * 插件頁面會把它標成紅色並拒絕回滾。想修，只能留下一筆 `chain.repair` 說明發生過甚麼。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIMS,
  DIM_KEYS,
  FORECAST,
  INJECT_TUNABLES,
  RHYTHM_TUNABLES,
  SCRATCH,
  TIERS,
  clamp,
  defaultPersona,
  defaultUnderstanding,
  emptyFoundation,
  emptySelfView,
  isDue,
  isExpired,
  normalizeMemory,
  normalizePersona,
  normalizeSelfView,
  normalizeUnderstanding,
  nowIso,
  oneLine,
  renderInjection,
  salienceOf,
  scanText,
  scoreDims,
  stampOf,
} from './model.js'

export const SCHEMA_VERSION = 1
const ZERO = '0'.repeat(64)

const DEFAULT_CONFIG = {
  enabled: false,
  bili: false,
  reflection: true,
  valleyOnly: true,
  injectCount: 12,
  injectBudget: 1800,
  tier4TtlDays: 3,
  reflectionEveryHours: 24,
  biliEveryHours: 20,
  dutyMaxPerDay: 2,
}

/* ───────────────────────── 規範化與哈希 ───────────────────────── */

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

const digest = (value) => createHash('sha256').update(String(value)).digest('hex')

const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

/**
 * 舊帳補漏：這個欄位是後來才加的，之前寫下的記憶沒有它。
 * 用它們自己的 bornAt 補出同一個精度（T1/T2/T3 到日、T4 到小時），
 * 不另外落帳 —— 這是「同一件事的舊寫法」，不是一次新的寫入。
 */
const withFirstSeen = (m) => {
  if (!m || typeof m !== 'object' || m.firstSeen) return m
  return { ...m, firstSeen: stampOf(m.tier, m.bornAt || nowIso()) }
}

const hashOf = (body) =>
  digest(
    stableStringify(
      plain({ v: body.v, seq: body.seq, ts: body.ts, kind: body.kind, actor: body.actor, payload: body.payload, prev: body.prev }),
    ),
  )

/** 鏈條狀態的空白形狀。 */
const blankChain = () => ({ ok: true, reason: null, count: 0, head: ZERO, brokenAt: null, note: '', contentBreaks: [], sealed: false })

/* ───────────────────────── 快照輔助 ───────────────────────── */

let snapCounter = 0
const newSnapshotId = () => {
  snapCounter = (snapCounter + 1) % 1000
  return `s-${Date.now().toString(36)}${String(snapCounter).padStart(2, '0')}`
}

const snapshotOf = (scope, label, before, after) => ({ id: newSnapshotId(), scope, label, before, after, at: nowIso() })

const emptyRuntime = () => ({
  recalls: {},
  lastReflectionAt: null,
  lastBiliAt: null,
  armed: null,
  lastTickAt: null,
  dutyLog: [],
  lastError: '',
  selfMemoryId: '',
  biliTuned: {},
  biliTunedAt: null,
})

export class Store {
  constructor(home, seedConfig = {}) {
    this.home = home
    this.ledgerPath = join(home, 'ledger.jsonl')
    this.configPath = join(home, 'config.json')
    this.runtimePath = join(home, 'runtime.json')
    this.exportPath = join(home, 'ledger.export.jsonl')

    this.schemaVersion = SCHEMA_VERSION
    this.records = []
    this.chain = blankChain()
    this.chainFingerprint = ''
    this.memories = new Map()
    this.snapshots = new Map()
    this.pending = new Map()
    this.persona = defaultPersona()
    this.foundation = emptyFoundation()
    this.selfView = emptySelfView()
    this.understanding = defaultUnderstanding()
    this.runtime = emptyRuntime()
    this.cfg = { ...DEFAULT_CONFIG }
    // index.js 之後會把 duty.info() / makeBili(...) 掛上來；工具層直接讀這兩個屬性
    this.duty = null
    this.bili = null

    try {
      mkdirSync(home, { recursive: true })
    } catch {
      /* 建不出來就等第一次寫入時再炸 */
    }
    this.seedConfig = seedConfig && typeof seedConfig === 'object' ? seedConfig : {}
  }

  /* ───────────────────────── 讀寫小工具 ───────────────────────── */

  readJson(path, fallback) {
    try {
      if (!existsSync(path)) return fallback
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return fallback
    }
  }

  writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  ledgerBytes() {
    try {
      return statSync(this.ledgerPath).size
    } catch {
      return 0
    }
  }

  /* ───────────────────────── 載入與重放 ───────────────────────── */

  load() {
    const cfgFile = this.readJson(this.configPath, null)
    const seed = { ...DEFAULT_CONFIG, ...(cfgFile && typeof cfgFile === 'object' ? cfgFile : {}), ...this.seedConfig }
    this.cfg = seed
    this.runtime = { ...emptyRuntime(), ...this.readJson(this.runtimePath, {}) }
    if (!this.runtime.recalls || typeof this.runtime.recalls !== 'object') this.runtime.recalls = {}
    this.reload()
    return this
  }

  /** 從頭重放整本帳，重建所有投影。 */
  reload() {
    this.resetProjection()
    let raw = ''
    try {
      if (!existsSync(this.ledgerPath)) {
        this.chain = blankChain()
        this.stamp()
        return this
      }
      raw = readFileSync(this.ledgerPath, 'utf8')
    } catch (err) {
      this.chain = { ...blankChain(), ok: false, reason: 'read', note: String(err?.message || err) }
      return this
    }

    const lines = raw.split('\n')
    const parsed = []
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        parsed.push(JSON.parse(t))
      } catch {
        parsed.push({ __broken: true })
      }
    }

    this.replay(parsed)
    this.stamp()
    return this
  }

  resetProjection() {
    this.records = []
    this.memories = new Map()
    this.snapshots = new Map()
    this.pending = new Map()
    this.persona = defaultPersona()
    this.foundation = emptyFoundation()
    this.selfView = emptySelfView()
    this.understanding = defaultUnderstanding()
  }

  /** 逐筆驗 hash 與 prev，一邊驗一邊套用。斷了就停在那一點。 */
  replay(parsed) {
    let head = ZERO
    let seq = 0
    const contentBreaks = []
    this.schemaVersion = SCHEMA_VERSION

    for (let i = 0; i < parsed.length; i += 1) {
      const rec = parsed[i]
      if (!rec || rec.__broken) {
        this.chain = {
          ...blankChain(),
          ok: false,
          reason: 'json',
          count: this.records.length,
          head,
          brokenAt: i,
          note: `第 ${i + 1} 行不是合法 JSON`,
        }
        return this
      }
      if (rec?.prev !== head) {
        this.chain = {
          ...blankChain(),
          ok: false,
          reason: 'link',
          count: this.records.length,
          head,
          brokenAt: i,
          note: `第 ${i + 1} 筆的 prev 接不上上一筆`,
        }
        return this
      }
      if (rec.seq !== seq + 1) {
        this.chain = {
          ...blankChain(),
          ok: false,
          reason: 'seq',
          count: this.records.length,
          head,
          brokenAt: i,
          note: `第 ${i + 1} 筆的 seq 應為 ${seq + 1}，實際是 ${rec.seq}`,
        }
        return this
      }
      const expect = hashOf(rec)
      if (expect !== rec.hash) contentBreaks.push(i)
      head = rec.hash
      seq = rec.seq
      this.records.push(rec)
      this.apply(rec)
    }

    // 內容被改過（hash 對不上）但鏈還連著：不中斷，只標出來
    let sealed = false
    let repairSeq = null
    for (const rec of this.records) {
      if (rec.kind !== 'chain.repair') continue
      const p = rec.payload || {}
      if (typeof p.upToSeq === 'number') repairSeq = Math.max(repairSeq ?? 0, p.upToSeq)
      else repairSeq = Math.max(repairSeq ?? 0, rec.seq)
      sealed = true
    }
    const stillBroken = contentBreaks.filter((i) => this.records[i]?.seq > (repairSeq ?? 0))
    this.chain = {
      ...blankChain(),
      ok: stillBroken.length === 0,
      reason: stillBroken.length ? 'content' : null,
      count: this.records.length,
      head,
      brokenAt: stillBroken.length ? stillBroken[0] : null,
      note: stillBroken.length ? `第 ${stillBroken[0] + 1} 筆的內容被改過（hash 對不上）` : '',
      contentBreaks,
      sealed,
    }
    return this
  }

  /** 檔案指紋：大小 + mtime，沒變就不必重放。 */
  fingerprint() {
    try {
      const st = statSync(this.ledgerPath)
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }

  stamp() {
    this.chainFingerprint = this.fingerprint()
  }

  /** 驗鏈。檔案沒變就回上次結果，force 才真的重放。 */
  verify({ force = false } = {}) {
    if (force || this.fingerprint() !== this.chainFingerprint) {
      const before = this.records.length
      this.reload()
      void before
    }
    return this.chain
  }

  /* ───────────────────────── 落帳 ───────────────────────── */

  append(kind, actor, payload) {
    if (this.chain.reason === 'link' || this.chain.reason === 'seq' || this.chain.reason === 'json') {
      throw new Error(`帳本在第 ${(this.chain.brokenAt ?? 0) + 1} 筆斷了（${this.chain.reason}），先封存再寫`)
    }
    const seq = this.records.length + 1
    const body = {
      v: 1,
      seq,
      ts: nowIso(),
      kind,
      actor: actor || 'plugin',
      payload: payload || {},
      prev: seq === 1 ? ZERO : this.records[this.records.length - 1].hash,
    }
    const rec = { ...body, hash: hashOf(body) }
    appendFileSync(this.ledgerPath, `${JSON.stringify(rec)}\n`, 'utf8')
    this.records.push(rec)
    this.chain = { ...this.chain, count: this.records.length, head: rec.hash }
    this.apply(rec)
    this.stamp()
    return rec
  }

  /* ── 投影 ── */
  apply(rec) {
    const p = rec.payload || {}
    switch (rec.kind) {
      case 'memory.write':
        if (p.memory?.id) this.memories.set(p.memory.id, withFirstSeen(p.memory))
        break
      case 'memory.revise':
        // 改寫能力已移除；舊帳裡若有這種記錄，重放時照樣套用（那是歷史事實）
        if (p.id && p.after) this.memories.set(p.id, withFirstSeen(p.after))
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'memory.condense': {
        // 壓縮：舊的那條收起來，新的一條進來
        const next = p.after
        if (next?.id) this.memories.set(next.id, withFirstSeen(next))
        const prev = p.id ? this.memories.get(p.id) : null
        if (prev) this.memories.set(p.id, { ...prev, archived: true, supersededBy: next?.id || '', archivedAt: rec.ts })
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.upgrade': {
        // 暫存條被提起夠多次 ⇒ 升成 T3：舊的收起來，新的一條進倉庫
        const next = p.after
        if (next?.id) this.memories.set(next.id, withFirstSeen(next))
        const prev = p.id ? this.memories.get(p.id) : null
        if (prev) this.memories.set(p.id, { ...prev, archived: true, supersededBy: next?.id || '', archivedAt: rec.ts })
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.compress': {
        const gist = p.gist
        if (gist?.id) this.memories.set(gist.id, withFirstSeen(gist))
        for (const id of p.absorbed || []) {
          const prev = this.memories.get(id)
          if (prev) this.memories.set(id, { ...prev, archived: true, supersededBy: gist?.id || '', archivedAt: rec.ts })
        }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.void': {
        // 作廢：內容不動，只標記。原條留在倉庫與帳本裡。
        const prev = p.id ? this.memories.get(p.id) : null
        if (prev) {
          this.memories.set(p.id, {
            ...prev,
            voided: true,
            voidedAt: rec.ts,
            voidedBy: rec.actor || '',
            voidedReason: p.reason || '',
            ...(p.replacedBy ? { replacedBy: p.replacedBy } : {}),
          })
        }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'memory.forget':
        // 抹除記憶的能力已移除；舊帳裡若有這種記錄，重放時直接跳過（不套用、不報錯）
        break
      case 'persona.revise':
        if (p.after) this.persona = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'persona.foundation':
        if (p.after) this.foundation = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'origin.set':
        // 起點已取消；舊帳裡的這種記錄留著不壞事，只是不再套用到任何地方
        break
      case 'understanding.revise':
        if (p.after) this.understanding = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'self.revise':
        if (p.after) this.selfView = p.after
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'bili.profile':
        // 它自己調過哪幾項：值以刷B站那份為準，這本帳只記「這是我調的、為什麼」
        if (p.after && Object.keys(p.diff || {}).length) {
          this.runtime.biliTuned = { ...(this.runtime.biliTuned || {}), ...(p.diff || {}) }
          this.runtime.biliTunedAt = rec.ts
        }
        break
      case 'schema.change':
        if (p.after?.version) this.schemaVersion = p.after.version
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'inject.profile':
      case 'rhythm.profile':
        if (p.after) this.cfg = { ...this.cfg, ...p.after }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      case 'confirm.request':
        if (p.id) this.pending.set(p.id, { ...p, status: 'open', at: rec.ts })
        break
      case 'confirm.resolve': {
        const cur = this.pending.get(p.id)
        if (cur) this.pending.set(p.id, { ...cur, status: p.status || (p.approved ? 'approved' : 'refused'), resolvedAt: rec.ts })
        break
      }
      case 'rollback': {
        const r = p.restore || {}
        for (const id of r.removeMemories || []) this.memories.delete(id)
        // 一律過 withFirstSeen：舊帳、導入檔、回滾都可能帶回沒有 firstSeen 的條目，
        // 其他所有寫入路徑都補了這一手，這裡不補就會出現「同一條記憶，走不同路徑得到不同欄位」。
        for (const m of r.memories || []) if (m?.id) this.memories.set(m.id, withFirstSeen(m))
        if (r.persona) this.persona = r.persona
        if (r.foundation) this.foundation = r.foundation
        if (r.selfView) this.selfView = r.selfView
        if (r.understanding) this.understanding = r.understanding
        if (r.replaceAll) {
          this.memories.clear()
          for (const m of r.replaceAll.memories || []) if (m?.id) this.memories.set(m.id, withFirstSeen(m))
          if (r.replaceAll.persona) this.persona = r.replaceAll.persona
          if (r.replaceAll.foundation) this.foundation = r.replaceAll.foundation
          if (r.replaceAll.selfView) this.selfView = r.replaceAll.selfView
          if (r.replaceAll.understanding) this.understanding = r.replaceAll.understanding
        }
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'import.bundle': {
        const after = p.after || {}
        this.memories.clear()
        for (const m of after.memories || []) if (m?.id) this.memories.set(m.id, withFirstSeen(m))
        if (after.persona) this.persona = after.persona
        if (after.foundation) this.foundation = after.foundation
        if (after.selfView) this.selfView = after.selfView
        if (after.understanding) this.understanding = after.understanding
        if (p.snapshot) this.snapshots.set(p.snapshot.id, p.snapshot)
        break
      }
      case 'duty.arm':
        if (p.sessionId) this.runtime.selfMemoryId = this.runtime.selfMemoryId || ''
        break
      case 'genesis':
        if (p.schemaVersion) this.schemaVersion = p.schemaVersion
        break
      default:
        break
    }
  }

  /* ───────────────────────── 設定 / 運行時 ───────────────────────── */

  saveConfig(patch) {
    const next = { ...this.cfg }
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (!(key in (patch || {}))) continue
      const raw = patch[key]
      if (typeof DEFAULT_CONFIG[key] === 'boolean') next[key] = Boolean(raw)
      else if (typeof DEFAULT_CONFIG[key] === 'number') {
        const n = Number(raw)
        if (!Number.isFinite(n)) continue
        // 數值一律照各組白名單的硬範圍夾 —— 這裡是設定的最後一道關，
        // 不能出現「頁面寫 240 小時，但白名單說上限 72」這種帳本比規則還寬的情況。
        const spec = INJECT_TUNABLES[key] || RHYTHM_TUNABLES[key]
        if (spec) {
          next[key] = clamp(Math.round(n), spec.min, spec.max)
          continue
        }
        next[key] = clamp(Math.round(n), 0, key === 'tier4TtlDays' ? 90 : 240)
      }
    }
    this.cfg = next
    this.writeJson(this.configPath, next)
    return next
  }

  persistRuntime() {
    try {
      this.writeJson(this.runtimePath, this.runtime)
    } catch {
      /* 運行時計數掉了不影響依據鏈 */
    }
  }

  bumpRecall(ids) {
    const at = nowIso()
    for (const id of ids || []) {
      const rec = this.runtime.recalls[id] || { n: 0, last: null }
      rec.n = (rec.n || 0) + 1
      rec.last = at
      this.runtime.recalls[id] = rec
    }
    this.persistRuntime()
  }

  /**
   * 暫存條（T4）被提起夠多次 ⇒ 升成 T3，正式進倉庫。
   *
   * 「提起」算的是召回次數（recalls.n），一輪裡同一條只算一次 —— 同一句話在眼前重複掃過不算一次新的想起。
   * 提一次是偶然，提三次就是真的在了：那它就不再是「先放著」，而是值得留住的經歷。
   *
   * 升級＝舊的暫存條收起來（supersededBy）+ 新的一條 T3 進來。
   * 跟壓縮同樣的規矩：不改同一條，而是把這一條重新寫成經歷 —— 帳本上看得到前後兩條。
   * @returns {Map<string, object>} 這一輪真的升上去的那些（**原 T4 的 id** → 新記憶）
   *          ⚠️ 鍵是舊 id：呼叫方（recall）手裡拿的是召回時那一行的 id，
   *             拿新 id 去查會查不到 —— 上一版就是這麼漏的。
   */
  promoteScratch(ids = []) {
    const out = new Map()
    if (!this.cfg.enabled) return out
    for (const id of new Set(ids)) {
      if (!id) continue
      const prev = this.memories.get(id)
      if (!prev || prev.archived || prev.tombstoned) continue
      if (prev.tier !== SCRATCH.tier) continue
      const rec = this.runtime.recalls?.[id] || {}
      if (Number(rec.n || 0) < SCRATCH.upgradeAfter) continue

      const now = nowIso()
      const next = {
        ...prev,
        id: `m-${digest(`${now}:${Math.random()}`).slice(0, 10)}`,
        tier: SCRATCH.upgradeTo,
        // bornAt 是「開始按新層級衰減的時間」＝升級這一刻（T3 半衰期 26 天，從此開始算）
        bornAt: now,
        // firstSeen 是「這件事第一次出現的時間」，**沿用原條**，不是升級日 ——
        // 升級只是換了存放的層級，不代表這件事是今天才發生的。
        firstSeen: stampOf(SCRATCH.upgradeTo, prev.firstSeen || prev.bornAt || now),
        graduatedFrom: id,
        revision: 1,
      }
      const snapshot = snapshotOf('memory', `暫存條「${oneLine(prev.title, 30)}」被提起 ${rec.n} 次，升成 T${SCRATCH.upgradeTo}`, { ...prev }, { ...next })
      this.append('memory.upgrade', 'plugin', { id, upgradedTo: next.id, after: next, recalls: Number(rec.n || 0), snapshot })
      out.set(id, next)
    }
    return out
  }

  /* ───────────────────────── 對外狀態 ───────────────────────── */

  /**
   * 倉庫（complete memories）＝ T1 / T2 / T3 / T5。
   *
   * T4 不算完整記憶：它只是「先放著」的暫存條，不進倉庫、不進注入、不佔額度 ——
   * 只有 mnemos_recall 手動去找才看得到，提起到第 SCRATCH.upgradeAfter 次就會升成 T3 進倉庫。
   *
   * ⚠️ T5（預測層）**在倉庫裡**，只是到期之後不進注入。它跟 T4 不是一回事：
   *   T4 是「還沒決定值不值得記」，T5 是「決定了，但只到某天為止」。
   */
  activeMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) {
      if (m.archived || m.tombstoned) continue
      if (m.tier === SCRATCH.tier) continue
      if (isExpired(m, this.runtime, this.cfg, now)) continue
      rows.push({ ...m, salience: salienceOf(m, this.runtime, now) })
    }
    return rows
  }

  /** 已到期的預測層 —— 不進注入，但還在倉庫、還搜得到。 */
  dueForecasts(now = Date.now()) {
    return this.activeMemories(now).filter((m) => isDue(m, now))
  }

  /** 暫存區（T4）—— 還沒升上去的那些，過期就自然消失。 */
  scratchMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) {
      if (m.archived || m.tombstoned) continue
      if (m.tier !== SCRATCH.tier) continue
      if (isExpired(m, this.runtime, this.cfg, now)) continue
      rows.push({ ...m, recalls: Number(this.runtime.recalls?.[m.id]?.n || 0) })
    }
    return rows
  }

  allMemories(now = Date.now()) {
    const rows = []
    for (const m of this.memories.values()) rows.push({ ...m, salience: salienceOf(m, this.runtime, now) })
    return rows
  }

  state(now = Date.now()) {
    const chain = this.verify()
    // 給頁面用的記憶行：activeMemories 帶 salience，這裡再補一個 due（T5 是否已過期），
    // 否則前端得自己重算一遍日期判斷，兩邊容易走岔。
    const active = this.activeMemories(now).map((m) => (m.tier === FORECAST.tier ? { ...m, due: isDue(m, now) } : m))
    const scratch = this.scratchMemories(now)
    const all = this.allMemories(now)
    const dims = scoreDims(this.understanding)
    return {
      schemaVersion: this.schemaVersion,
      cfg: this.cfg,
      persona: this.persona,
      foundation: this.foundation,
      selfView: this.selfView,
      understanding: this.understanding,
      dims,
      counts: {
        active: active.length,
        // 暫存區不算倉庫：它只是先放著的，還沒升上去
        scratch: scratch.length,
        // 到期的預測層：還在倉庫，只是不再進注入
        dueForecast: active.filter((m) => isDue(m, now)).length,
        archived: all.filter((m) => m.archived).length,
        tombstoned: all.filter((m) => m.tombstoned).length,
        byTier: [1, 2, 3, 5].reduce((acc, t) => Object.assign(acc, { [t]: active.filter((m) => m.tier === t).length }), {}),
        snapshots: this.snapshots.size,
        pending: [...this.pending.values()].filter((p) => p.status === 'open').length,
        ledgerBytes: this.ledgerBytes(),
      },
      chain,
      memories: active,
      scratch,
      scratchUpgradeAfter: SCRATCH.upgradeAfter,
      all,
      snapshots: [...this.snapshots.values()].sort((a, b) => (a.at < b.at ? 1 : -1)),
      // 性格卡是它自己改的：這裡只給「最近改過哪幾次」的旁證，不需要任何人批准
      personaTrail: this.recentPersonaRevisions(8),
      pending: [...this.pending.values()].sort((a, b) => (a.at < b.at ? 1 : -1)),
      runtime: {
        lastReflectionAt: this.runtime.lastReflectionAt,
        lastBiliAt: this.runtime.lastBiliAt,
        armed: this.runtime.armed,
        lastTickAt: this.runtime.lastTickAt || null,
        dutyLog: (this.runtime.dutyLog || []).slice(-12),
        lastError: this.runtime.lastError,
        selfMemoryId: this.runtime.selfMemoryId || '',
        biliTuned: this.runtime.biliTuned || {},
        biliTunedAt: this.runtime.biliTunedAt || null,
      },
      tiers: TIERS,
      dimCatalog: DIMS,
      dimKeys: DIM_KEYS,
    }
  }

  /**
   * 性格卡的「旁證」：它最近自己改過哪幾次 —— 只讀，不批准、不擋。
   * 給的是事實：誰改的、怎麼改的、動沒動身份句、有沒有刪掉原有的性格/喜好。
   */
  recentPersonaRevisions(limit = 8) {
    const rows = []
    for (const rec of this.records) {
      if (rec.kind !== 'persona.revise') continue
      const p = rec.payload || {}
      const before = p.before || {}
      const after = p.after || {}
      const lostTraits = Math.max(0, (before.traits || []).length - (after.traits || []).length)
      const lostTaste = Math.max(0, (before.taste || []).length - (after.taste || []).length)
      const bId = String(before.identity || '').trim()
      const aId = String(after.identity || '').trim()
      rows.push({
        seq: rec.seq,
        at: rec.ts,
        by: rec.actor || '',
        mode: p.destructive || p.mode === 'replace' ? 'replace' : 'adjust',
        version: after.version ?? null,
        destructive: typeof p.destructive === 'boolean' ? p.destructive : p.mode === 'replace',
        identityChanged: Boolean(bId) && Boolean(aId) && bId !== aId,
        identityCleared: Boolean(bId) && !aId,
        lostTraits,
        lostTaste,
        snapshotId: p.snapshot?.id || '',
      })
    }
    rows.sort((a, b) => b.seq - a.seq)
    return rows.slice(0, limit)
  }

  /* ───────────────────────── 寫入（工具與頁面共用） ───────────────────────── */

  writeMemory(raw, { sessionId, callId, actor = 'model', origin } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'mnemos is switched off; the owner has to enable it before memory can grow' }
    const res = normalizeMemory(raw, { sessionId, callId, origin })
    if (!res.ok) return res
    const memory = { ...res.memory, id: `m-${digest(`${nowIso()}:${Math.random()}`).slice(0, 10)}` }
    this.append('memory.write', actor, { memory })
    return { ok: true, memory: this.memories.get(memory.id) || memory }
  }

  /**
   * 改寫記憶：**模型沒有這個能力了**。
   *
   * 理由跟「不能刪記憶」是同一條：改一條記憶的字，等於改變它記下的事。
   * 它能加（mnemos_remember），但不能回頭動已經寫下的東西。
   */
  reviseMemory() {
    return { ok: false, error: '記憶不能改寫；寫錯了就再寫一條對的' }
  }

  /**
   * 作廢一條記憶：**內容一個字都不改**，只標「這條不成立了、為甚麼」。
   *
   * 跟其他三種「不再用」的差別：
   *   archived（歸檔）＝ 被壓縮／合併掉了 —— 時間的必然結果
   *   expired （過期）＝ 到時間了（T4 淡出、T5 到期）—— 也是時間的必然結果
   *   voided  （作廢）＝ **事後發現當初就不對** —— 需要新信息，而且要有出處
   *
   * 所以它只該由對話驅動（本人說「我之前說錯了」），不該在反思時憑感覺用。
   * 原條仍在倉庫、仍在帳本；只是不再進注入，recall 還找得到並標出 voided。
   */
  voidMemory(id, { reason = '', replacedBy = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'mnemos is switched off' }
    const m = this.memories.get(id)
    if (!m) return { ok: false, error: `no memory ${id}` }
    if (m.archived) return { ok: false, error: `記憶 ${id} 已經被壓縮／合併掉了，不是可以作廢的東西` }
    // 暫存條本來就不進注入、幾天後自己消失 —— 作廢它沒有意義，只會多一筆雜訊
    if (m.tier === SCRATCH.tier) {
      return { ok: false, error: '暫存區的碎屑不用作廢 —— 它本來就不進提示詞，不碰它過幾天就散了' }
    }
    if (m.voided) return { ok: false, error: `記憶 ${id} 已經是作廢狀態了` }

    const why = String(reason ?? '').trim()
    if (why.length < 2) return { ok: false, error: '要說一句為甚麼作廢 —— 是誰、哪句話讓它不成立的' }

    let replaced = ''
    if (replacedBy) {
      const target = this.memories.get(replacedBy)
      if (!target) return { ok: false, error: `replacedBy 指的 ${replacedBy} 不存在` }
      if (target.id === id) return { ok: false, error: '不能拿它自己取代自己' }
      replaced = replacedBy
    }

    const before = { ...m }
    const after = {
      ...m,
      voided: true,
      voidedAt: nowIso(),
      voidedBy: actor,
      voidedReason: why,
      ...(replaced ? { replacedBy: replaced } : {}),
    }
    const snapshot = snapshotOf('memory', `作廢「${oneLine(m.title, 30)}」`, before, after)
    this.append('memory.void', actor, { id, reason: why, replacedBy: replaced || null, snapshot })
    return { ok: true, id, tier: m.tier, title: m.title, replacedBy: replaced || null }
  }

  /**
   * 壓縮一條經歷：把一條 T3 換成更短的版本（原條歸檔，新版是新的記憶）。
   *
   * 跟 reviseMemory 的差別：**不是改同一條的內容**，而是「把這一條重新講一遍，舊的那個收起來」。
   * 所以它走的是跟 compress 一樣的路：原條 archived、新版是獨立的一條。
   *
   * - 目標是一條對一條（不是合併）
   * - 新版夠短（≤ T2 上限）就直接是 T2；否則還是 T3，等下一輪再壓
   * - 原條不能是 T1、T2、T4
   */
  condense({ id, title, body, targetLen = null }, { sessionId = '', callId = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'mnemos is switched off' }
    const prev = this.memories.get(id)
    if (!prev) return { ok: false, error: `no memory ${id}` }
    if (prev.tombstoned || prev.archived) return { ok: false, error: `memory ${id} 已經收起來了，不能再壓` }
    if (prev.voided) return { ok: false, error: `memory ${id} 已經被作廢了 —— 壓一條錯的記憶沒有意義` }
    if (prev.tier === 1) return { ok: false, error: 'T1 事實不壓縮' }
    if (prev.tier === SCRATCH.tier) return { ok: false, error: '暫存區的條目不壓縮 —— 它要麼被提起升成 T3，要麼自己過期消失' }
    if (prev.tier === FORECAST.tier) return { ok: false, error: '預測層不壓縮 —— 它本來就短，到期就不進注入了，沒有再收的必要' }
    if (prev.tier === 2) return { ok: false, error: '這已經是沉澱下來的概了，不再壓' }

    const text = String(body ?? '').trim()
    if (text.length < 2) return { ok: false, error: 'body 不能是空的' }
    const newLen = String(title ?? '').length + text.length
    if (targetLen && newLen > Number(targetLen)) {
      return { ok: false, error: `這次 ${newLen} 字，超過要求的 ${targetLen} 字 —— 再收一點` }
    }

    // 夠短就沉成 T2，否則留在 T3 等下一輪
    const tierAfter = newLen <= TIERS[2].maxChars ? 2 : 3
    const gist = {
      title,
      body: text,
      domain: prev.domain || 'other',
      // dims 要留真的：normalizeMemory 會驗證它是不是合法維度，'other' 是 domain 不是 dim
      dims: prev.dims?.length ? prev.dims : ['personality'],
      facets: prev.facets || [],
      importance: prev.importance,
    }

    const snapshot = snapshotOf('condense', `壓縮 ${oneLine(prev.title, 30)}`, { memory: prev }, { gist })
    if (tierAfter === 2) {
      // 走 compress 的通道，讓 T2 的規則（只有壓縮能產生）保持一致
      const res = this.compress({ gist, ids: [id] }, { sessionId, callId, actor, origin: 'plugin' })
      if (!res.ok) return res
      return { ok: true, memory: res.memory, tier: 2, from: id, snapshotId: res.snapshotId }
    }

    // 還是 T3：新寫一條，舊的歸檔
    // ⚠️ 壓縮原本就是「同一件事換個說法」，它的出處是原條，不是壓縮時所在的那個會話。
    // 值守會話的 sessionId 可能拿不到（''），不能因此把冷卻了七天的活兒白白丟掉 ——
    // 有來源就沿用原條的，一律沒有才當成插件自己產生的。
    const fromSession = sessionId || prev.bornOfSession || ''
    const res = normalizeMemory(gist, { sessionId: fromSession, callId, origin: fromSession ? undefined : 'plugin' })
    if (!res.ok) return res
    const next = {
      ...res.memory,
      id: `m-${digest(`${nowIso()}:${Math.random()}`).slice(0, 10)}`,
      condensedFrom: id,
      lastCondensedAt: nowIso(),
      // 這是第幾次壓 —— 「每次抹掉多少」要靠它算：越壓越輕（見 duty.condensePlan）
      condenseCount: Number(prev.condenseCount || 0) + 1,
      // 這條經歷最初有多長：目標一律從它連乘算起，避免每輪的餘裕複利（見 duty.condensePlan）
      originalLen: Number(prev.originalLen || String(prev.title || '').length + String(prev.body || '').length),
      revision: (prev.revision || 1) + 1,
    }
    this.append('memory.condense', actor, { id, after: next, snapshot })
    return { ok: true, memory: next, tier: 3, from: id, snapshotId: snapshot.id }
  }

  /**
   * 產生 T2。**這是 T2 唯一的來源** —— 工具層沒有任何路徑能直接寫 T2。
   */
  compress({ gist, ids }, { sessionId, callId, actor = 'plugin', origin = 'plugin', fromCompression = false } = {}) {
    if (!this.cfg.enabled) return { ok: false, error: 'mnemos is switched off; nothing new is written' }
    const absorbed = (ids || []).map((id) => this.memories.get(id)).filter((m) => m && !m.tombstoned && !m.archived)
    if (absorbed.length === 0) return { ok: false, error: 'none of those memories exist, or they are already absorbed' }
    // 暫存條不是完整記憶：它要麼被提起升成 T3，要麼自己過期。不參與壓縮、不能被折走。
    if (absorbed.some((m) => m.tier === SCRATCH.tier)) {
      return { ok: false, error: '暫存區的條目不參與壓縮 —— 它要麼被提起升成 T3，要麼自己過期消失' }
    }
    // 預測層也不能被折進概括：它不是經歷，是一句有期限的話。
    if (absorbed.some((m) => m.tier === FORECAST.tier)) {
      return { ok: false, error: '預測層不參與壓縮 —— 它是「到某天為止」的話，不該被折成經歷的概' }
    }
    // 作廢的不能被折進概括：那等於把一句錯的話混進對的裡面去
    if (absorbed.some((m) => m.voided)) {
      return { ok: false, error: '已作廢的記憶不參與壓縮 —— 把一句錯的話折進概裡，錯的會留下來' }
    }
    // T2 已經是最低的一層：沉澱過的東西不再折第二次
    const gists = absorbed.filter((m) => m.tier === 2)
    if (gists.length) {
      return { ok: false, error: `memory ${gists[0].id} is already a tier 2 gist; a gist is the floor and is never compressed again` }
    }
    if (absorbed.some((m) => m.tier === 1)) return { ok: false, error: 'tier 1 facts are never compressed away' }
    // T2 只能由這裡產生 —— normalizeMemory 預設拒絕直接寫 T2，壓縮是唯一的例外通道
    const res = normalizeMemory(
      { ...gist, tier: 2, domain: gist?.domain || absorbed[0].domain },
      { sessionId, callId, origin, fromCompression: Boolean(fromCompression) || origin === 'plugin' },
    )
    if (!res.ok) return res
    const at = nowIso()
    const g = {
      ...res.memory,
      id: `m-${digest(`${at}:${Math.random()}`).slice(0, 10)}`,
      compressedFrom: absorbed.map((m) => m.id),
      bornAt: at,
      firstSeen: stampOf(2, at),
      // 沉成 T2 是這條經歷的終點，次數與原始長度要留下來（帳本上看得出它被壓過幾次）
      condenseCount: Number(absorbed[0].condenseCount || 0) + 1,
      originalLen: Number(
        absorbed[0].originalLen || String(absorbed[0].title || '').length + String(absorbed[0].body || '').length,
      ),
    }
    const snapshot = snapshotOf('compress', `壓縮 ${absorbed.length} 條為一條大概`, { absorbed: absorbed.map((m) => m.id) }, { gist: g.id })
    this.append('memory.compress', actor, { gist: g, absorbed: absorbed.map((m) => m.id), snapshot })
    return { ok: true, memory: g, absorbed: absorbed.map((m) => m.id), snapshotId: snapshot.id }
  }

  /**
   * 抹除記憶：**已經沒有這個能力了**。
   * 這裡保留一個明確拒絕的入口，是為了不讓任何殘留呼叫靜默失敗。
   */
  forget() {
    return { ok: false, error: '抹除記憶的能力已移除' }
  }

  /* ───────────────────────── 人格 / 底座 / 自我 / 六維 ───────────────────────── */

  /**
   * 性格卡歸它自己：**修不修訂、怎麼修訂，都由它自己決定，不經本人批准。**
   * 風險照樣留痕 —— before/after 快照、可回滾，本人只在旁邊看，不參與。
   */
  savePersona(patch, { mode = 'adjust', actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'mnemos is switched off' }
    const res = normalizePersona(this.persona, patch || {}, { mode })
    if (!res.ok) return res
    const before = this.persona
    const snapshot = snapshotOf('persona', `修訂人格 v${res.persona.version}`, before, res.persona)
    this.append('persona.revise', actor, { before, after: res.persona, mode, destructive: Boolean(res.destructive), snapshot })
    return { ok: true, persona: res.persona, snapshotId: snapshot.id, destructive: Boolean(res.destructive) }
  }

  setFoundation(text, { actor = 'user' } = {}) {
    const before = this.foundation
    const after = { text: String(text ?? ''), setAt: nowIso(), by: actor }
    const snapshot = snapshotOf('foundation', '改性格底座', before, after)
    this.append('persona.foundation', actor, { before, after, snapshot })
    return { ok: true, foundation: after, snapshotId: snapshot.id }
  }

  /** 起點已取消：它本來就是初始的底座詞，現在就是底座本身。留一個明確拒絕的入口。 */
  setOrigin() {
    return { ok: false, error: '「起點」已經沒有這個東西了 —— 它現在就是性格底座本身' }
  }

  saveSelfView(text, { actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'mnemos is switched off' }
    const res = normalizeSelfView(this.selfView, text)
    if (!res.ok) return res
    const before = this.selfView
    const snapshot = snapshotOf('self', `自我認知 v${res.view.revision}`, before, res.view)
    this.append('self.revise', actor, { before, after: res.view, snapshot })
    return { ok: true, selfView: res.view, snapshotId: snapshot.id }
  }

  setUnderstanding(patch, { actor = 'model', note = '' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'mnemos is switched off' }
    const res = normalizeUnderstanding(this.understanding, patch)
    if (!res.ok) return res
    const before = this.understanding
    const snapshot = snapshotOf('understanding', note || '修訂「它對你的了解」', before, res.understanding)
    this.append('understanding.revise', actor, { before, after: res.understanding, note: oneLine(note, 200), snapshot })
    return { ok: true, understanding: res.understanding, snapshotId: snapshot.id }
  }

  /* ───────────────────────── 它自己調的旋鈕 ───────────────────────── */

  /** 它自己調過哪些注入量（給工具與頁面看「這是我調的」）。 */
  injectTuning() {
    return this.runtime.injectTuned || {}
  }

  /** 它自己調過哪些節律。 */
  rhythmTuning() {
    return this.runtime.rhythmTuned || {}
  }

  /** 它自己調過哪些刷B站設定。 */
  biliTuning() {
    return this.runtime.biliTuned || {}
  }

  tuneInjection(patch, { reason = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'mnemos is switched off' }
    const before = { injectCount: Number(this.cfg.injectCount), injectBudget: Number(this.cfg.injectBudget) }
    const next = { ...before }
    const diff = {}
    const ignored = []
    for (const key of Object.keys(patch || {})) {
      if (!(key in INJECT_TUNABLES)) {
        ignored.push(key)
        continue
      }
      const spec = INJECT_TUNABLES[key]
      const n = Number(patch[key])
      if (!Number.isFinite(n)) continue
      next[key] = clamp(Math.round(n), spec.min, spec.max)
      if (next[key] !== before[key]) diff[key] = next[key]
    }
    if (Object.keys(diff).length === 0) {
      return { ok: true, changed: false, note: '這些已經就是現在的值', ignored, now: before }
    }
    const snapshot = snapshotOf('inject', '調注入量', before, next)
    this.append('inject.profile', actor, { before, after: next, diff, reason: String(reason || ''), snapshot })
    this.cfg = { ...this.cfg, ...diff }
    this.runtime.injectTuned = { ...(this.runtime.injectTuned || {}), ...diff }
    this.writeJson(this.configPath, this.cfg)
    this.persistRuntime()
    return { ok: true, changed: true, before, after: next, diff, snapshotId: snapshot.id }
  }

  tuneRhythm(patch, { reason = '', actor = 'model' } = {}) {
    if (!this.cfg.enabled && actor === 'model') return { ok: false, error: 'mnemos is switched off' }
    const before = {
      reflectionEveryHours: Number(this.cfg.reflectionEveryHours),
      biliEveryHours: Number(this.cfg.biliEveryHours),
      dutyMaxPerDay: Number(this.cfg.dutyMaxPerDay),
    }
    const next = { ...before }
    const diff = {}
    const ignored = []
    for (const key of Object.keys(patch || {})) {
      if (!(key in RHYTHM_TUNABLES)) {
        ignored.push(key)
        continue
      }
      const spec = RHYTHM_TUNABLES[key]
      const n = Number(patch[key])
      if (!Number.isFinite(n)) continue
      next[key] = clamp(Math.round(n), spec.min, spec.max)
      if (next[key] !== before[key]) diff[key] = next[key]
    }
    if (Object.keys(diff).length === 0) {
      return { ok: true, changed: false, note: '這些已經就是現在的值', ignored, now: before }
    }
    const snapshot = snapshotOf('rhythm', '調值守節律', before, next)
    this.append('rhythm.profile', actor, { before, after: next, diff, reason: String(reason || ''), snapshot })
    this.cfg = { ...this.cfg, ...diff }
    this.runtime.rhythmTuned = { ...(this.runtime.rhythmTuned || {}), ...diff }
    this.writeJson(this.configPath, this.cfg)
    this.persistRuntime()
    return { ok: true, changed: true, before, after: next, diff, snapshotId: snapshot.id }
  }

  /* ───────────────────────── 待確認（舊帳清道夫） ───────────────────────── */

  /**
   * 排一筆「要本人點頭才做」的操作。
   * ⚠️ 現在模型沒有任何路徑能叫到這裡 —— 刪除、回滾、導入都收回本人手上了。
   * 留著只是為了讓舊帳裡殘留的待確認項目還能被讀出來、被消化掉。
   */
  queue(op, payload, { sessionId, summary, actor = 'model' } = {}) {
    const id = `c-${digest(`${nowIso()}:${Math.random()}`).slice(0, 8)}`
    this.append('confirm.request', actor, { id, op, payload: payload || {}, summary: oneLine(summary || op, 200), sessionId: sessionId || '' })
    return { ok: true, needsConfirmation: true, pendingId: id, status: 'pending-confirmation', summary }
  }

  resolvePending(id, approve, { actor = 'user' } = {}) {
    const item = this.pending.get(id)
    if (!item) return { ok: false, error: `no pending operation ${id}` }
    if (item.status !== 'open') return { ok: false, error: `pending operation ${id} is already ${item.status}` }
    if (!approve) {
      this.append('confirm.resolve', actor, { id, approved: false, status: 'refused' })
      return { ok: true, id, status: 'refused' }
    }
    let applied
    try {
      applied = this.applyOp(item.op, item.payload, { actor: 'user', confirmed: true, sessionId: item.sessionId })
    } catch (err) {
      this.append('confirm.resolve', actor, { id, approved: false, status: 'failed', error: String(err?.message || err) })
      return { ok: false, error: String(err?.message || err) }
    }
    this.append('confirm.resolve', actor, { id, approved: true, status: 'approved' })
    return { ok: true, id, status: 'approved', result: applied }
  }

  applyOp(op, payload, opts = {}) {
    switch (op) {
      case 'memory.forget':
        // 抹除記憶已移除；舊帳裡殘留的這種待確認，同意也只會被明確拒絕
        return this.forget()
      case 'rollback':
        // 回滾只由本人在頁面上按；模型那邊沒有入口
        return this.rollback(payload.snapshotId, { actor: 'user' })
      case 'import.bundle':
        return this.importBundle(payload.bundle, { actor: 'user' })
      default:
        return { ok: false, error: `unknown operation ${op}` }
    }
  }

  /* ───────────────────────── 回滾 / 導入 / 導出 ───────────────────────── */

  rollback(snapshotId, { actor = 'model' } = {}) {
    const snap = this.snapshots.get(snapshotId)
    if (!snap) return { ok: false, error: `no snapshot ${snapshotId}` }
    const chain = this.verify()
    if (!chain.ok && !chain.sealed) {
      return { ok: false, error: `hash chain is broken at #${(chain.brokenAt ?? 0) + 1}; rollback stays disabled until it is sealed` }
    }

    let restore
    let scopeLabel
    if (snap.scope === 'memory' || snap.scope === 'foundation' || snap.scope === 'self') {
      restore =
        snap.scope === 'memory'
          ? { memories: [snap.before] }
          : snap.scope === 'foundation'
            ? { foundation: snap.before }
            : { selfView: snap.before }
      scopeLabel = snap.scope
    } else if (snap.scope === 'persona') {
      restore = { persona: snap.before }
      scopeLabel = 'persona'
    } else if (snap.scope === 'understanding') {
      restore = { understanding: snap.before }
      scopeLabel = 'understanding'
    } else if (snap.scope === 'compress') {
      // 壓縮的回滾 = 把被吸走的那幾條放回來，再把生出來的概拿掉
      restore = {
        memories: (snap.before?.absorbed || []).map((id) => this.memories.get(id)).filter(Boolean),
        removeMemories: snap.after?.gist ? [snap.after.gist] : [],
      }
      scopeLabel = 'compress'
    } else if (snap.scope === 'condense') {
      restore = {
        memories: snap.before?.memory ? [snap.before.memory] : [],
        removeMemories: [],
      }
      scopeLabel = 'condense'
    } else {
      restore = { replaceAll: snap.before ?? {} }
      scopeLabel = 'store'
    }

    const before = { ts: nowIso() }
    const snapshot = snapshotOf(scopeLabel, `回滾 ${snap.label}`, before, before)
    this.append('rollback', actor, { rollbackOf: snapshotId, scope: scopeLabel, restore, snapshot })
    return { ok: true, rolledBack: snapshotId, scope: scopeLabel, snapshotId: snapshot.id }
  }

  exportBundle() {
    const active = this.activeMemories()
    const chain = this.verify()
    const bundle = {
      format: 'mnemos/1',
      exportedAt: nowIso(),
      schemaVersion: this.schemaVersion,
      persona: this.persona,
      foundation: this.foundation,
      selfView: this.selfView,
      understanding: this.understanding,
      memories: active,
      provenance: { ledgerRecords: this.records.length, head: chain.head, chainOk: chain.ok },
    }
    this.append('export', 'user', { memories: active.length, head: chain.head })
    return bundle
  }

  /**
   * 一鍵導出：把 **ledger.jsonl 原樣**寫成一份副本（`ledger.export.jsonl`）。
   * 不轉成 JSON bundle、不記一筆 export —— 導出的檔案要能直接當帳本帶去另一台機器。
   */
  exportLedger() {
    if (!existsSync(this.ledgerPath)) return { ok: false, error: 'ledger.jsonl does not exist yet' }
    const raw = readFileSync(this.ledgerPath, 'utf8')
    writeFileSync(this.exportPath, raw, 'utf8')
    const chain = this.verify()
    return {
      ok: true,
      file: this.exportPath,
      records: this.records.length,
      head: chain.head,
      bytes: Buffer.byteLength(raw, 'utf8'),
    }
  }

  /**
   * 導入一本帳（整本 ledger.jsonl）。
   *
   * 先驗：格式、seq 連號、每筆 hash、prev 連得上。全部過了才動手 ——
   * 舊帳改名留在同一個資料夾（`ledger.replaced-<時間>.jsonl`），不是刪掉。
   */
  importLedger(raw, { actor = 'user', source = '' } = {}) {
    const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return { ok: false, error: '那是一份空帳' }
    const incoming = []
    for (let i = 0; i < lines.length; i += 1) {
      let rec
      try {
        rec = JSON.parse(lines[i])
      } catch {
        return { ok: false, error: `第 ${i + 1} 行不是合法 JSON` }
      }
      if (!rec || typeof rec !== 'object') return { ok: false, error: `第 ${i + 1} 行不是一個記錄` }
      incoming.push(rec)
    }

    let head = ZERO
    const breaks = []
    for (let i = 0; i < incoming.length; i += 1) {
      const rec = incoming[i]
      if (rec.seq !== i + 1) return { ok: false, error: `第 ${i + 1} 筆的 seq 應為 ${i + 1}，實際是 ${rec.seq}` }
      if (i === 0 && rec.prev !== ZERO) return { ok: false, error: '第 1 筆的 prev 必須是 64 個 0' }
      if (i > 0 && rec.prev !== head) return { ok: false, error: `第 ${i + 1} 筆接不上第 ${i} 筆（prev 不符）` }
      if (hashOf(rec) !== rec.hash) breaks.push(i + 1)
      head = rec.hash
    }

    // 備份舊帳：改名，不是刪
    let quarantine = null
    const hasOld = existsSync(this.ledgerPath)
    if (hasOld) {
      const stamp = nowIso().replace(/[:.]/g, '-')
      quarantine = join(this.home, `ledger.replaced-${stamp}.jsonl`)
      try {
        renameSync(this.ledgerPath, quarantine)
      } catch (err) {
        return { ok: false, error: `舊帳改名失敗：${err?.message || err}` }
      }
    }
    const rollbackRename = () => {
      try {
        if (existsSync(this.ledgerPath)) renameSync(this.ledgerPath, `${this.ledgerPath}.failed`)
        if (quarantine && existsSync(quarantine)) renameSync(quarantine, this.ledgerPath)
      } catch {
        /* 盡力而為 */
      }
    }

    try {
      let prev = ZERO
      for (let i = 0; i < incoming.length; i += 1) {
        const rec = incoming[i]
        const body = { v: rec.v ?? 1, seq: rec.seq, ts: rec.ts, kind: rec.kind, actor: rec.actor, payload: rec.payload, prev }
        const next = { ...body, hash: hashOf(body) }
        appendFileSync(this.ledgerPath, `${JSON.stringify(next)}\n`, 'utf8')
        prev = next.hash
      }
      this.reload()
      this.append('import.ledger', actor, { from: oneLine(source || 'ledger file', 200), records: incoming.length, head, replaced: quarantine ? quarantine.split(/[\\/]/).pop() : null })
    } catch (err) {
      rollbackRename()
      this.reload()
      return { ok: false, error: `寫入新帳失敗，舊帳已放回：${err?.message || err}` }
    }
    this.reload()
    if (!this.chain.ok) {
      rollbackRename()
      this.reload()
      return { ok: false, error: `接完之後鏈校驗不過（${this.chain.note || this.chain.reason}），舊帳已放回` }
    }
    return {
      ok: true,
      imported: incoming.length,
      head,
      chain: this.chain,
      persona: Boolean(this.persona?.identity || this.persona?.traits?.length),
      memories: this.memories.size,
      replaced: quarantine ? quarantine.split(/[\\/]/).pop() : null,
      contentBreaks: breaks,
    }
  }

  /**
   * 導入一份 bundle（JSON，不是帳本）。走待確認，由本人按了才真的套用。
   *
   * ⚠️ 導入的內容也要過同一道掃描 —— 否則可以繞過「絕不記憑據 / 技術內容」直接把東西塞進來。
   */
  importBundle(bundle, { actor = 'user' } = {}) {
    if (!bundle || bundle.format !== 'mnemos/1') return { ok: false, error: 'not a mnemos/1 export' }
    const raw = (Array.isArray(bundle.memories) ? bundle.memories : []).filter((m) => m && typeof m.id === 'string')
    const memories = []
    const rejected = []
    for (const m of raw) {
      const scan = scanText(`${m.title || ''}\n${m.body || ''}`)
      if (scan) rejected.push({ id: m.id, tier: m.tier, reason: scan.kind, tag: scan.tag })
      else memories.push(m)
    }
    if (raw.length > 0 && memories.length === 0) {
      return { ok: false, error: '這個 bundle 裡的記憶全部沒過掃描（憑據或技術內容），一條都沒導入', rejected }
    }
    if (memories.length === 0 && !bundle.persona && !bundle.foundation) return { ok: false, error: 'the bundle carries nothing usable' }
    const before = { memories: this.allMemories(), persona: this.persona, foundation: this.foundation, selfView: this.selfView }
    const after = {
      memories,
      persona: bundle.persona || defaultPersona(),
      foundation: bundle.foundation || emptyFoundation(),
      selfView: bundle.selfView || emptySelfView(),
      understanding: bundle.understanding || defaultUnderstanding(),
    }
    const snapshot = snapshotOf('store', `導入 ${memories.length} 條記憶`, before, after)
    this.append('import.bundle', actor, { after, snapshot, from: bundle.exportedAt || null })
    return { ok: true, snapshotId: snapshot.id, imported: memories.length, rejected }
  }

  /* ───────────────────────── 檢索 ───────────────────────── */

  recall({ query = '', dims = [], facets = [], tier = 0, domain = '', limit = 8, includeArchived = false } = {}) {
    const now = Date.now()
    let rows = includeArchived ? this.allMemories(now) : [...this.activeMemories(now), ...this.scratchMemories(now)]
    if (tier) rows = rows.filter((m) => m.tier === Number(tier))
    if (domain) rows = rows.filter((m) => m.domain === domain)
    if (dims?.length) rows = rows.filter((m) => (m.dims || []).some((d) => dims.includes(d)))
    if (facets?.length) rows = rows.filter((m) => (m.facets || []).some((f) => facets.includes(f)))
    const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean)
    const scored = rows.map((m) => {
      const hay = `${m.title} ${m.body} ${(m.tags || []).join(' ')}`.toLowerCase()
      let hit = 0
      for (const term of terms) if (hay.includes(term)) hit += 1
      const match = terms.length ? hit / terms.length : 0
      const recency = clamp(1 - (now - Date.parse(m.updatedAt || m.bornAt)) / (86400000 * 400))
      return { m, score: (m.salience ?? 0) * 0.55 + match * 0.35 + recency * 0.1, match }
    })
    const filtered = terms.length ? scored.filter((x) => x.match > 0) : scored
    filtered.sort((a, b) => b.score - a.score)
    const picked = filtered.slice(0, Math.max(1, Math.min(30, Number(limit) || 8)))
    // 只記真的有 id 的：舊帳 / 導入檔裡可能混進沒有 id 的殘條，不要讓 null 滲進 runtime.recalls
    const touched = picked.map((x) => x.m.id).filter(Boolean)
    this.bumpRecall(touched)
    const promoted = this.promoteScratch(touched)
    return picked.map(({ m, score }) => {
      const after = promoted.get(m.id)
      // 只放真的存在的欄位：undefined 在工具輸出裡是「有損」的
      const row = {
        // 這一輪剛好升級的，id 直接給**新的那一條** —— 舊 id 已經 archived 了，
        // 再拿它去 condense / recall 只會被拒絕。
        id: after?.id ?? m.id,
        tier: after?.tier ?? m.tier,
        title: m.title,
        body: m.body,
        domain: m.domain,
        dims: m.dims || [],
        facets: m.facets || [],
        importance: m.importance,
        salience: Number((m.salience ?? 0).toFixed(3)),
        score: Number(score.toFixed(3)),
        ageDays: Math.round((now - Date.parse(m.bornAt)) / 86400000),
        firstSeen: m.firstSeen || '',
        archived: Boolean(m.archived),
      }
      // 這一輪剛好提起第 N 次 ⇒ 當場升成 T3，要讓它知道（不然下一輪它就找不到這條了）
      if (after) {
        row.upgradedTo = after.tier
        row.upgradedFrom = m.id
      }
      if (m.supersededBy) row.supersededBy = m.supersededBy
      if (m.compressedFrom?.length) row.compressedFrom = m.compressedFrom
      // 作廢的要讓它看見 —— 不然它會把一條已經被本人推翻的話當成現行事實，甚至拿它去推論。
      if (m.voided) {
        row.voided = true
        row.voidedReason = m.voidedReason || ''
        if (m.replacedBy) row.replacedBy = m.replacedBy
      }
      // 預測層要說清楚「到哪天為止」以及「是不是已經過了」——
      // 不然模型會把一句過去的預測當成現在的事實。
      if (m.tier === FORECAST.tier) {
        row.expiresAt = m.expiresAt || ''
        row.due = isDue(m, now)
      }
      if (m.evidence?.length) row.evidence = m.evidence
      return row
    })
  }

  injectionText() {
    if (!this.cfg.enabled) return ''
    const now = Date.now()
    const active = this.activeMemories(now)
    // 注入量：模型可以調，但插件給的硬頂在這裡落地 —— 就算帳本裡寫著更大的數，也按硬頂走
    const budget = Math.min(Number(this.cfg.injectBudget) || 1800, INJECT_TUNABLES.injectBudget.max)
    const rawCount = Number(this.cfg.injectCount)
    const count = clamp(
      Number.isFinite(rawCount) && rawCount > 0 ? rawCount : INJECT_TUNABLES.injectCount.max && 12,
      INJECT_TUNABLES.injectCount.min,
      INJECT_TUNABLES.injectCount.max,
    )
    return renderInjection({
      cfg: { ...this.cfg, injectCount: count },
      foundation: this.foundation,
      memories: active,
      budget,
    })
  }

  /**
   * 封存斷點。痕跡不會被抹掉：
   *   鏈接斷了 ⇒ 把原檔改名成 `ledger.broken-<時間>.jsonl` 留在同一個資料夾，只把「還連得上」那一截
   *              重新寫成新的帳，再補一筆 `chain.repair` 說明發生過甚麼。
   *   只是內容被改 ⇒ 原檔不動，直接補一筆 `chain.repair`；從此那一段標成「已封存」。
   */
  sealChain(note, { actor = 'user' } = {}) {
    let chain = this.verify({ force: true })
    if (chain.ok) return { ok: true, chain, sealed: false, alreadySealed: false }

    let quarantine = ''
    if (chain.reason === 'link' || chain.reason === 'seq' || chain.reason === 'json') {
      const stamp = nowIso().replace(/[:.]/g, '-')
      quarantine = join(this.home, `ledger.broken-${stamp}.jsonl`)
      const good = this.records.slice(0, chain.brokenAt ?? 0)
      try {
        renameSync(this.ledgerPath, quarantine)
        writeFileSync(this.ledgerPath, good.length ? `${good.map((r) => JSON.stringify(r)).join('\n')}\n` : '', 'utf8')
      } catch (err) {
        return { ok: false, error: `封存失敗：${err?.message || err}` }
      }
      this.reload()
    }

    const upToSeq = this.records.length
    this.append('chain.repair', actor, {
      note: oneLine(note || '封存斷點', 300),
      upToSeq,
      reason: chain.reason,
      brokenAt: chain.brokenAt,
      quarantined: quarantine ? quarantine.split(/[\\/]/).pop() : null,
    })
    chain = this.verify({ force: true })
    return { ok: true, chain, sealed: true, alreadySealed: false, quarantined: quarantine ? quarantine.split(/[\\/]/).pop() : null }
  }

  /* ───────────────────────── 重置 ───────────────────────── */

  /** 整本帳重來：舊帳改名留在原地，不是刪掉。 */
  resetAll({ actor = 'user' } = {}) {
    let moved = null
    if (existsSync(this.ledgerPath)) {
      const stamp = nowIso().replace(/[:.]/g, '-')
      moved = `ledger.reset-${stamp}.jsonl`
      try {
        renameSync(this.ledgerPath, join(this.home, moved))
      } catch (err) {
        return { ok: false, error: `舊帳改名失敗：${err?.message || err}` }
      }
    }
    this.runtime = emptyRuntime()
    this.persistRuntime()
    this.resetProjection()
    this.chain = blankChain()
    this.append('genesis', 'plugin', { schemaVersion: SCHEMA_VERSION, note: '重新開始', resetFrom: moved || null })
    return { ok: true, resetFrom: moved }
  }
}
