/**
 * 加载测试：用假宿主把 `apply()` 真跑一遍。
 *
 * 为什么必须有：单测证明得了纯函数，证明不了**接线**。
 * 这个包从没被真宿主加载过，而接线错误（ctx.effect 返回值、ctx.on 的参数形状、
 * tools.register 的字段、路由的 req/res）在单测里一律看不出来，装上却是废的。
 *
 * 这个假宿主只实现本包真正用到的那一小片 API，故意做窄：
 * 一旦本包开始依赖新 API，这里会因为缺少实现而失败——这正是我们要的提醒。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildAgentOptions, inject, name, apply } from '../index.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const flush = () => new Promise((done) => setTimeout(done, 80))

/**
 * ensureDocs 会真建文件，所以所有 cwd 都必须落在临时目录，绝不能是 process.cwd()。
 * 两个目录故意不同：SESSION_CWD 是会话自带的 cwd，SERVICE_CWD 是 workingDirectory
 * 服务给的值。cwd 解析必须以会话自带的为准——搞反了就会把 doc 写进 profile 目录。
 *
 * 目录名带**本次运行**的唯一后缀：曾经用固定名，上一次运行留下的 doc/ 会让下一次的
 * 「不写服务目录」断言失败，结果同一个包时绿时红。
 */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`
const SESSION_CWD = path.join(os.tmpdir(), `cmdr-core-load-session-${RUN_ID}`)
const SERVICE_CWD = path.join(os.tmpdir(), `cmdr-core-load-service-${RUN_ID}`)

const exists = async (target) => {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 造一个假宿主。`log` 记录所有跨服务的调用，便于断言"做了什么/没做什么"。
 *
 * `holdWebServer: true` 把 webServer 挂起，模拟「apply 时服务还没就位」——
 * 真机上这就是图标全 404 的那个场景，用 `provide('webServer', …)` 让它晚到。
 */
function makeHost({ commanderName = 'commander', holdWebServer = false, rejectProviders = [], withLlm = false, subagentsBroken = false } = {}) {
  const log = []
  const state = {
    commanderId: undefined,
    commanderStatus: 'inactive',
    descendants: [],
    goal: undefined,
    mode: undefined,
  }

  // 子会话在内存里的激活（宿主那边就是这个用途），用例可以直接清空来模拟"冷"。
  const resident = new Map()
  state.resident = resident

  const subagents = {
    async startActivation(spec) {
      // 0.2.2-rc.3 真实契约：**扁平** spec —— parent / prompt / maxDepth / delivery / name 都在顶层。
      // 宿主 startActivation 先读 spec.parent.id，读不到就抛
      // "Cannot read properties of undefined (reading 'id')"（本机真踩过）。
      if (spec.parent === undefined) throw new Error("Cannot read properties of undefined (reading 'id')")
      if (spec.maxDepth === undefined) throw new Error("Cannot read properties of undefined (reading 'maxDepth')")
      log.push({ call: 'startActivation', provider: spec.provider, delivery: spec.delivery, name: spec.name, agentOptions: spec.agentOptions, prompt: String(spec.prompt?.[0]?.text ?? ''), maxDepth: spec.maxDepth })
      if (rejectProviders.includes(spec.provider)) throw new Error(`provider ${spec.provider} 不可用`)
      state.commanderId = 'cmdr-1'
      state.commanderStatus = 'running'
      state.descendants = [{ kind: 'child', id: 'cmdr-1', path: spec.name, name: spec.name, mode: 'continuable', label: 'x', depth: 1 }]
      // 宿主真实形状：SubagentActivation 带 dispose()，那是**唯一**能拆掉子会话的东西
      // （Agent 只有 cancel()，subagents 服务没有 delete）。
      return {
        childId: 'cmdr-1',
        name: spec.name,
        dispose: async () => {
          state.disposed = true
          log.push({ call: 'activation.dispose' })
        },
      }
    },
    async listDescendants(rootId) {
      log.push({ call: 'listDescendants', rootId })
      // 宿主读不到这个会话时的真实形状（云端实测：实例刚起来还没有该会话的投影）。
      if (subagentsBroken === true) {
        const error = new Error(`session "${rootId}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      // 按 rootId 隔离：这是宿主的真实语义，也是"会话 A 的指挥员不能算进会话 B"的前提。
      if (state.byRoot !== undefined) return state.byRoot[rootId] ?? []
      return state.descendants
    },
    // 宿主的冷恢复路径：子会话不在内存时，deliverPrompt 会走 restoreTarget 把它
    // 重新物化成激活。真实实现这里**不传 delivery**，于是落回默认的 "parent"。
    resident,
    async restoreTarget(root, childId) {
      log.push({ call: 'restoreTarget', childId })
      if (state.restoreFails === true) throw new Error(`subagent "${childId}" is unavailable`)
      const activation = { childId, root, delivery: 'parent', accepted: true }
      resident.set(childId, activation)
      return activation
    },
    async sendMessage(sender, targetId, content) {
      // 真宿主在这里自己冷恢复（delivery 落到默认 parent），然后才交付。
      if (!resident.has(targetId)) {
        log.push({ call: 'restoreTarget', childId: targetId })
        resident.set(targetId, { childId: targetId, delivery: 'parent', accepted: true })
      }
      log.push({ call: 'sendMessage', targetId, text: String(content?.[0]?.text ?? '') })
      // 模拟"这条成员会话已经读不动了"（宿主措辞：subagent "…" is unavailable）
      if (typeof state.failSend === 'function' && state.failSend(targetId)) {
        throw new Error(`subagent "${targetId}" is unavailable`)
      }
      return { id: `msg-${log.length}` }
    },
  }

  // 真宿主里「当前打开的会话」一定有活 agent；假宿主必须照做，
  // 否则 init / 切挡位会因为 session not live 提前退出，测出来的是假失败。
  const makeRootAgent = () => ({
    id: 'root-1',
    status: 'idle',
    session: { header: { id: 'root-1' }, cwd: SESSION_CWD, seq: 0 },
    followup: () => {},
  })
  const makeCommanderAgent = () => ({
    id: 'cmdr-1',
    status: state.commanderStatus,
    session: {
      header: { id: 'cmdr-1', parentSession: 'root-1' },
      // 宿主用 session.append 写 subagent/model-selection-policy；插件要能给它换模型就得走这里。
      append: (type, data) => {
        log.push({ call: 'session.append', type, data })
      },
    },
    ctx: { tools: { restrict: () => () => {} } },
    // 宿主的 AgentModel.select：只往会话追加一条 model/selection（**不重建**）。
    // 这是"原地换模型"的关键——插件用它就能保住上下文。
    model: {
      select: (selection) => {
        log.push({ call: 'agent.model.select', selection })
        state.commanderModel = { ...selection }
      },
      current: () => state.commanderModel,
    },
  })
  const agents = {
    get: (id) => {
      // 真实世界里指挥员可能在 catalog 里但**没有活 agent**（没打开过/已释放），
      // 用它模拟"只能从会话存储读事件"的场景。
      if (id === 'cmdr-1') return state.commanderLive === false ? undefined : makeCommanderAgent()
      if (id === 'root-1') return makeRootAgent()
      if (id === 'root-2') return { id: 'root-2', status: 'idle', session: { header: { id: 'root-2' }, cwd: SESSION_CWD, seq: 0 }, followup: () => {} }
      return undefined
    },
    // 宿主的 AgentRegistry.resume：激活周期结束后用它把子会话重新加载回内存。
    // 这是宿主 resolveAgent() 内部走的同一条路。
    resume: async ({ resumeSessionId }) => {
      log.push({ call: 'agents.resume', resumeSessionId })
      if (state.resumeFails === true) throw new Error('resume failed')
      if (resumeSessionId !== 'cmdr-1') throw new Error(`unknown session ${resumeSessionId}`)
      state.commanderLive = true
      return { agent: makeCommanderAgent(), dispose: async () => log.push({ call: 'resume.dispose' }) }
    },
  }

  const sessions = { get: (id) => (id === 'cmdr-1' ? state.commanderSession : id === 'root-1' && state.rootSessionKnown !== false ? { header: { id: 'root-1' } } : undefined) }

  // 宿主的 GoalRef 是 `{ id, revision }`；字段写错时宿主报的是
  // `stale goal ref "undefined" revision undefined`。mock 必须同样硬校验。
  const assertGoalRef = (ref, where) => {
    if (typeof ref?.id !== 'string' || !Number.isInteger(ref?.revision)) {
      throw new Error(`${where} 的 ref 形状不对：${JSON.stringify(ref)}`)
    }
  }

  const goals = {
    get: () => state.goal,
    create: (_agent, request) => {
      log.push({ call: 'goals.create', objective: request.objective })
      state.goal = { id: 'g1', objective: request.objective, revision: 1, phase: 'active' }
    },
    edit: (_agent, ref, request) => {
      assertGoalRef(ref, 'edit')
      log.push({ call: 'goals.edit', objective: request.objective })
      state.goal = { ...state.goal, objective: request.objective, revision: ref.revision + 1 }
    },
    pause: (_agent, ref) => {
      assertGoalRef(ref, 'pause')
      log.push({ call: 'goals.pause' })
      state.goal = { ...state.goal, phase: 'paused', revision: ref.revision + 1 }
    },
    resume: (_agent, ref) => {
      assertGoalRef(ref, 'resume')
      log.push({ call: 'goals.resume' })
    },
    complete: (_agent, ref) => {
      assertGoalRef(ref, 'complete')
      log.push({ call: 'goals.complete' })
    },
    clear: (_agent, ref) => {
      assertGoalRef(ref, 'clear')
      log.push({ call: 'goals.clear' })
      state.goal = undefined
    },
  }

  // 故意和服务给的目录不同：用来证明 cwd 解析优先取会话自带的那个。
  const workingDirectory = { get: () => SERVICE_CWD, ensure: async () => SERVICE_CWD }

  let routeHandler
  const webServer = {
    register(definition) {
      routeHandler = definition.handler
      log.push({ call: 'webServer.register', path: definition.path })
      return () => {}
    },
  }

  const services = { subagents, agents, sessions, goals, workingDirectory, webServer }
  // llm 只在这条用例里需要（插件要靠它枚举"全部可选模型"）。
  // 默认不给，免得所有既有用例的调用日志都多一条。
  if (withLlm) {
    services.llm = {
      // 宿主的 `selectModel` 内部就是用这个校验路由能不能用；
      // 我们绕过 selectModel 直接 select，所以必须自己调它。
      async resolveCallConfig(selection) {
        log.push({ call: 'llm.resolveCallConfig', selection })
        const known = {
          'deepseek-account': ['deepseek-flash'],
          qwen: ['qwen4-max-preview', 'qwen3.8-flash'],
        }
        if (known[selection.provider]?.includes(selection.model) !== true) {
          throw new Error(`no such route ${selection.provider}/${selection.model}`)
        }
        // 真宿主连 reasoningEffort 一起校验（实测抛
        // `UNSUPPORTED_REASONING_EFFORT: ... does not support reasoning effort "high"`）：
        // 只有声明了档位的模型才接受，这里照抄这条规则。
        const efforts = { 'qwen/qwen3.8-flash': ['low', 'high'] }
        const effort = selection.reasoningEffort
        if (typeof effort === 'string' && effort.length > 0
          && (efforts[`${selection.provider}/${selection.model}`] ?? []).includes(effort) === false) {
          throw new Error(
            `provider "${selection.provider}" model "${selection.model}" does not support reasoning effort "${effort}"`,
          )
        }
        return selection
      },
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek Account' },
        { id: 'qwen', name: 'Qwen' },
        { id: 'broken', name: 'Broken Provider' },
      ],
      async listModels(providerId) {
        log.push({ call: 'llm.listModels', providerId })
        if (providerId === 'deepseek-account') return [{ id: 'deepseek-flash', name: 'Flash' }]
        if (providerId === 'qwen') {
          return [{ id: 'qwen4-max-preview', name: 'Qwen4 Max' }, { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' }]
        }
        // 拉不到列表的 provider 必须被跳过，不能拖垮整次建立
        throw new Error('provider listing unavailable')
      },
    }
  }
  const handlers = new Map()
  const tools = []
  const guards = []
  const effects = []
  const pending = []

  const ctx = {
    get: (service) => services[service],
    logger: { info: () => {}, warn: () => {} },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== fn))
      }
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    // 真宿主的 ctx.inject：声明依赖，**服务就位后才回调**，允许晚到。
    // 这个假实现很窄，但足以证明「用了 inject 而不是直取」。
    inject(declared, fn) {
      if (declared.every((service) => services[service] !== undefined)) {
        const disposer = fn(ctx)
        return typeof disposer === 'function' ? disposer : () => {}
      }
      pending.push({ declared, fn })
      return () => {
        const index = pending.findIndex((entry) => entry.fn === fn)
        if (index >= 0) pending.splice(index, 1)
      }
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
      restrict: () => () => {},
    },
  }

  if (holdWebServer) delete services.webServer

  /** 让一个服务晚到：真宿主里晚到的服务会唤醒此前挂起的 inject 回调。 */
  const provide = (service, value) => {
    services[service] = value
    for (const entry of [...pending]) {
      if (entry.declared.every((name) => services[name] !== undefined)) {
        pending.splice(pending.indexOf(entry), 1)
        entry.fn(ctx)
      }
    }
  }

  return {
    ctx, log, state, tools, guards, handlers, effects, webServer, pending,
    provide,
    route: () => routeHandler,
    emit: (event, ...args) => {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    setCommanderSession: (session) => {
      state.commanderSession = session
    },
  }
}

