/**
 * dsh-commander — 指挥员核心（Host 半）。
 *
 * 只做四件事：
 *   1. 建立并绑定一个常驻可续接的指挥员子agent（delivery:'caller'，不触发宿主完成推送）；
 *   2. 让它预热（读 doc 四件套）然后待命 —— 不投递、不建 goal、不自动开工；
 *   3. 按接管挡位管住 goal 与「问用户」，并收紧指挥员自己的工具面；
 *   4. 全接管时自动交接：本轮结束 → 汇报 → 等指令 → 唤醒新一轮。
 *
 * 相对 dsh-commander 的结构性简化：
 *   - 成员**不缓存**（async 按需查）→ 没有冷缓存，也就没有「重启后不认指挥员」那类 bug；
 *   - 挡位一个缓存两种访问器（async 为主，同步只给 tools.guard）→ 没有 store 反向持有 Map；
 *   - 相位由事实推导（在飞/失败/有指挥员）→ 没有第三套状态机；
 *   - 不含 doctor/checks/coverage/probe/code-state/manual/i18n/transcript-window/会话修复。
 *
 * @module @local/dsh-commander
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStore } from './lib/store.js'
import { createDriver } from './lib/driver.js'
import { createPreheatReader } from './lib/preheat.js'
import { createGoalSync } from './lib/goal-link.js'
import { buildCommanderPrompt } from './lib/prompt.js'
import { ensureDocs } from './lib/docs.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'
import { sendConsult, waitReply } from './lib/consult.js'
import { DEFAULT_MODE, LABELS, resolveMode, shouldSyncGoal } from './lib/modes.js'
import { askUserDenial, ensureAbortSignal, goalGate, invalidatesApproval, readOnlyShellViolation, toolSurfaceDenial, writeScopeViolation } from './lib/gate.js'
import { findCommander, listMembers, restrictCommander, rootIdOf as rootIdOfHost, sendToCommander as sendHost, spawnCommander, subtreeBusy } from './lib/commander.js'

export const name = 'dsh-commander'
export const inject = ['tools', 'subagents']

const DEFAULTS = {
  toolName: 'commander',
  recordToolName: 'commander_record',
  commanderName: 'commander',
  routePath: '/commander/takeover',
  docDir: 'doc',
  provider: 'fork',
  statePath: join(homedir(), '.dsh', 'commander', 'state.json'),
  enforceApproval: true,
  waitMs: 20 * 60 * 1000,
  pollMs: 30 * 1000,
  initTimeoutMs: 90 * 1000,
  shellTools: ['pwsh', 'bash', 'shell'],
  writeScopes: ['doc'],
  allow: ['read', 'glob', 'grep', 'pwsh', 'bash', 'shell', 'web_search', 'web_fetch', 'commander', 'commander_record', 'list_agents', 'send_message', 'todo_write'],
}

const normalizeConfig = (raw = {}) => {
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') config[key] = raw[key]
  }
  return config
}

const toPosix = (value) => String(value).split(sep).join('/')

async function resolveCwd(ctx, agent, signal) {
  // 顺序有讲究：会话自带的 cwd 最可靠。宿主的 workingDirectory.get 要**session**、
  // 且是同步返回值；传成 agent 或当 async 用，就只能一路退到 process.cwd()——
  // 而 Electron 进程的 cwd 是 profile 目录，doc 会被建到那里，指挥员预热也就读空。
  const own = agent?.session?.cwd
  if (typeof own === 'string' && own.length > 0) return own
  const service = ctx.get('workingDirectory')
  if (service !== undefined) {
    try {
      const value = service.get?.(agent?.session)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 退到 ensure
    }
    try {
      const value = await service.ensure?.(agent, ensureAbortSignal(signal))
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 退到进程目录
    }
  }
  const fallback = process.cwd()
  ctx.logger?.warn?.(`dsh-commander: 会话 cwd 解析不到，退回进程目录 ${fallback}`)
  return fallback
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const store = createStore({ path: resolve(String(config.statePath)), logger: ctx.logger })

  // 本轮语义：刻意只放内存，重启即清（放行/批准/已咨询都不该跨进程复活）。
  const inFlight = new Map()
  const commanderIds = new Set()
  const approvals = new Map()
  const released = new Set()
  const consulted = new Set()
  const restrictions = new Map()

  const rootIdOf = (agent) => rootIdOfHost(ctx, agent)
  /** 查到指挥员就登记它的 id 并收紧工具面：重启后第一次解析到时也必须收紧。 */
  const remember = (member) => {
    if (member === undefined || typeof member.id !== 'string') return member
    commanderIds.add(member.id)
    const live = ctx.get('agents')?.get?.(member.id)
    if (live !== undefined) applyRestriction(live)
    return member
  }
  const find = async (rootId, signal) => remember(await findCommander(ctx, rootId, config.commanderName, signal))
  const hasCommander = async (rootId) => (await find(rootId)) !== undefined
  const modeOf = async (agent) => {
    const rootId = rootIdOf(agent)
    return resolveMode({ hasCommander: await hasCommander(rootId), override: store.mode(rootId) }).mode
  }
  const goalObjective = (agent) => {
    try {
      return ctx.get('goals')?.get?.(agent)?.objective
    } catch {
      return undefined
    }
  }
  const goalPhase = (agent) => {
    try {
      return ctx.get('goals')?.get?.(agent)?.phase
    } catch {
      return undefined
    }
  }

  const app = {
    ctx, config, store, inFlight, commanderIds, approvals, released, consulted,
    rootIdOf, findCommander: find, hasCommander, modeOf, goalObjective,
    listMembers: (rootId, signal) => listMembers(ctx, rootId, signal),
    sendRaw: (agent, targetId, text, signal) => sendHost(ctx, agent, targetId, text, signal),
    sendToCommander: (agent, _targetId, text, signal) => sendConsult(app, agent, text, signal),
    resolveCwd: (agent, signal) => resolveCwd(ctx, agent, signal),
    preheat: createPreheatReader({ ctx, findCommander: find, rootIdOf, name: config.commanderName }),
  }

  const syncGoal = createGoalSync({ ctx, rootIdOf })

  /**
   * provider 顺序：配置的优先，失败退 spawn。
   *
   * 为什么默认 fork：spawn 的子会话是**冷前缀**——实测首次请求要预填充
   * 269,237 token（整份工具表 + 系统提示，cacheRead=0），冷启动 57.4 秒才出首字；
   * fork 复用父会话逐字节相同的前缀，命中 KV cache。两者都保留：fork 后端没挂、
   * 或父会话还没有已完成轮次时，退回 spawn 而不是让建立直接失败。
   */
  const providerOrder = () => {
    const preferred = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'fork'
    return [...new Set([preferred, 'spawn'])]
  }

  /** 建立指挥员（缺失时）；建完立刻收紧它的工具面。 */
  app.ensureCommander = async (agent, signal) => {
    const rootId = rootIdOf(agent)
    const existing = await find(rootId, signal)
    if (existing !== undefined) return existing
    const cwd = await resolveCwd(ctx, agent, signal)
    await ensureDocs(cwd, config.docDir)
    const prompt = buildCommanderPrompt({
      cwd, docDir: config.docDir, name: config.commanderName, goal: goalObjective(agent),
    })
    const order = providerOrder()
    let lastError
    for (const provider of order) {
      try {
        const spawned = await spawnCommander(ctx, {
          agent, name: config.commanderName, label: '指挥员（架构设计 + 督察验收；可写但默认不动手、可续接）',
          prompt, provider, signal,
        })
        if (provider !== order[0]) ctx.logger?.warn?.(`dsh-commander: provider ${order[0]} 不可用，已退回 ${provider}`)
        return remember(spawned)
      } catch (error) {
        lastError = error
        ctx.logger?.warn?.(`dsh-commander: provider ${provider} 建立失败：${error?.message ?? error}`)
      }
    }
    throw lastError ?? new Error('建立指挥员失败')
  }

  /** 切挡位：写值 → 级别真的变了才动 goal → 清停运标志。 */
  app.applyMode = async (agent, next, before) => {
    const rootId = rootIdOf(agent)
    store.setMode(rootId, next, 'user')
    consulted.delete(rootId)
    if (shouldSyncGoal(before ?? DEFAULT_MODE, next)) await syncGoal(agent, next)
    app.driver?.reset(agent)
    return true
  }

  app.goalGateError = (agent, action) =>
    goalGate({
      enforceApproval: config.enforceApproval === true,
      isRoot: !agent?.session?.header?.parentSession,
      hasCommander: commanderIds.size > 0,
      mode: resolveMode({ hasCommander: commanderIds.size > 0, override: store.mode(rootIdOf(agent)) }).mode,
      action,
      phase: goalPhase(agent),
      approvals: approvals.get(rootIdOf(agent)),
      released: released.has(rootIdOf(agent)),
      messages: {
        needRelease: 'goal complete 需要指挥员的「允许结束」放行；先 say 汇报再 wait。',
        resumeByUser: 'paused goal 只能由用户在界面恢复，模型无权 resume。',
        needApproval: (act) => `goal ${act} 需要指挥员的「批准：goal ${act}」。`,
        needApprovalPhase: (act, phase) => `当前 goal 处于 ${phase}；goal ${act} 需要「批准：goal ${act}」。`,
      },
    })

  function applyRestriction(agent) {
    if (restrictions.has(agent.id)) return
    const dispose = restrictCommander(agent, config.allow)
    if (dispose !== undefined) restrictions.set(agent.id, dispose)
  }

  const driver = createDriver({
    ctx, store, name: config.commanderName, waitMs: config.waitMs, pollMs: config.pollMs,
    rootIdOf, modeOf, findCommander: find,
    sendToCommander: app.sendToCommander,
    waitReply: (agent, requestId, signal) => waitReply(app, agent, requestId, signal),
    subtreeBusy: (rootId) => subtreeBusy(ctx, rootId, commanderIds),
    resolveCwd: app.resolveCwd,
    goalObjective,
  })
  app.driver = driver

  // ---- 生命周期 ----
  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      if (agent === undefined) return
      if (agent.session?.header?.parentSession === undefined) return
      // 名字匹配或 id 已登记：都收紧。
      if (commanderIds.has(agent.id)) applyRestriction(agent)
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      if (agent === undefined) return
      driver.stop(agent)
      const dispose = restrictions.get(agent.id)
      if (dispose !== undefined) {
        try {
          dispose()
        } catch {
          // 已释放
        }
        restrictions.delete(agent.id)
      }
    })
    return () => {
      offCreated?.()
      offDisposed?.()
      driver.stopAll()
      for (const dispose of restrictions.values()) {
        try {
          dispose()
        } catch {
          // 已释放
        }
      }
      restrictions.clear()
    }
  })

  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (agent === undefined || status !== 'idle') return
      driver.requestDrive(driver.stateFor(agent))
    })
    const offEvent = ctx.on('session/event', (session, event) => {
      const agent = ctx.get('agents')?.get?.(session?.id)
      if (agent === undefined) return
      const state = driver.stateFor(agent)
      if (event?.type === 'turn/end') {
        state.turnEnded = true
        driver.requestDrive(state)
      }
      if (event?.type === 'user/message' && event.data?.message?.source?.kind === 'user') {
        state.interrupted = true
        consulted.delete(rootIdOf(agent))
        released.delete(rootIdOf(agent))
      }
    })
    return () => {
      offStatus?.()
      offEvent?.()
    }
  })

  // ---- 门禁（判定在 gate.js，这里只收集输入）----
  ctx.effect(() =>
    ctx.tools.guard((exec) => {
      const agent = exec.agent
      if (agent === undefined) return undefined
      const rootId = rootIdOf(agent)
      const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
      const shellViolation = config.shellTools.includes(exec.name) ? readOnlyShellViolation(command) : undefined
      if (invalidatesApproval({ toolName: exec.name, shellTools: config.shellTools, shellCommand: command, shellViolation })) {
        released.delete(rootId)
      }
      const mode = resolveMode({ hasCommander: commanderIds.size > 0, override: store.mode(rootId) }).mode
      const ask = askUserDenial({
        toolName: exec.name, mode, consulted: consulted.has(rootId),
        message: '全接管下问用户前必须先用 commander(action="say") 咨询指挥员。',
      })
      if (ask !== undefined) return ask
      const isCommander = commanderIds.has(agent.id)
      if (!isCommander) return undefined
      const cwd = agent.session?.cwd ?? process.cwd()
      return toolSurfaceDenial({
        toolName: exec.name, isCommander, allowed: new Set(config.allow),
        writeVerdict: writeScopeViolation({
          toolName: exec.name, args: exec.arguments, cwd, writeScopes: config.writeScopes,
          toPosix, resolvePath: (base, p) => resolve(base, p),
        }),
        shellVerdict: config.shellTools.includes(exec.name) ? shellViolation : undefined,
        denyReason: `指挥员只能用白名单工具（${config.allow.join(', ')}）。`,
      })
    }),
  )

  ctx.effect(() => registerTools(app))
  ctx.effect(() => registerRoutes(app))

  // 预热同步快照：tools.guard 是同步入口，挡位必须在第一次交互前就位。
  void store.ready()

  ctx.logger?.info?.(`dsh-commander: 已加载（工具 ${config.toolName}，挡位默认 ${LABELS[DEFAULT_MODE]}）`)
}

