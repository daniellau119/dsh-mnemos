/**
 * dsh-mnemos · 心相 —— 宿主半端
 * ===========================================================================
 * 跨會話記憶、自進化性格與喜好；3D 星圖頁面在左側欄；谷時自主值守。
 *
 * 它做四件事：
 *   1. **記憶與人格的檔案**（`<DSH_HOME>/mnemos/ledger.jsonl`）：append-only、每筆帶
 *      sha256 串起的 `prev`/`hash`，記憶 / 人格 / 結構的改寫一律留 before/after 快照，
 *      可按快照 id 回滾。刪除、覆蓋、回滾、導入這一類不可逆動作只可以由本人確認。
 *   2. **注入**：把「現在的自己 + 仍記得的 + 還不明白的」壓成一段系統提示，每個會話都看得到。
 *   3. **七隻手**：mnemos_recall / remember / revise / shape / persona / archive / duty。
 *   4. **谷時值守**：落在 DeepSeek 優惠時段才排一輪自主任務，交給 Harness 自己開會話去決定
 *      「要不要刷 B站、要不要整理、要不要改自己」—— 決定不做也是有效決策。
 *
 * 硬性界線（本檔與 lib/ 一起釘死）：代碼 / 技術決策 / 環境配置不入記憶；不記身份證與信用卡；
 * 記憶不能捏造（每筆都釘著寫入時的會話作為證據）；任何改寫都不可靜默抹除。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { makeDuty } from './lib/duty.js'
import { makeBili } from './lib/bili.js'
import { makeFence, makeRoutes } from './lib/routes.js'

export const name = 'mnemos'
export const inject = ['tools', 'systemPrompt', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

const versionOf = () => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

/** 插件家目錄：`<DSH_HOME>/mnemos`（沿用宿主給的 dshHomePath，拿不到才自己拼）。 */
function resolveHome(ctx) {
  try {
    const p = ctx.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('mnemos')
      if (v) return String(v)
    } else if (typeof p === 'string' && p) {
      return join(p, 'mnemos')
    }
  } catch {
    /* 拿不到就走下面的兜底 */
  }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mnemos')
}

export function apply(ctx, config) {
  const home = resolveHome(ctx)
  const log = (msg) => {
    try {
      if (ctx.logger?.info) ctx.logger.info(`[mnemos] ${msg}`)
      else console.log(`[mnemos] ${msg}`)
    } catch {
      /* 日誌不該影響任何東西 */
    }
  }

  const store = new Store(home, config && typeof config === 'object' ? config : {})
  store.load()
  const duty = makeDuty({ ctx, store, log })
  store.duty = duty.info()
  // 「允許它自己調用刷B站」的橋：這頁只給許可，刷不刷與那些參數由它自己判斷
  store.bili = makeBili({ store, webServer: ctx.get ? ctx.get('webServer') : undefined, log })

  /* ── 七隻手 ── */
  let toolCount = 0
  try {
    for (const definition of buildTools(store)) {
      ctx.effect(() => ctx.tools.register(definition, { when: () => Boolean(store.cfg.enabled) }), `mnemos: ${definition.name}`)
      toolCount += 1
    }
  } catch (err) {
    log(`工具註冊失敗：${err?.message || err}`)
  }

  /* ── 注入（每個會話的系統提示尾巴） ── */
  try {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'mnemos',
          order: 850,
          text: () => {
            try {
              return store.injectionText()
            } catch (err) {
              return ''
            }
          },
        }),
      'mnemos: persona & memory injection',
    )
  } catch (err) {
    log(`注入註冊失敗：${err?.message || err}`)
  }

  /* ── 插件頁面用的 HTTP 通道 ── */
  try {
    const fence = makeFence(ctx, log)
    const handler = makeRoutes({ store, duty, version: versionOf(), log, fence })
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/mnemos', handler }), 'mnemos: /api/mnemos')
  } catch (err) {
    log(`HTTP 路由掛不上：${err?.message || err}`)
  }

  /* ── 谷時值守心跳 ── */
  try {
    ctx.effect(() => {
      let alive = true
      const beat = () => {
        if (!alive) return
        duty.tick().catch((err) => log(`值守心跳出錯：${err?.message || err}`))
      }
      const timer = setInterval(beat, 120000)
      timer.unref?.()
      // 開機後 8 秒補一拍：這個 timer 也要收得回來，否則插件卸載後它還會再叫一次
      const boot = setTimeout(beat, 8000)
      boot.unref?.()
      return () => {
        alive = false
        clearInterval(timer)
        clearTimeout(boot)
      }
    }, 'mnemos: duty tick')
  } catch (err) {
    log(`值守心跳起不來：${err?.message || err}`)
  }

  log(`已掛載 · ${toolCount} 隻手 · 家目錄 ${home} · 記憶 ${store.memories.size} 條 · 總開關 ${store.cfg.enabled ? '開' : '關'}`)
}