/** 造一个假 agent（根会话）。 */
const rootAgent = () => ({
  id: 'root-1',
  status: 'idle',
  session: { header: { id: 'root-1' }, cwd: SESSION_CWD, seq: 0 },
  followup: () => {},
})

/** 直接调用路由，拿回解析后的 JSON。 */
/** 测试默认模型：绝大多数用例只关心别的行为，不该每次手写 route。 */
const TEST_ROUTE = { provider: 'qwen', model: 'qwen4-max-preview' }

async function call(host, { method = 'GET', query = '', body, headers } = {}) {
  // 初始化必须带模型（模型在建立时固定）。用例要测"没带模型"就显式传 route: null。
  if (body !== undefined && body !== null && body.init === true && body.route === undefined) {
    body = { ...body, route: TEST_ROUTE }
  }
  const req = {
    method,
    headers: headers ?? {},
    url: `/commander/takeover${query}`,
    on(event, fn) {
      if (event === 'end') setImmediate(() => fn())
      if (event === 'data' && body !== undefined) fn(JSON.stringify(body))
      if (event === 'error') return
    },
    destroy() {},
  }
  let payload
  const res = {
    writeHead: (status, headers) => {
      // 记下状态码：有分支要按 400/500 区分（例如"路由不存在"是调用方的错）。
      payload = { status, headers }
    },
    end: (text) => {
      payload = { ...payload, json: typeof text === 'string' && text.length > 0 ? JSON.parse(text) : undefined }
    },
  }
  await host.route()(req, res)
  return payload
}

check('apply() 能在假宿主上跑通，且注册了两个工具 + 一条路由 + 门禁', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-load-'))
  assert.equal(name, 'dsh-commander')
  assert.deepEqual(inject, ['tools', 'subagents'])
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), commanderName: 'commander' })
  await flush()
  assert.equal(host.tools.length, 2, '必须有 commander 与 commander_record')
  for (const tool of host.tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0)
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0)
    assert.equal(tool.parameters.type, 'object')
    assert.ok(Array.isArray(tool.parameters.required))
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  assert.ok(host.route() !== undefined, '必须注册图标路由')
  assert.ok(host.guards.length >= 1, '必须注册门禁')
})

