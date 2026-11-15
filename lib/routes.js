/**
 * 图标用的 HTTP 路由。**读路径全 async**（这是相对老包的关键简化）。
 *
 * 三条语义边界：
 *   - 初始化（init）只「建立 + 预热 + 落默认挡位」：不写接管通知、不碰 goal；
 *   - 切挡位才写通知，且只有**参与级别真的变了**才动 goal；
 *   - 子会话一律 canControl:false（客户端另有首帧判定，这里是第二道）。
 *
 * 注册时机：**必须 `ctx.inject(['webServer'], …)`**。直接 `ctx.get('webServer')`
 * 时，插件加载顺序一变就拿不到服务，紧接着 `return` 掉，之后再也不会注册——
 * 表现为客户端所有请求 404、图标点了没反应（老包在 vps 上就踩过这个坑）。
 */

import { LABELS, MODES, DEFAULT_MODE, normalizeMode, resolveMode, shouldSyncGoal } from './modes.js'

const readBody = (req) =>
  new Promise((done) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 8192) req.destroy()
    })
    req.on('end', () => done(data))
    req.on('error', () => done(''))
  })

const sendJson = (res, payload, status = 200) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 相位由事实推导，不维护独立状态机：在飞 / 失败 / 有指挥员 / 什么都没有。 */
export function phaseOf(app, rootId, hasCommander) {
  const flight = app.inFlight.get(rootId)
  if (flight !== undefined) {
    if (flight.error !== undefined) return 'failed'
    if (Date.now() - flight.startedAt > app.config.initTimeoutMs) return 'failed'
    return 'provisioning'
  }
  return hasCommander ? 'ready' : 'none'
}

/**
 * 预热态：**先读活的，再退到落盘的那份**。
 *
 * 活的那份来自指挥员会话事件；进程一重启就没了（实测：重启后两个会话都读不到，
 * tooltip 因此只剩"已就绪"，代价数字消失）。所以完成时顺手写盘，
 * 读的时候盘上的那份当兜底 —— 代价承诺不能因为一次重启就消失。
 */
async function readPreheat(app, rootId, agent) {
  let live
  try {
    live = await app.preheat(agent)
  } catch {
    live = undefined
  }
  if (live !== undefined && live.state === 'done') {
    try {
      app.store.setPreheat(rootId, live)
    } catch {
      // 落盘失败不影响这次返回
    }
    return live
  }
  if (live !== undefined) return live
  return app.store.preheat(rootId)
}

/** 路由 handler 的工厂：只在 webServer 就位后被调用一次。 */
function createHandler(app) {
  const { config, store } = app

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let sessionId = url.searchParams.get('sessionId') ?? ''
    let payload
    if (req.method === 'POST') {
      const raw = await readBody(req)
      try {
        payload = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        return sendJson(res, { error: 'invalid json' }, 400)
      }
      if (typeof payload?.sessionId === 'string' && payload.sessionId.length > 0) sessionId = payload.sessionId
    }
    if (sessionId.length === 0) return sendJson(res, { error: 'sessionId required' }, 400)

    const agent = app.ctx.get('agents')?.get?.(sessionId)
    const header = agent?.session?.header ?? app.ctx.get('sessions')?.get?.(sessionId)?.header
    const rootId = agent !== undefined ? app.rootIdOf(agent) : sessionId
    const hasCommander = await app.hasCommander(rootId)
    const current = resolveMode({ hasCommander, override: store.mode(rootId), source: store.modeRecord(rootId)?.source })
    const stateJson = (extra = {}) => ({
      mode: current.mode,
      source: current.source,
      label: LABELS[current.mode],
      modes: MODES,
      labels: LABELS,
      hasCommander,
      phase: phaseOf(app, rootId, hasCommander),
      // 读不到任何会话头才 fail-open；已知指挥员 id 也排除（它空闲时 residency 已释放）。
      canControl: header === undefined ? !app.commanderIds.has(sessionId) : !header.parentSession,
      ...extra,
    })

    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, stateJson({ preheat: await readPreheat(app, rootId, agent) }))
    }

    if (req.method === 'POST' && payload?.init === true) {
      if (hasCommander) return sendJson(res, { error: 'already-ready', phase: 'ready' }, 409)
      if (app.inFlight.has(rootId)) return sendJson(res, { error: 'in-flight' }, 409)
      if (agent === undefined) return sendJson(res, { error: 'session not live' }, 409)
      app.inFlight.set(rootId, { startedAt: Date.now() })
      try {
        await app.ensureCommander(agent)
        app.inFlight.delete(rootId)
      } catch (error) {
        app.inFlight.set(rootId, { startedAt: Date.now(), error: error?.message ?? String(error) })
        return sendJson(res, { error: 'start-failed', message: error?.message ?? String(error) }, 500)
      }
      // 初始化只落地挡位：不写通知、不碰 goal。
      store.setMode(rootId, DEFAULT_MODE, 'init')
      return sendJson(res, { ok: true, mode: DEFAULT_MODE, phase: 'ready' })
    }

    if (req.method === 'POST') {
      const next = normalizeMode(payload?.mode)
      if (next === undefined) return sendJson(res, { error: 'invalid mode', modes: MODES }, 400)
      if (agent === undefined) return sendJson(res, { error: 'session not live' }, 409)
      const before = resolveMode({ hasCommander, override: store.mode(rootId) }).mode
      let started = false
      if (next !== 'off' && !hasCommander) {
        app.inFlight.set(rootId, { startedAt: Date.now() })
        try {
          await app.ensureCommander(agent)
          started = true
          app.inFlight.delete(rootId)
        } catch (error) {
          app.inFlight.set(rootId, { startedAt: Date.now(), error: error?.message ?? String(error) })
          return sendJson(res, { error: 'start-failed', message: error?.message ?? String(error) }, 500)
        }
      }
      const announced = await app.applyMode(agent, next, before)
      return sendJson(res, stateJson({
        mode: next, source: 'user', hasCommander: hasCommander || started,
        phase: 'ready', started, announced,
      }))
    }

    return sendJson(res, { error: 'method not allowed' }, 405)
  }
}

export function registerRoutes(app) {
  const { ctx, config } = app
  if (typeof ctx.inject !== 'function') return undefined

  const held = ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return undefined
    return webCtx.effect(() => webServer.register({ kind: 'prefix', path: config.routePath, handler: createHandler(app) }))
  })
  // 只把函数当 disposer 交回去：inject 的返回值不保证是函数，别让上层拿到怪东西。
  return typeof held === 'function' ? held : undefined
}

export { shouldSyncGoal }
