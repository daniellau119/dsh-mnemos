/**
 * Silt/lib/bili.js — 「允許它自己調用」而不是「叫它去刷」
 * ---------------------------------------------------------------------------
 * 心相這一頁只管一件事：**可否**自行調用已安裝的刷B站工具（總開關，預設關）。
 * 「刷不刷、刷多久、刷幾條」是它自己的事，在值守那一輪裡自己決定。
 *
 * 刷B站那些參數（每天幾條、一輪細看幾條、關注什麼、排除什麼…）由它按這陣子從記憶與喜好
 * 長出來的判斷**自己調**：走 bili_cfg / silt_bili 工具 → 這裡的白名單 + 硬範圍 → 寫進
 * 刷B站插件自己的設定（那份才是它真正生效的家）。每一筆調整都留一條 `bili.profile` 快照。
 *
 * 白名單外的一律不碰：帳號與登入、私信收件人、自動評論 / 回覆（那是借本人的號說話）、
 * 清理紀錄、工作日誌、模型這些跟「喜好」無關的面。
 */
import { BILI_DEFAULTS, BILI_TUNABLES, diffProfile, sanitizeProfile } from './model.js'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 刷B站那份憑證只給人看「誰、幾時」，**不把 SESSDATA 拿出去** —— 那等於帳號。
 * 檔案裡沒有寫入時間，所以登入時間取檔案的 mtime（掃碼成功那一刻寫檔，兩者一致）。
 */
function credentialInfo() {
  const dir = join(homedir(), '.dsh', 'bili-duty')
  const file = join(dir, 'bili_credential.json')
  try {
    const st = statSync(file)
    let uid = ''
    try {
      uid = String(JSON.parse(readFileSync(file, 'utf8'))?.dedeuserid || '')
    } catch {
      /* 檔在但讀不成 JSON：只交出時間 */
    }
    return { uid, loggedAt: new Date(st.mtimeMs).toISOString() }
  } catch {
    return { uid: '', loggedAt: null }
  }
}

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** 依喜好算出來的調整理由（寫進快照，之後看得出「那時候為什麼那樣調」）。 */
export function rationaleFromPersona(persona = {}) {
  const bits = []
  for (const t of (persona.traits || []).slice(0, 3)) bits.push(`${t.key}${t.value ? `：${oneLine(t.value, 40)}` : ''}`)
  for (const t of (persona.taste || []).slice(0, 2)) bits.push(`${t.key}${t.value ? `：${oneLine(t.value, 36)}` : ''}`)
  return oneLine(bits.join('；') || '還沒沉澱出喜好，按當下的判斷調', 240)
}

export function makeBili({ store, webServer, log = () => {} }) {
  let probe = { at: 0, ok: false, error: '', config: null }

  const origin = () => {
    try {
      return typeof webServer?.getOrigin === 'function' ? String(webServer.getOrigin() || '').replace(/\/$/, '') : ''
    } catch {
      return ''
    }
  }

  const call = async (path, init = {}) => {
    const base = origin()
    if (!base) return { ok: false, error: '本機的 web 服務還沒起來' }
    try {
      const res = await fetch(`${base}/api/bili-duty${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `刷B站那邊不放行（HTTP ${res.status}：需要本人在場的登入態，插件自己叫不動）` }
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, body: await res.json() }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  /** 讀刷B站現在的設定；順便判斷那個插件在不在。 */
  async function read({ fresh = false } = {}) {
    if (!fresh && probe.ok && Date.now() - probe.at < 30000) return probe
    const res = await call('/status')
    if (!res.ok) {
      probe = { at: Date.now(), ok: false, error: res.error, config: null }
      return probe
    }
    const cfg = res.body?.config || null
    probe = {
      at: Date.now(),
      ok: Boolean(cfg),
      error: cfg ? '' : '刷B站回應裡沒有設定（可能版本太舊）',
      config: cfg,
    }
    return probe
  }

  const tuneOf = (cfg) => (cfg ? sanitizeProfile(cfg, BILI_DEFAULTS) : null)

  return {
    /** 頁面與工具共用的現況：在不在、現在這些參數是什麼。 */
    async status() {
      const info = await read()
      return { installed: info.ok, error: info.error || undefined, now: tuneOf(info.config), cred: credentialInfo() }
    },

    /**
     * 按喜好調整。只認白名單裡的鍵，值一律鉗進硬範圍；沒有真的變就什麼也不寫。
     */
    async apply(patch, { reason = '', actor = 'model' } = {}) {
      if (!store.cfg.enabled) return { ok: false, error: 'Silt 是關的' }
      if (!store.cfg.bili) return { ok: false, error: '本人還沒允許你自行調用刷B站工具（Silt 頁那個總開關是關的）' }

      const info = await read({ fresh: true })
      if (!info.ok) return { ok: false, error: `刷B站沒有回應：${info.error}`, installed: false }

      const asked = []
      for (const key of Object.keys(patch || {})) {
        if (!(key in BILI_TUNABLES)) asked.push(key)
      }
      const allowed = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => k in BILI_TUNABLES))
      if (Object.keys(allowed).length === 0) {
        return { ok: false, error: `這些不在允許調整的清單裡：${asked.join(', ') || '(空)'}；可調的只有：${Object.keys(BILI_TUNABLES).join(', ')}` }
      }

      const current = tuneOf(info.config)
      const next = sanitizeProfile(allowed, current)
      const diff = diffProfile(current, next)
      if (Object.keys(diff).length === 0) return { ok: true, unchanged: true, note: '這些已經就是現在的值', ignored: asked, now: current }

      const before = current
      const note = oneLine(reason || rationaleFromPersona(store.persona), 240)
      store.append('bili.profile', actor, { before, after: next, diff, reason: note })

      const clear = Object.keys(diff).filter((k) => Array.isArray(diff[k]) && diff[k].length === 0)
      const wrote = await call('/config', { method: 'POST', body: JSON.stringify({ ...diff, ...(clear.length ? { clear } : {}) }) })
      if (!wrote.ok) {
        // 宿主這一側寫不進去（它的介面只認本人在場的登入態）：
        // 帳上記「我要調成這樣、為什麼」，並把要下的那一手原樣交回給它自己去做。
        log(`刷B站設定這一步要它自己下：${JSON.stringify(diff)}（${wrote.error}）`)
        return {
          ok: true,
          recorded: true,
          wrote: false,
          blocked: wrote.error,
          patch: diff,
          now: next,
          ignored: asked,
          reason: note,
          next: `這一步宿主程序改不到它（${wrote.error}）。用 bili_config 工具、原樣把 ${JSON.stringify(diff)} 寫進去就好；寫完不用再 tune。`,
        }
      }
      log(`刷B站設定已按喜好調整：${JSON.stringify(diff)}（${note}）`)
      probe.at = 0
      return { ok: true, recorded: true, wrote: true, changed: diff, now: next, ignored: asked, reason: note }
    },
  }
}