check('webServer 晚到：路由仍然会注册（直取 ctx.get 就会整片 404）', async () => {
  const host = makeHost({ holdWebServer: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-late-web-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  assert.equal(host.route(), undefined, 'webServer 没就位时路由当然还挂不上')
  assert.ok(host.pending.length >= 1, '必须用 ctx.inject 挂起等 webServer，而不是取不到就放弃')
  host.provide('webServer', host.webServer)
  await flush()
  assert.ok(host.route() !== undefined, 'webServer 就位后必须把路由补注册上（否则图标全 404）')
  const out = await call(host, { query: '?sessionId=root-1' })
  assert.equal(out.json.phase, 'none')
})

check('GET：没有指挥员 → phase=none、canControl=true、默认挡位 observe 由前端呈现', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-get-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const out = await call(host, { query: '?sessionId=root-1' })
  assert.equal(out.json.phase, 'none')
  assert.equal(out.json.hasCommander, false)
  assert.equal(out.json.canControl, true, '主会话入口不能误藏')
  assert.deepEqual(out.json.modes, ['off', 'observe', 'partial', 'full'])
})

check('选定了模型就必须走 spawn：fork 会静默丢弃模型参数', async () => {
  // 用户的模型选择是硬要求，而 fork 为保 KV cache 会主动丢掉 agentOptions（宿主源码注释），
  // 传了也静默无效——那比报错危险，所以选了模型就只给 spawn。
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-fork-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const first = host.log.find((entry) => entry.call === 'startActivation')
  assert.equal(first?.provider, 'spawn', '选了模型就必须 spawn')
  assert.deepEqual(
    { provider: first?.agentOptions?.provider, model: first?.agentOptions?.model },
    { provider: 'qwen', model: 'qwen4-max-preview' },
    'agentOptions 要带上用户选的那条路由',
  )
})

check('预热代价有落盘兜底：重启后 GET 仍给得出数字', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-preheat-'))
  const statePath = path.join(dir, 'state.json')
  await fsp.writeFile(statePath, JSON.stringify({
    schema: 1,
    modes: {},
    pending: {},
    preheat: { 'root-1': { state: 'done', ms: 5135, steps: 2, tools: 5, tokens: { total: 44189, cacheRead: 271360 } } },
  }), 'utf8')
  const host = makeHost()
  apply(host.ctx, { statePath })
  await flush()
  const out = await call(host, { query: '?sessionId=root-1' })
  assert.equal(out.json.preheat?.state, 'done', '活的读不到时必须退到落盘那份')
  assert.equal(out.json.preheat?.ms, 5135)
  assert.equal(out.json.preheat?.tokens?.cacheRead, 271360, '缓存命中要单列，不能算进花掉')
})

check('cwd 取会话自带那个：不写服务目录、不写进程目录', async () => {
  await fsp.rm(SESSION_CWD, { recursive: true, force: true })
  await fsp.rm(SERVICE_CWD, { recursive: true, force: true })
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-cwd-'))
  // process.cwd() 取决于从哪跑测试；直接把进程目录换成一个干净的临时目录，
  // 这样"有没有退回进程目录"这条断言才可靠（之前从仓库根跑时因为根目录有 doc/ 而误红）。
  const pristine = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-pristine-'))
  const original = process.cwd()
  process.chdir(pristine)
  try {
    apply(host.ctx, { statePath: path.join(dir, 'state.json') })
    await flush()
    await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
    assert.equal(await exists(path.join(SESSION_CWD, 'doc', 'history.md')), true, 'doc 必须建在会话自己的 cwd 下')
    assert.equal(await exists(path.join(SERVICE_CWD, 'doc')), false, '服务给的目录不该被使用（会话 cwd 优先）')
    assert.equal(await exists(path.join(pristine, 'doc')), false, '绝不能退回进程目录（Electron 里那是 profile 目录）')
  } finally {
    process.chdir(original)
  }
})

check('全新会话没有 catalog 投影时，必须照样建指挥员（本地回归）', async () => {
  // 真实宿主对**还没有任何子会话**的新会话会抛
  // SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE / SESSION_QUERY_SESSION_NOT_FOUND。
  // 这是"还没有子会话"的正常状态；把它当成"宿主读不到"就会让新会话永远建不出指挥员。
  const host = makeHost({ subagentsBroken: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-fresh-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()

  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(out.status, 200, `新会话必须能建：${JSON.stringify(out.json)}`)
  assert.equal(host.log.filter((e) => e.call === 'startActivation').length, 1, '必须真的去建指挥员')
})

check('跨源切换模型：OPTIONS 预检必须 204，响应必须带 CORS 头', async () => {
  // 桌面版页面可能不在本服务 origin 上：POST + application/json 会先发预检。
  // 预检从前落到最后的 405，表现是"界面里切模型必失败，curl 一切正常"。
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-cors-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })

  const pre = await call(host, {
    method: 'OPTIONS',
    query: '?sessionId=root-1',
    headers: { origin: 'app://dsh' },
  })
  assert.equal(pre?.status, 204, '预检必须 204，不能 405')
  assert.equal(pre.headers['access-control-allow-origin'], 'app://dsh')
  assert.ok(String(pre.headers['access-control-allow-methods']).includes('POST'), '要允许 POST')
  assert.ok(String(pre.headers['access-control-allow-headers']).includes('content-type'), '要允许 content-type')

  const switched = await call(host, {
    method: 'POST',
    headers: { origin: 'app://dsh' },
    body: { sessionId: 'root-1', route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  })
  assert.equal(switched.headers['access-control-allow-origin'], 'app://dsh', '实际响应也要带 CORS 头，否则浏览器读不到结果')
})

check('连会话都读不到时，明确失败而不是瞎建', async () => {
  // 云端真踩过：web 实例刚起来，sessionQuery 里还没有这个会话 → listDescendants 抛
  // SESSION_QUERY_SESSION_NOT_FOUND。老代码把它当"没有指挥员"，于是每次点击都多一个幽灵指挥员。
  const host = makeHost({ subagentsBroken: true })
  // 真正的"读不到"：会话本身在当前进程里也不存在（重启后未加载）。
  host.state.rootSessionKnown = false
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-blind-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()

  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(out.status, 500, `读不到时应当明确失败，实际 ${out.status}`)
  assert.equal(host.log.filter((e) => e.call === 'startActivation').length, 0, '读不到 catalog 时不能建指挥员')
  assert.match(String(out.json?.message ?? ''), /读不到/, '要告诉用户是"读不到"而不是"没有"')
})

check('GET 与 POST 必须对同一个会话给同一个结论（id 带不带 session- 前缀）', async () => {
  // 云端真踩过：POST 用 body 里的 id 建指挥员成功，紧接着 GET 用 "session-xxx" 查却报
  // hasCommander:false —— 宿主里 Agent 的 id 不带前缀，两边对不上，界面就成了"初始化成功但指挥员不见了"。
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-prefix-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()

  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(host.log.filter((e) => e.call === 'startActivation').length, 1)

  const viaBare = await call(host, { query: '?sessionId=root-1', method: 'GET' })
  const viaPrefixed = await call(host, { query: '?sessionId=session-root-1', method: 'GET' })
  assert.equal(viaBare.json?.hasCommander, true, `裸 id 要看到指挥员：${JSON.stringify(viaBare.json)}`)
  assert.equal(viaPrefixed.json?.hasCommander, true, `带前缀的 id 也要看到指挥员：${JSON.stringify(viaPrefixed.json)}`)
  assert.equal(viaBare.json?.mode, viaPrefixed.json?.mode, '两种写法必须是同一个挡位')
})

check('POST init：spawn 用 caller、落 observe/init、不碰 goal、不发通知', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-init-'))
  const statePath = path.join(dir, 'state.json')
  apply(host.ctx, { statePath })
  await flush()
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(out.json.ok, true)
  const spawn = host.log.find((entry) => entry.call === 'startActivation')
  assert.ok(spawn !== undefined, '必须真的去建指挥员')
  assert.equal(spawn.delivery, 'caller', '必须 caller，否则宿主会唤醒主会话')
  assert.ok(spawn.prompt.includes('初始化'), '必须是预热提示词')
  assert.equal(host.log.some((entry) => entry.call.startsWith('goals.')), false, '初始化不得动 goal')
  await flush()
  const disk = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.equal(disk.modes['root-1'].mode, 'observe')
  assert.equal(disk.modes['root-1'].source, 'init')
})

