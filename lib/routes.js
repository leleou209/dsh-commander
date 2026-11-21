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

/** 持久会话 id 的前缀；带它的和不带它的指的是同一个会话（见 resolveSession）。 */
const SESSION_PREFIX = 'session-'

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

/** 用装配层暴露的探测器验路由（没有该能力时视为可用，保持 fail-open）。 */
async function probeRouteFor(app, route) {
  if (typeof app.probeRoute !== 'function') return { ok: true }
  return app.probeRoute(route)
}

/**
 * 把请求里的 route 规整成可存的形式；缺字段返回 undefined（由调用方给明确错误）。
 * 只做形状校验——provider/model 是否真的可用由 probeRoute 在建立时判定。
 */
function normalizeRoute(input) {
  if (input === undefined || input === null || typeof input !== 'object') return undefined
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider.length === 0 || model.length === 0) return undefined
  const effort = typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : ''
  return effort.length > 0 ? { provider, model, reasoningEffort: effort } : { provider, model }
}

/**
 * 跨源时要带的头。
 *
 * **为什么必须有：** 桌面版的页面可能不在本服务的 origin 上（file://、app:// 或另一个端口）。
 * 那时 `POST` + `content-type: application/json` 属于非简单请求，浏览器会**先发 OPTIONS 预检**；
 * 预检不是 GET/POST，从前直接落到最后的 405，表现就是"界面里切模型必失败，但 curl 一切正常"。
 * GET 是简单请求、不预检，所以状态和模型清单一直能显示——这个不对称正是当年的现场。
 */
function corsHeaders(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

const sendJson = (res, payload, status = 200, req) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(req),
  })
  res.end(body)
}

/** 相位由事实推导，不维护独立状态机：在飞 / 失败 / 有指挥员 / 什么都没有。 */
/** 一次初始化/建指挥员是否**仍在进行**。
 *
 * 失败（带 error）或超时之后都算"不进行了"——否则会死锁：
 * 失败记录会一直留在 inFlight 里，而重试被 `inFlight.has()` 无条件拒绝，
 * 于是界面上写着"点击重试"，点下去永远 409。
 */
function flightActive(app, rootId) {
  const flight = app.inFlight.get(rootId)
  if (flight === undefined) return false
  if (flight.error !== undefined) return false
  return Date.now() - flight.startedAt <= app.config.initTimeoutMs
}

