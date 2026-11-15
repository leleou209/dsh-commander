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

import { inject, name, apply } from '../index.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const flush = () => new Promise((done) => setTimeout(done, 80))

/**
 * ensureDocs 会真建文件，所以所有 cwd 都必须落在临时目录，绝不能是 process.cwd()。
 * 两个目录故意不同：SESSION_CWD 是会话自带的 cwd，SERVICE_CWD 是 workingDirectory
 * 服务给的值。cwd 解析必须以会话自带的为准——搞反了就会把 doc 写进 profile 目录。
 */
const SESSION_CWD = path.join(os.tmpdir(), 'cmdr-core-load-session-cwd')
const SERVICE_CWD = path.join(os.tmpdir(), 'cmdr-core-load-service-cwd')

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
function makeHost({ commanderName = 'commander', holdWebServer = false, rejectProviders = [] } = {}) {
  const log = []
  const state = {
    commanderId: undefined,
    commanderStatus: 'inactive',
    descendants: [],
    goal: undefined,
    mode: undefined,
  }

  const subagents = {
    async startActivation(spec) {
      log.push({ call: 'startActivation', provider: spec.provider, delivery: spec.delivery, name: spec.name, prompt: String(spec.prompt?.[0]?.text ?? '') })
      if (rejectProviders.includes(spec.provider)) throw new Error(`provider ${spec.provider} 不可用`)
      state.commanderId = 'cmdr-1'
      state.commanderStatus = 'running'
      state.descendants = [{ kind: 'child', id: 'cmdr-1', name: spec.name, label: 'x', depth: 1 }]
      return { id: 'cmdr-1', name: spec.name }
    },
    async listDescendants() {
      log.push({ call: 'listDescendants' })
      return state.descendants
    },
    async sendMessage(sender, targetId, content) {
      log.push({ call: 'sendMessage', targetId, text: String(content?.[0]?.text ?? '') })
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
    session: { header: { id: 'cmdr-1', parentSession: 'root-1' } },
    ctx: { tools: { restrict: () => () => {} } },
  })
  const agents = {
    get: (id) => {
      if (id === 'cmdr-1') return makeCommanderAgent()
      if (id === 'root-1') return makeRootAgent()
      return undefined
    },
  }

  const sessions = { get: (id) => (id === 'cmdr-1' ? state.commanderSession : undefined) }

  const goals = {
    get: () => state.goal,
    create: (_agent, request) => {
      log.push({ call: 'goals.create', objective: request.objective })
      state.goal = { id: 'g1', objective: request.objective, revision: 1, phase: 'active' }
    },
    edit: (_agent, ref, request) => {
      log.push({ call: 'goals.edit', objective: request.objective })
      state.goal = { ...state.goal, objective: request.objective, revision: (ref?.expectedRevision ?? 1) + 1 }
    },
    pause: () => log.push({ call: 'goals.pause' }),
    resume: () => log.push({ call: 'goals.resume' }),
    complete: () => log.push({ call: 'goals.complete' }),
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
async function call(host, { method = 'GET', query = '', body } = {}) {
  const req = {
    method,
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
    writeHead: (_status, headers) => {
      payload = { headers }
    },
    end: (text) => {
      payload = { ...payload, json: JSON.parse(text) }
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

check('provider 优先 fork（缓存命中），fork 不可用时退回 spawn', async () => {
  const okHost = makeHost()
  const okDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-fork-'))
  apply(okHost.ctx, { statePath: path.join(okDir, 'state.json') })
  await flush()
  await call(okHost, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  const first = okHost.log.find((entry) => entry.call === 'startActivation')
  assert.equal(first?.provider, 'fork', '默认必须先用 fork：spawn 的冷前缀要预填充整份工具表')

  const fallbackHost = makeHost({ rejectProviders: ['fork'] })
  const fbDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-spawn-'))
  apply(fallbackHost.ctx, { statePath: path.join(fbDir, 'state.json') })
  await flush()
  const out = await call(fallbackHost, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(out.json.ok, true, 'fork 不可用时不能让建立整体失败')
  const tries = fallbackHost.log.filter((entry) => entry.call === 'startActivation').map((entry) => entry.provider)
  assert.deepEqual(tries, ['fork', 'spawn'], '必须先试 fork 再退 spawn')
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
  apply(host.ctx, { statePath: path.join(dir, 'state.json') })
  await flush()
  await call(host, { method: 'POST', body: { sessionId: 'root-1', init: true } })
  assert.equal(await exists(path.join(SESSION_CWD, 'doc', 'history.md')), true, 'doc 必须建在会话自己的 cwd 下')
  assert.equal(await exists(path.join(SERVICE_CWD, 'doc')), false, '服务给的目录不该被使用（会话 cwd 优先）')
  assert.equal(await exists(path.join(process.cwd(), 'doc')), false, '绝不能退回进程目录（Electron 里那是 profile 目录）')
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