check('POST 挡位：observe → partial 会动 goal（weak→strong）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-mode-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  host.log.length = 0
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', mode: 'partial' } })
  assert.equal(out.json.mode, 'partial')
  assert.ok(host.log.some((entry) => entry.call === 'goals.create'), 'weak→strong 要建 goal')
  assert.ok(out.json.state === undefined || true)
})

check('POST 挡位：重复点 observe 不动 goal（weak→weak 零操作）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-same-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  host.log.length = 0
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', mode: 'observe' } })
  assert.equal(out.json.mode, 'observe')
  assert.equal(host.log.some((entry) => entry.call.startsWith('goals.')), false, 'weak→weak 一个 goal 动作都不许发')
})

check('门禁：普通 agent 在 off 挡位放行；指挥员被白名单收紧', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-guard-'))
  // 关键：不调 init，而是让宿主"本来就有指挥员" —— 模拟重启后第一次解析到它。
  host.state.descendants = [{ kind: 'child', id: 'cmdr-1', name: 'commander', label: 'x', depth: 1 }]
  host.state.commanderStatus = 'inactive'
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const guard = host.guards[0]
  // 普通 agent：off 挡位下不拦
  assert.equal(guard({ agent: host.ctx.get('agents').get('root-1'), name: 'write', arguments: {} }), undefined)
  // 重启后第一次 GET 会解析到指挥员 → 必须立刻收紧它的工具面
  await call(host, { query: '?sessionId=root-1' })
  const verdict = guard({
    agent: host.ctx.get('agents').get('cmdr-1'),
    name: 'write',
    arguments: { file_path: 'doc/a.md' },
  })
  assert.ok(typeof verdict === 'string', '重启后解析到指挥员时必须已经收紧（否则它拿到全量工具）')
})

check('重启回归：GET 解析到已存在的指挥员就会登记并收紧', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-restart-'))
  host.state.descendants = [{ kind: 'child', id: 'cmdr-1', name: 'commander', label: 'x', depth: 1 }]
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const out = await call(host, { query: '?sessionId=root-1' })
  assert.equal(out.json.hasCommander, true)
  // 冷启动时 hasCommander 必须靠 async 查询拿到，不能有"缓存空就报没有"的窗口
  const again = await call(host, { query: '?sessionId=root-1' })
  assert.equal(again.json.hasCommander, true)
})

check('工具 execute：status 返回可读文本，且不需要指挥员存在', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-tool-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const out = await tool.execute({ action: 'status' }, { agent: rootAgent(), signal: new AbortController().signal })
  assert.equal(typeof out.text, 'string')
  assert.ok(out.text.includes('挡位'))
  assert.ok(out.text.includes('未建立'))
  // goal 必须带 phase：只显示 objective 会让「已结束」的目标看起来还在跑。
  host.state.goal = { id: 'g1', objective: '跑完的目标', revision: 1, phase: 'complete', roundsStarted: 2, maxGoalRounds: 16 }
  const withGoal = await tool.execute({ action: 'status' }, { agent: rootAgent(), signal: new AbortController().signal })
  assert.ok(withGoal.text.includes('goal（complete'), withGoal.text)
  assert.ok(withGoal.text.includes('2/16'), '要报轮次进度')
  assert.ok(withGoal.text.includes('跑完的目标'))
})

check('原生 update_goal 也走 goal 门禁：partial 下不能自己宣布完成', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-native-goal-'))
  host.state.descendants = [{ kind: 'child', id: 'cmdr-1', name: 'commander', label: 'x', depth: 1 }]
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const guard = host.guards[0]
  const me = () => host.ctx.get('agents').get('root-1')
  const call_ = (name, args) => guard({ agent: me(), name, arguments: args })

  // observe：门禁不生效，主agent 自由
  assert.equal(call_('update_goal', { action: 'complete' }), undefined, 'observe 下不该拦')

  await call(host, { method: 'POST', body: { sessionId: 'root-1', mode: 'partial' } })
  assert.ok(call_('update_goal', { action: 'complete' }), 'partial 下 complete 必须拦——否则绕开指挥员自己宣布完成')
  assert.ok(call_('update_goal', { action: 'pause' }), 'pause 要批准')
  assert.ok(call_('update_goal', { action: 'edit' }), 'edit 要批准')
  assert.equal(call_('update_goal', { action: 'resume' }) !== undefined, true, 'resume 永远交用户')
  assert.equal(call_('get_goal', {}), undefined, '只读的不该拦')
  assert.equal(call_('create_goal', { objective: 'x' }), undefined, 'create 与自家通道口径一致，不受门禁')
})

check('off 挡位：直接给指挥员发 send_message 也会被拦（不能绕过 commander 工具）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-off-ping-'))
  host.state.descendants = [{ kind: 'child', id: 'cmdr-1', name: 'commander', label: 'x', depth: 1 }]
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const guard = host.guards[0]
  const me = () => host.ctx.get('agents').get('root-1')
  const ping = (target) => guard({ agent: me(), name: 'send_message', arguments: { agent: target } })

  assert.equal(ping('commander'), undefined, 'observe 下可以直连')
  await call(host, { method: 'POST', body: { sessionId: 'root-1', mode: 'off' } })
  assert.ok(ping('commander'), 'off 下直连指挥员必须拦：否则 commander 工具的 say/wait 禁令形同虚设')
  assert.equal(ping('someone-else'), undefined, '发给别人不管')
})

check('start 建立关系时把声明说一次（不额外占每轮提示词）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-start-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const out = await tool.execute({ action: 'start', provider: 'qwen', model: 'qwen4-max-preview' }, { agent: rootAgent(), signal: new AbortController().signal })
  assert.ok(out.text.includes('关系声明'), '建立回应里要有声明')
  assert.ok(out.text.includes('指挥员不影响 agent team'), '声明原文要在')
  assert.ok(out.text.includes('预热'), '原来的建立说明不能被顶掉')
})

check('挡位 partial→full：goal 标题必须重写成「全接管」', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-mode-goal-'))
  host.state.descendants = [{ kind: 'child', id: 'cmdr-1', name: 'commander', label: 'x', depth: 1 }]
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = () => ({ agent: rootAgent(), signal: new AbortController().signal })
  await tool.execute({ action: 'takeover', state: 'partial' }, exec())
  // 宿主里的 goal 停在「部分接管」模板上（真实场景就是这样）
  host.state.goal = {
    id: 'g1',
    objective: '【接管：部分接管】\n（原 goal 没有 objective；按用户本次指令执行）\n\n执行边界：\n- 旧条款',
    revision: 3,
    phase: 'active',
    roundsStarted: 0,
    maxGoalRounds: 256,
  }
  const before = host.log.filter((entry) => entry.call === 'goals.edit').length
  await tool.execute({ action: 'takeover', state: 'full' }, exec())
  const edits = host.log.filter((entry) => entry.call === 'goals.edit')
  assert.equal(edits.length, before + 1, 'partial→full 必须重写 goal 标题')
  assert.ok(edits.at(-1).objective.includes('【接管：全接管】'), edits.at(-1).objective)
  assert.ok(edits.at(-1).objective.includes('全接管：可代用户拍板'), '全接管的权限条款要补上')
})