function phaseOf(app, rootId, hasCommander) {
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

  /**
   * 会话 id 归一。
   *
   * 同一个会话在宿主里有**两种写法**：持久 id 带前缀（`session-<uuid>`），
   * 而 `Agent` 与 `Session.header.id` 用裸 uuid。前端/API 传哪一种都可能，
   * 插件拿哪一种去查都可能。
   *
   * 不归一的后果（云端真踩过）：`POST` 用 body 里的 id 建指挥员 → 成功；
   * 紧接着 `GET ?sessionId=<带前缀>` 查 `agents.get()` 拿到 undefined，
   * `rootId` 退化成那串带前缀的字符串 → `hasCommander` 恒为 false，
   * 界面上就是"初始化成功了，指挥员却不见了"。
   *
   * @returns {{ agent?, header?, rootId: string }}
   */
  const resolveSession = (raw) => {
    const candidates = [raw]
    if (raw.startsWith(SESSION_PREFIX)) candidates.push(raw.slice(SESSION_PREFIX.length))
    else candidates.push(`${SESSION_PREFIX}${raw}`)
    let fallback
    for (const candidate of candidates) {
      let agent
      let header
      try {
        agent = app.ctx.get('agents')?.get?.(candidate)
      } catch {
        agent = undefined
      }
      try {
        header = agent?.session?.header ?? app.ctx.get('sessions')?.get?.(candidate)?.header
      } catch {
        header = undefined
      }
      const resolved = { agent, header, id: candidate }
      if (agent !== undefined) return { ...resolved, rootId: app.rootIdOf(agent) }
      // 没活的 Agent 时，至少把"宿主认得这个 id"的那一种记下来当兜底。
      if (header !== undefined && fallback === undefined) fallback = resolved
    }
    if (fallback !== undefined) return { ...fallback, rootId: fallback.id }
    // 两种写法宿主都不认识（会话还没被加载）：就用传进来的那个，保持原有 fail-open 行为。
    return { agent: undefined, header: undefined, id: raw, rootId: raw }
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 预检：浏览器在跨源 POST 之前先问一句。必须在这里回，且**不能**要 sessionId。
    if (req.method === 'OPTIONS') {
      const headers = corsHeaders(req)
      res.writeHead(Object.keys(headers).length > 0 ? 204 : 405, headers)
      res.end()
      return
    }

    let sessionId = url.searchParams.get('sessionId') ?? ''
    let payload
    if (req.method === 'POST') {
      const raw = await readBody(req)
      try {
        payload = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        return sendJson(res, { error: 'invalid json' }, 400, req)
      }
      if (typeof payload?.sessionId === 'string' && payload.sessionId.length > 0) sessionId = payload.sessionId
    }
    if (sessionId.length === 0) return sendJson(res, { error: 'sessionId required' }, 400, req)

    const resolved = resolveSession(sessionId)
    const agent = resolved.agent
    const header = resolved.header
    const rootId = resolved.rootId
    const hasCommander = await app.hasCommander(rootId)
    // 查到指挥员就把"本会话确实有"登记下来：`tools.guard` 与 goal 门禁是同步入口，
    // 只能读这个集合。以前只有个别路径会登记，云端表现为"初始化成功了，门禁却没生效"。
    if (hasCommander) app.markCommanderRoot(rootId)
    const current = resolveMode({ hasCommander, override: store.mode(rootId), source: store.modeRecord(rootId)?.source })
    const stateJson = (extra = {}) => ({
      mode: current.mode,
      source: current.source,
      label: LABELS[current.mode],
      modes: MODES,
      labels: LABELS,
      hasCommander,
      phase: phaseOf(app, rootId, hasCommander),
      // 空会话（还没发过消息）宿主里没有 Agent 实例，而 spawn 子会话必须有 parent，
      // 所以初始化只能等会话真的开始。前端据此把按钮说清楚，别让人白点。
      canInit: agent !== undefined,
      // 读不到任何会话头才 fail-open；已知指挥员 id 也排除（它空闲时 residency 已释放）。
      canControl: header === undefined ? !app.commanderIds.has(sessionId) : !header.parentSession,
      // 插件自己记的指挥员路由（建立时写下的）。宿主的模型选择器不让 addressed
      // 子会话切模型，所以换模型由插件的选择器驱动，这里要能显示当前值。
      route: store.route(rootId) ?? null,
      ...extra,
    })

    // 模型清单单独一个端点：67 条路由不该塞进每次 8 秒一次的轮询。
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.endsWith('/models')) {
      const routes = (await app.collectModelRoutes?.()) ?? []
      const groups = []
      const byProvider = new Map()
      for (const item of routes) {
        let group = byProvider.get(item.provider)
        if (group === undefined) {
          group = { provider: item.provider, models: [] }
          byProvider.set(item.provider, group)
          groups.push(group)
        }
        group.models.push(item.model)
      }
      return sendJson(res, {
        current: store.route(rootId) ?? null,
        hasCommander,
        groups,
      }, 200, req)
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return sendJson(res, stateJson({ preheat: await readPreheat(app, rootId, agent) }), 200, req)
    }

    // 模型在建立时固定，**不给换**。
    // 宿主侧没有"改子会话模型"的合法表示（descriptor 取第一条、日志 append-only），
    // 早先那套 append model/selection 的绕法会把会话写坏，最终连话都说不上。
    // 这里明确拒绝，避免任何侧门（界面、脚本、工具）把它当成功。
    // 注意：init 请求本身**会**带 route（建立时选模型），所以这里要排除 init。
    if (req.method === 'POST' && payload?.init !== true && payload?.route !== undefined && payload?.route !== null) {
      return sendJson(res, {
        error: 'model-locked',
        message: '指挥员模型在建立时已固定，不能更换；要换只能重建（上下文会重置）。',
      }, 409, req)
    }

    if (req.method === 'POST' && payload?.init === true) {
      if (hasCommander) return sendJson(res, { error: 'already-ready', phase: 'ready' }, 409, req)
      // 只有"真的还在进行"才拒绝；失败/超时过的允许重试（否则永远卡死）。
      if (flightActive(app, rootId)) return sendJson(res, { error: 'in-flight' }, 409, req)
      // **建立前必须选定模型**：模型一旦建立就不可改，所以不能让它悄悄"跟随主会话"。
      // 已经记过路由（老会话升级上来）或 profile 配了 llm* 就不必再选。
      // 参数校验放在"会话是否活着"之前：请求本身不完整时，报 409 会误导排查方向。
      const chosen = normalizeRoute(payload?.route)
      const kept = store.route(rootId)
      // 三个来源依次生效：本次请求里选的 → 本会话早先记下的 → profile 里的 llm*。
      // 只要其中之一给出了 model，就算"建立前已经选定"。
      const effective = chosen ?? kept ?? normalizeRoute({
        provider: config.llmProvider,
        model: config.llmModel,
        reasoningEffort: config.llmReasoningEffort,
      })
      if (effective === undefined || effective === null) {
        return sendJson(res, {
          error: 'model-required',
          message: '建立指挥员之前必须先选定一个模型（当前会话还没有记录过模型）。',
        }, 400, req)
      }
      if (agent === undefined) return sendJson(res, { error: 'session not live' }, 409, req)
      // 路由不可用就别建：建出来只会是个"出生即坏"的指挥员，既不能用也删不干净。
      const probed = await probeRouteFor(app, effective)
      if (probed.ok !== true) {
        return sendJson(res, {
          error: 'unknown-route',
          message: probed.message ?? `模型 ${effective.provider}/${effective.model} 不可用`,
        }, 400, req)
      }
      app.inFlight.set(rootId, { startedAt: Date.now() })
      try {
        if (chosen !== undefined) store.setRoute(rootId, chosen)
        await app.ensureCommander(agent)
        app.inFlight.delete(rootId)
      } catch (error) {
        app.inFlight.set(rootId, { startedAt: Date.now(), error: error?.message ?? String(error) })
        return sendJson(res, { error: 'start-failed', message: error?.message ?? String(error) }, 500, req)
      }
      // 初始化只落地挡位：不写通知、不碰 goal。
      store.setMode(rootId, DEFAULT_MODE, 'init')
      return sendJson(res, { ok: true, mode: DEFAULT_MODE, phase: 'ready' }, 200, req)
    }

    if (req.method === 'POST') {
      const next = normalizeMode(payload?.mode)
      if (next === undefined) return sendJson(res, { error: 'invalid mode', modes: MODES }, 400, req)
      // 只有**需要新建指挥员**时才必须有活跃 Agent（spawn 需要 parent）。
      // 已有指挥员时切挡位只是改状态，不该因为会话暂时未激活就 409——
      // 否则会出现"有指挥员、却连关都关不掉"的死角。
      const needsSpawn = next !== 'off' && !hasCommander
      if (agent === undefined && needsSpawn) return sendJson(res, { error: 'session not live' }, 409, req)
      const before = resolveMode({ hasCommander, override: store.mode(rootId) }).mode
      let started = false
      if (needsSpawn) {
        app.inFlight.set(rootId, { startedAt: Date.now() })
        try {
          await app.ensureCommander(agent)
          started = true
          app.inFlight.delete(rootId)
        } catch (error) {
          app.inFlight.set(rootId, { startedAt: Date.now(), error: error?.message ?? String(error) })
          return sendJson(res, { error: 'start-failed', message: error?.message ?? String(error) }, 500, req)
        }
      }
      const announced = await app.applyMode(agent, next, before, rootId)
      // phase 必须按**真实结果**算，不能硬编码 'ready'：
      // 切到 off（或本来就没有指挥员）时这里 hasCommander 是 false，
      // 从前写死 'ready' 会让前端立刻画出皇冠——表现就是"切一下挡位，新会话凭空有了指挥员"。
      const hasNow = hasCommander || started
      return sendJson(res, stateJson({
        mode: next, source: 'user', hasCommander: hasNow,
        phase: phaseOf(app, rootId, hasNow), started, announced,
      }), 200, req)
    }

    return sendJson(res, { error: 'method not allowed' }, 405, req)
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