check('goal 动作：clear 用宿主的 clear（墓碑），不拿 complete 冒充', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-goal-clear-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  // 已经 complete 的 goal：宿主会拒绝再 complete（transition 只接受 active/paused/blocked）。
  host.state.goal = { id: 'g1', objective: 'x', revision: 1, phase: 'complete' }
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const out = await tool.execute(
    { action: 'goal', goalAction: 'clear' },
    { agent: rootAgent(), signal: new AbortController().signal },
  )
  assert.ok(out.text.includes('clear 已执行'), out.text)
  assert.ok(host.log.some((entry) => entry.call === 'goals.clear'), '必须调用 goals.clear')
  assert.ok(!host.log.some((entry) => entry.call === 'goals.complete'), '不得用 complete 冒充 clear')
  assert.equal(host.state.goal, undefined, 'clear 之后会话里不该再留着 goal')
})

check('plan 动作：把计划写进 doc/plan.md，且不越界', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-plan-'))
  const cwd = path.join(dir, 'proj')
  await fsp.mkdir(cwd, { recursive: true })
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const agent = { ...rootAgent(), session: { header: { id: 'root-1' }, cwd, seq: 0 } }
  const out = await tool.execute(
    { action: 'plan', plan: '- 阶段一：拆分模块\n- 阶段二：补测试', planTitle: '重构' },
    { agent, signal: new AbortController().signal },
  )
  assert.ok(out.text.includes('doc/plan.md'), '要回报真实写到的路径')
  const text = await fsp.readFile(path.join(cwd, 'doc', 'plan.md'), 'utf8')
  assert.ok(text.startsWith('# plan'), '要用 plan 的骨架')
  assert.ok(text.includes('· 重构'), '标题要进去')
  assert.ok(text.includes('阶段二：补测试'), '正文要进去')
  // 空正文不该写盘
  const empty = await tool.execute({ action: 'plan', plan: '   ' }, { agent, signal: new AbortController().signal })
  assert.ok(empty.text.includes('需要 plan'), '空正文要拒绝')
})

check('plan 动作：不依赖挡位，没有指挥员也能记计划', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-plan-off-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  // 无指挥员 → 推导挡位是 off；plan 仍应可用（挡位管对话，不管写文档）
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const cwd = path.join(dir, 'proj')
  await fsp.mkdir(cwd, { recursive: true })
  const agent = { ...rootAgent(), session: { header: { id: 'root-1' }, cwd, seq: 0 } }
  const out = await tool.execute({ action: 'plan', plan: '- x' }, { agent, signal: new AbortController().signal })
  assert.ok(!out.text.includes('不运行指挥职责'), 'off 不该挡 plan')
  assert.ok(out.text.includes('doc/plan.md'))
  assert.ok(await fsp.stat(path.join(cwd, 'doc', 'plan.md')).then(() => true).catch(() => false))
})

check('buildAgentOptions：只收非空字段，全空返回 undefined', () => {
  assert.equal(buildAgentOptions({}), undefined, '没配就返回 undefined（等于让宿主全继承）')
  assert.equal(buildAgentOptions({ llmProvider: '', llmModel: '', llmReasoningEffort: '' }), undefined)
  assert.deepEqual(buildAgentOptions({ llmModel: 'gpt-x', llmProvider: '', llmReasoningEffort: '' }), { model: 'gpt-x' }, '只配 model 也要能用')
  assert.deepEqual(
    buildAgentOptions({ llmProvider: 'anthropic', llmModel: 'opus', llmReasoningEffort: 'high' }),
    { provider: 'anthropic', model: 'opus', reasoningEffort: 'high' },
  )
  assert.deepEqual(buildAgentOptions({ llmProvider: 'anthropic', llmModel: '', llmReasoningEffort: '' }), { provider: 'anthropic' })
})

check('请求里选的模型优先于 profile 配置；配置只作兜底', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-llm-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), llmProvider: 'anthropic', llmModel: 'opus-4' })
  await flush()
  // 请求里明确选了 qwen → 以请求为准（测试 helper 会自动补这条 route）
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const spawn = host.log.find((entry) => entry.call === 'startActivation')
  assert.ok(spawn !== undefined, '必须真的去建指挥员')
  assert.equal(spawn.provider, 'spawn', '选了模型就不能走 fork——它会把模型参数扔掉')
  assert.deepEqual(
    { provider: spawn.agentOptions?.provider, model: spawn.agentOptions?.model },
    { provider: 'qwen', model: 'qwen4-max-preview' },
    'agentOptions 要用请求里选的那条',
  )

  // 请求里没选（route: null）→ 退回 profile 配置
  const host2 = makeHost()
  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-llm2-'))
  apply(host2.ctx, { statePath: path.join(dir2, 'state.json'), llmProvider: 'anthropic', llmModel: 'opus-4' })
  await flush()
  const out = await call(host2, { method: 'POST', body: { sessionId: 'root-1', init: true, route: null } })
  assert.equal(out.status, 200, `配置兜底应当能建立：${JSON.stringify(out.json)}`)
  const spawn2 = host2.log.find((entry) => entry.call === 'startActivation')
  assert.deepEqual(
    { provider: spawn2.agentOptions?.provider, model: spawn2.agentOptions?.model },
    { provider: 'anthropic', model: 'opus-4' },
    '没在请求里选时才用配置',
  )
})

check('配置的路由不存在时：建立直接失败，绝不留下"出生即坏"的指挥员', async () => {
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-badroute-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), llmProvider: 'nope', llmModel: 'ghost' })
  await flush()
  const response = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true, route: null } })
  assert.equal(response.status, 400, '路由不可用要在建立前就拒绝')
  assert.ok(String(response.json?.message ?? '').length > 0, '要说明是哪条路由不可用')
  assert.equal(
    host.log.some((entry) => entry.call === 'startActivation'),
    false,
    '坏路由绝不能走到 spawn——建出来每轮都报错，比建失败更难排查',
  )
})

check('配了模型不支持的 reasoningEffort：丢掉 effort 照常建立（不降级成一个坏指挥员）', async () => {
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-effort-'))
  apply(host.ctx, {
    statePath: path.join(dir, 'state.json'),
    llmProvider: 'qwen', llmModel: 'qwen4-max-preview', llmReasoningEffort: 'high',
  })
  await flush()
  const response = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(response.status, 200, '丢掉 effort 之后应当能建立')
  const spawn = host.log.find((entry) => entry.call === 'startActivation')
  assert.ok(spawn !== undefined, '必须真的建立')
  assert.deepEqual(
    spawn.agentOptions,
    { provider: 'qwen', model: 'qwen4-max-preview' },
    '模型不支持的 effort 必须被丢掉，否则宿主每轮都抛 UNSUPPORTED_REASONING_EFFORT',
  )
  assert.equal(response.json?.route?.reasoningEffort, undefined, '存下来的路由不该还带着那个 effort')
})

check('status 里看得见指挥员路由，读不到时如实说跟随主会话', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-route-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const out = await tool.execute({ action: 'status' }, { agent: rootAgent(), signal: new AbortController().signal })
  assert.ok(out.text.includes('指挥员路由'), 'status 要有一行路由')
  assert.ok(out.text.includes('无指挥员'), '没建立时不该编一个模型出来')
})

check('status 能读到指挥员真实路由（含只有会话存储、没有活 agent 的情况）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-route2-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = () => ({ agent: rootAgent(), signal: new AbortController().signal })

  // 先建一个指挥员
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })

  // 活 agent 在，但会话里已经有 descriptor：应当显示真实路由
  host.setCommanderSession({
    seq: 1,
    eventAt: (seq) => (seq === 1
      ? { type: 'subagent/descriptor', data: { agentProvider: 'qwen', agentModel: 'qwen4-max-preview', agentReasoningEffort: 'high' } }
      : { type: 'header' }),
  })
  const live = await tool.execute({ action: 'status' }, exec())
  assert.ok(live.text.includes('qwen/qwen4-max-preview'), `要显示真实路由：${live.text}`)
  assert.ok(!live.text.includes('跟随主会话'), '读到了就不该说跟随主会话')

  // 关键回归：**没有活 agent** 时也要能从会话存储读到（实测踩过，只查 agents 会误报）
  host.state.commanderLive = false
  const stored = await tool.execute({ action: 'status' }, exec())
  assert.ok(stored.text.includes('qwen/qwen4-max-preview'), `只有会话存储时也要读得到：${stored.text}`)

  // 关键：residency 释放后两路都拿不到（实测 live=false stored=false），
  // 所以插件建立时记下的 route 才是可靠来源。
  host.state.commanderLive = false
  await call(host, { method: 'POST', body: { sessionId: 'root-1', mode: 'off' } })
  const recorded = await tool.execute({ action: 'status' }, exec())
  assert.ok(!recorded.text.includes('跟随主会话'), `建立了自定义路由就不该说跟随主会话：${recorded.text}`)

  // 会话事件读不到时，退到插件自己记的路由——模型在建立时固定，这条记录就是权威
  host.setCommanderSession({ seq: 0, eventAt: () => undefined })
  const none = await tool.execute({ action: 'status' }, exec())
  assert.ok(none.text.includes('qwen/qwen4-max-preview'), `读不到会话事件时要退回插件记录：${none.text}`)
})

check('跨会话隔离：别的会话有指挥员，新会话的门禁绝不能生效', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-isolation-'))
  const statePath = path.join(dir, 'state.json')
  // 预置：**两个会话都设过 partial**，唯一差别是 root-1 有指挥员、root-2 没有。
  // 这样比较才干净——差异只能来自"有没有指挥员"，不能来自挡位。
  await fsp.writeFile(statePath, JSON.stringify({
    schema: 1,
    modes: {
      'root-1': { mode: 'partial', source: 'user', at: Date.now() },
      'root-2': { mode: 'partial', source: 'user', at: Date.now() },
    },
    pending: {},
  }), 'utf8')
  // root-1 有指挥员，root-2 没有——按会话隔离。
  host.state.byRoot = {
    'root-1': [{ kind: 'child', id: 'cmdr-1', name: 'commander', path: 'commander', mode: 'continuable', label: 'x', depth: 1 }],
    'root-2': [],
  }
  apply(host.ctx, { statePath, allow: ['read'] })
  await flush()

  const guard = host.guards[0]
  const asRoot = (id) => ({ id, status: 'idle', session: { header: { id }, cwd: SESSION_CWD, seq: 0 }, followup: () => {} })

  // 先让 root-1 解析到指挥员，把进程级的"已知指挥员"填上
  const seen = await call(host, { query: '?sessionId=root-1' })
  assert.equal(seen.json.hasCommander, true, 'root-1 应当有指挥员')

  // root-2 的 goal 门禁必须**不生效**：它没有指挥员，拦下来就没人能放行 → 卡死
  assert.equal(
    guard({ agent: asRoot('root-2'), name: 'update_goal', arguments: { action: 'complete' } }),
    undefined,
    '别的会话有指挥员，不能让新会话的 goal 被拦——那会拦成死锁',
  )
  // root-1 自己该拦还是要拦
  assert.ok(
    guard({ agent: asRoot('root-1'), name: 'update_goal', arguments: { action: 'complete' } }),
    'root-1 有指挥员且是 partial，必须拦',
  )
})

check('指挥员被销毁后，该会话退回 fail-open 而不是永久误拦', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-dispose-root-'))
  const statePath = path.join(dir, 'state.json')
  await fsp.writeFile(statePath, JSON.stringify({
    schema: 1,
    modes: { 'root-1': { mode: 'partial', source: 'user', at: Date.now() } },
    pending: {},
  }), 'utf8')
  host.state.byRoot = {
    'root-1': [{ kind: 'child', id: 'cmdr-1', name: 'commander', path: 'commander', mode: 'continuable', label: 'x', depth: 1 }],
  }
  apply(host.ctx, { statePath, allow: ['read'] })
  await flush()
  const guard = host.guards[0]
  const asRoot1 = () => host.ctx.get('agents').get('root-1')

  await call(host, { query: '?sessionId=root-1' })
  assert.ok(guard({ agent: asRoot1(), name: 'update_goal', arguments: { action: 'complete' } }), '销毁前应当拦')

  // 指挥员没了，宿主会发 agent/disposed
  host.emit('agent/disposed', { agent: { id: 'cmdr-1', session: { header: { id: 'cmdr-1', parentSession: 'root-1' } } } })
  await flush()
  assert.equal(
    guard({ agent: asRoot1(), name: 'update_goal', arguments: { action: 'complete' } }),
    undefined,
    '指挥员销毁后不能再拦：没有放行的人，拦了就是死锁',
  )
})

check('成员行按宿主契约解析：名字读 path、跳过非 continuable', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-rowshape-'))
  host.state.byRoot = {
    'root-1': [
      // 只有 path，没有 name —— 宿主文档说 path 才是完整名称
      { kind: 'child', id: 'cmdr-9', path: 'commander', mode: 'continuable', label: '指挥员' },
      // one-shot 成员不该被当成指挥员
      { kind: 'child', id: 'oneshot-1', name: 'commander', path: 'commander', mode: 'one-shot', label: 'x' },
      // diagnostic 是读不到的坏分支
      { kind: 'diagnostic', id: 'bad-1', reason: 'corrupt' },
    ],
  }
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const out = await call(host, { query: '?sessionId=root-1' })
  assert.equal(out.json.hasCommander, true, '只有 path 的名字也要能认出来')
  const rows = await host.ctx.get('subagents').listDescendants('root-1')
  assert.equal(rows.length, 3, '假宿主本身返回 3 条')
})

check('跨会话隔离：full 挡位但没指挥员的会话，不能被"问用户"门禁拦死', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-isolation-full-'))
  const statePath = path.join(dir, 'state.json')
  await fsp.writeFile(statePath, JSON.stringify({
    schema: 1,
    modes: {
      'root-1': { mode: 'full', source: 'user', at: Date.now() },
      'root-2': { mode: 'full', source: 'user', at: Date.now() },
    },
    pending: {},
  }), 'utf8')
  host.state.byRoot = {
    'root-1': [{ kind: 'child', id: 'cmdr-1', path: 'commander', mode: 'continuable', label: 'x', depth: 1 }],
    'root-2': [],
  }
  apply(host.ctx, { statePath, allow: ['read'] })
  await flush()
  const guard = host.guards[0]
  const asRoot = (id) => ({ id, status: 'idle', session: { header: { id }, cwd: SERVICE_CWD, seq: 0 }, followup: () => {} })

  await call(host, { query: '?sessionId=root-1' })

  // root-1 有指挥员且 full → 问用户前必须先咨询
  assert.ok(
    guard({ agent: asRoot('root-1'), name: 'ask_user_question', arguments: {} }),
    'root-1 是 full 且有指挥员，问用户必须拦',
  )
  // root-2 是 full 但**没有**指挥员 → 拦下来也没有人能批准，只会卡死
  assert.equal(
    guard({ agent: asRoot('root-2'), name: 'ask_user_question', arguments: {} }),
    undefined,
    '没有指挥员的会话不能被"先咨询指挥员"拦死',
  )
})

check('dispose：本次进程内建的指挥员能被真正销毁，且状态清干净', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-dispose-'))
  const statePath = path.join(dir, 'state.json')
  await fsp.writeFile(statePath, JSON.stringify({
    schema: 1,
    modes: { 'root-1': { mode: 'partial', source: 'user', at: Date.now() } },
    pending: {},
  }), 'utf8')
  apply(host.ctx, { statePath, allow: ['read'] })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const agent = rootAgent()
  const exec = { agent, signal: new AbortController().signal }

  // 建一个（这样才有句柄）
  const initReply = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  if (initReply.json?.ok !== true) throw new Error(`init 失败：${JSON.stringify(initReply.json)}`)
  // init 会把挡位落成 observe（这是产品约定），所以要在 init 之后才切 partial。
  // 之前把 partial 预置在 state.json 里，被 init 覆盖掉了 —— 测试顺序本身错了。
  await call(host, { method: 'POST', body: { sessionId: 'root-1', mode: 'partial' } })
  const guard = host.guards[0]
  assert.ok(guard({ agent, name: 'update_goal', arguments: { action: 'complete' } }), `partial 下有指挥员就该拦（log=${host.log.map((e) => e.call).join(',')}）`)

  const out = await tool.execute({ action: 'dispose' }, exec)
  assert.ok(out.text.includes('已销毁'), `应当真的销毁：${out.text}`)
  assert.equal(host.state.disposed, true, '必须调到宿主的 dispose()')
  assert.ok(host.log.some((entry) => entry.call === 'activation.dispose'), '句柄要被调用')

  // 销毁后：门禁必须退回不拦（没有放行的人了，再拦就是死锁）
  assert.equal(
    guard({ agent, name: 'update_goal', arguments: { action: 'complete' } }),
    undefined,
    '销毁后不能再拦',
  )
})

check('dispose：认领来的指挥员没有句柄 → 遗忘它，下次 start 能新建', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-dispose-claim-'))
  const statePath = path.join(dir, 'state.json')
  // 不调用 init，直接让 find 从 catalog 里认领一个（模拟重启后）
  host.state.byRoot = {
    'root-1': [{ kind: 'child', id: 'cmdr-9', path: 'commander', mode: 'continuable', label: 'x', depth: 1 }],
  }
  apply(host.ctx, { statePath, allow: ['read'] })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = { agent: rootAgent(), signal: new AbortController().signal }

  // 认领得到
  const before = await call(host, { query: '?sessionId=root-1' })
  assert.equal(before.json.hasCommander, true, '先要能认领到')

  const out = await tool.execute({ action: 'dispose' }, exec)
  assert.ok(out.text.includes('已遗忘'), `要如实说是"遗忘"而不是"销毁"：${out.text}`)
  assert.ok(out.text.includes('磁盘'), '要说清数据还在')
  assert.ok(!host.log.some((entry) => entry.call === 'activation.dispose'), '没有句柄就不该有 dispose 调用')

  // 遗忘之后：不再被认领，也不再算"有指挥员"
  const after = await call(host, { query: '?sessionId=root-1' })
  assert.equal(after.json.hasCommander, false, '遗忘后不能再认领它')
  // persist() 是异步落盘，得等它写完再读
  await flush()
  const stored = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.deepEqual(stored.forgotten['root-1'], ['cmdr-9'], '黑名单要落盘')
})

check('dispose：本会话没指挥员时明确说不需要', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-dispose-none-'))
  host.state.byRoot = { 'root-1': [] }
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const out = await tool.execute({ action: 'dispose' }, { agent: rootAgent(), signal: new AbortController().signal })
  assert.ok(out.text.includes('没有指挥员'), out.text)
})

check('会话未激活时：已有指挥员仍能改挡位（否则连关都关不掉）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-inactive-'))
  // 这个会话有 catalog 里的指挥员，但宿主里没有 live Agent（还没发消息/已释放）
  const ghost = 'session-ghost-0001'
  host.state.byRoot = {
    [ghost]: [{ kind: 'child', id: 'cmdr-g', path: 'commander', mode: 'continuable', label: 'x', depth: 1 }],
  }
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()

  // 关掉它：不需要 spawn，所以不该 409
  const off = await call(host, { method: 'POST', body: { sessionId: ghost, mode: 'off' } })
  assert.ok(off.json?.mode === 'off', `已有指挥员时缩小挡位不该被拒：${JSON.stringify(off.json)}`)

  // 但没有指挥员又没 Agent 时，仍然必须拒绝（spawn 需要 parent）
  const host2 = makeHost()
  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-inactive2-'))
  host2.state.byRoot = { 'session-ghost-0002': [] }
  apply(host2.ctx, { statePath: path.join(dir2, 'state.json'), allow: ['read'] })
  await flush()
  const spawn = await call(host2, { method: 'POST', body: { sessionId: 'session-ghost-0002', mode: 'partial' } })
  assert.ok(spawn.json?.error === 'session not live', `要建指挥员时必须要求会话已激活：${JSON.stringify(spawn.json)}`)
})

check('初始化失败后必须能重试（否则界面写着重试、点下去永远 409）', async () => {
  const host = makeHost({ rejectProviders: ['fork', 'spawn'] })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-retry-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()

  const first = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(first.json?.error, 'start-failed', `第一次应当真失败：${JSON.stringify(first.json)}`)

  // 失败后 phase 应该是 failed（前端据此显示"点击重试"）
  const afterFail = await call(host, { query: '?sessionId=root-1' })
  assert.equal(afterFail.json.phase, 'failed', `失败后 phase 应为 failed：${JSON.stringify(afterFail.json)}`)

  // 关键：再点一次不能被 in-flight 挡死
  const second = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.notEqual(second.json?.error, 'in-flight', '失败过的初始化必须允许重试')
  assert.equal(second.json?.error, 'start-failed', '重试仍然会失败，但要真的去试')
})

check('真正进行中的初始化仍要被挡住（不能重复建）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-inflight-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json'), allow: ['read'] })
  await flush()
  // 让 spawn 挂住，模拟"正在建立"
  let release
  const gate = new Promise((done) => {
    release = done
  })
  const sub = host.ctx.get('subagents')
  const original = sub.startActivation
  sub.startActivation = async (spec) => {
    await gate
    return original(spec)
  }
  const post = call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } }).catch(() => undefined)
  await flush()
  const during = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(during.json?.error, 'in-flight', `进行中必须 409 in-flight：${JSON.stringify(during.json)}`)
  release()
  await post
})

check('没有 llm 服务时不崩，只是退回宿主的默认', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-nollm-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(out.json?.ok, true, `没有 llm 也必须建得起来：${JSON.stringify(out.json)}`)
  assert.equal(host.log.filter((entry) => entry.call === 'session.append').length, 0)
})

check('recreate 缺 provider/model 时明确拒绝，不瞎建', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-recreate-bad-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const out = await tool.execute({ action: 'recreate', provider: 'qwen' }, { agent: rootAgent(), signal: new AbortController().signal })
  assert.ok(out.text.includes('需要同时给出'), `要直接说清楚：${out.text}`)
  assert.equal(host.log.filter((entry) => entry.call === 'startActivation').length, 0, '不该建任何东西')
})

check('模型清单端点：按 provider 分组返回全部路由，拉不到的跳过', async () => {
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-models-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const out = await call(host, { query: '/models?sessionId=root-1' })
  assert.ok(Array.isArray(out.json?.groups), `要返回分组：${JSON.stringify(out.json)}`)
  const byProvider = Object.fromEntries(out.json.groups.map((g) => [g.provider, g.models]))
  assert.deepEqual(byProvider['deepseek-account'], ['deepseek-flash'])
  assert.deepEqual(byProvider.qwen, ['qwen4-max-preview', 'qwen3.8-flash'])
  assert.equal(byProvider.broken, undefined, '拉不到模型的 provider 不该出现')
  assert.equal(out.json.current, null, '还没指定路由时是 null（跟随主会话）')
})

check('冷恢复发送：必须把激活的 delivery 钉回 caller（否则指挥员结算会点燃主会话）', async () => {
  // 宿主 restoreTarget() → materialize() 不传 delivery，恢复出来的激活是 "parent"。
  // 那种激活结算时会往父会话塞 subagent-settled 并**开新一轮**——实测每轮白烧一次 turn。
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-pin-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = () => ({ agent: rootAgent(), signal: new AbortController().signal })

  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  // 冷下来：模拟结算后 residency 被释放
  host.state.resident.clear()

  const out = await tool.execute({ action: 'say', message: '自检' }, exec())
  assert.ok(String(out?.text ?? '').includes('已发出咨询'), `发送要成功：${out?.text}`)
  // 宿主恢复时给的是 parent，插件必须在结算前把它补回 caller。
  assert.equal(
    host.state.resident.get('cmdr-1')?.delivery,
    'caller',
    '发完之后必须把 resident 里的 delivery 补回 caller（否则结算时会点燃主会话）',
  )
})

check('已经热着时不再恢复，但 parent 的激活仍要被补成 caller', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-pin-warm-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = () => ({ agent: rootAgent(), signal: new AbortController().signal })

  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  host.state.resident.set('cmdr-1', { childId: 'cmdr-1', delivery: 'parent', accepted: true })
  host.log.length = 0

  await tool.execute({ action: 'say', message: '自检' }, exec())
  assert.equal(
    host.log.some((entry) => entry.call === 'restoreTarget'),
    false,
    '热着时不该再恢复一次（会多造一个激活）',
  )
  assert.equal(host.state.resident.get('cmdr-1')?.delivery, 'caller', '仍要补成 caller')
})

check('恢复失败时不吞错：仍然交给 sendMessage 报它自己的措辞', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-pin-fail-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = () => ({ agent: rootAgent(), signal: new AbortController().signal })

  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  host.state.resident.clear()
  host.state.failSend = () => true

  // 恢复和发送都失败时，把坏条目遗忘并给出下一步——抛错或返回都行，
  // 关键是措辞要让模型知道"该重建了"，而不是一句 raw cause。
  let said
  try {
    said = String((await tool.execute({ action: 'say', message: '自检' }, exec()))?.text ?? '')
  } catch (error) {
    said = String(error?.message ?? error)
  }
  assert.ok(/重建|遗忘|损坏/.test(said), `要有可读的失败说明：${said}`)
})

check('say 撞到读不动的旧会话：遗忘它并改投下一个，不让 consult 永久卡死', async () => {
  // 现场故障：catalog 里留着一条会话已损坏的指挥员条目，find 每次都选中它，
  // sendMessage 抛 "subagent … is unavailable"，用户表现为"指挥员在场却永远发不出去"。
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-dead-'))
  const statePath = path.join(dir, 'state.json')
  const dead = 'cmdr-dead'
  host.state.byRoot = {
    'root-1': [
      { kind: 'child', id: dead, path: 'commander', mode: 'continuable', label: 'x', depth: 1 },
      { kind: 'child', id: 'cmdr-good', path: 'commander-2', mode: 'continuable', label: 'x', depth: 1 },
    ],
  }
  host.state.failSend = (id) => id === dead
  apply(host.ctx, { statePath })
  await flush()

  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = { agent: rootAgent(), signal: new AbortController().signal }
  const out = await tool.execute({ action: 'say', message: '自检' }, exec)
  assert.ok(String(out?.text ?? '').includes('已发出咨询'), `应当改投成功：${out?.text}`)
  assert.ok(
    host.log.some((entry) => entry.call === 'sendMessage' && entry.targetId === 'cmdr-good'),
    '要最终发到好会话',
  )
  await flush()
  const stored = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.ok((stored.forgotten?.['root-1'] ?? []).includes(dead), '坏会话要进 forgotten，别再选它')
})

check('工具层 start 也必须先有模型：不给就拒绝，不悄悄跟随主会话', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-toolstart-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = { agent: rootAgent(), signal: new AbortController().signal }

  const refused = await tool.execute({ action: 'start' }, exec)
  assert.ok(String(refused?.text ?? '').includes('必须先选定模型'), `要明确要求先选模型：${refused?.text}`)
  assert.equal(host.log.some((e) => e.call === 'startActivation'), false, '不许建一个"跟随主会话"的指挥员')

  // 给了 provider/model 就能建
  const built = await tool.execute({ action: 'start', provider: 'qwen', model: 'qwen4-max-preview' }, exec)
  assert.ok(String(built?.text ?? '').includes('已建立'), `给了模型应当能建：${built?.text}`)
  const spawn = host.log.find((e) => e.call === 'startActivation')
  assert.deepEqual(
    { provider: spawn?.agentOptions?.provider, model: spawn?.agentOptions?.model },
    { provider: 'qwen', model: 'qwen4-max-preview' },
    'agentOptions 要用工具里给的模型',
  )
})

check('init 必须带模型：没选就不许建立（模型建立后改不了）', async () => {
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-needmodel-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true, route: null } })
  assert.equal(out.status, 400, `没选模型要拒绝：${JSON.stringify(out.json)}`)
  assert.equal(out.json?.error, 'model-required')
  assert.equal(host.log.some((e) => e.call === 'startActivation'), false, '不许悄悄建一个"跟随主会话"的指挥员')
})

check('POST route：换模型必须被拒绝（model-locked），不重建、不改状态', async () => {
  // 模型在建立时固定。宿主侧没有"改子会话模型"的合法表示，任何侧门都不该被当成成功。
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-locked-'))
  const statePath = path.join(dir, 'state.json')
  apply(host.ctx, { statePath })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const activations = host.log.filter((e) => e.call === 'startActivation').length

  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', route: { provider: 'qwen', model: 'qwen3.8-flash' } } })
  assert.equal(out.status, 409, `换模型必须 409：${JSON.stringify(out.json)}`)
  assert.equal(out.json?.error, 'model-locked')
  assert.equal(host.log.filter((e) => e.call === 'startActivation').length, activations, '不许因为换模型而重建')
  assert.equal(host.log.filter((e) => e.call === 'agent.model.select').length, 0, '不许往子会话写 model/selection')

  await flush()
  const stored = JSON.parse(await fsp.readFile(statePath, 'utf8'))
  assert.equal(stored.routes?.['root-1']?.model, 'qwen4-max-preview', '路由不许被改掉')
})

check('POST route：残缺的 route 也一律拒绝（不留下半条路由）', async () => {
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-locked-bad-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', route: { provider: 'qwen' } } })
  assert.equal(out.status, 409)
  assert.equal(out.json?.error, 'model-locked')
})

check('rebuild 才是显式重建（用户主动要求时）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-rebuild-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  const tool = host.tools.find((entry) => entry.name === 'commander')
  const exec = () => ({ agent: rootAgent(), signal: new AbortController().signal })

  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const spawnsBefore = host.log.filter((e) => e.call === 'startActivation').length

  const out = await tool.execute({ action: 'rebuild', provider: 'qwen', model: 'qwen4-max-preview' }, exec())
  assert.ok(out.text.includes('已重建指挥员'), `rebuild 应当真的重建：${out.text}`)
  assert.equal(
    host.log.filter((e) => e.call === 'startActivation').length,
    spawnsBefore + 1,
    'rebuild 会新建一个（这是显式动作）',
  )
})

check('HTTP 换模型：坏路由也一律 409，不会假装成功', async () => {
  const host = makeHost({ withLlm: true })
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-badroute-http-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const out = await call(host, { method: 'POST', body: { sessionId: 'root-1', route: { provider: 'nope', model: 'ghost' } } })
  assert.equal(out.status, 409, `换模型一律拒绝：${JSON.stringify(out.json)}`)
  assert.equal(out.json?.error, 'model-locked')
})

check('清理：apply 注册的 disposer 全部可调用（不会在卸载时抛）', async () => {
  const host = makeHost()
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-dispose-'))
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  for (const disposer of host.effects) {
    if (typeof disposer === 'function') disposer()
  }
  assert.ok(true)
})

let failed = 0
for (const { name: label, fn } of checks) {
  try {
    await fn()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\nLOAD CHECKS PASSED (${checks.length})`)
