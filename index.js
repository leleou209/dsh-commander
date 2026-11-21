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
 *   - 不含 doctor/checks/coverage/probe/code-state/manual/i18n/transcript-window/会话修复；
 *   - **换模型不重建**：只往会话追加一条 model/selection（lib/route-ops.js）。
 *
 * 这个文件只做装配：算配置、持有会话级状态、把事件接到驱动/门禁/工具/路由上。
 * 判断与实现都在 lib/：
 *   llm.js        路由（agentOptions / 可选清单 / 校验 / 用哪个 spawn 后端）
 *   route-ops.js  原地换模型、延迟应用、显式重建
 *   commander.js  建立 / 查找 / 收紧 / 工作目录
 *   session.js    会话事件的两种读法
 *
 * @module @leleou209/dsh-commander
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createStore } from './lib/store.js'
import { buildAgentOptions, collectModelRoutes, probeRoute, providerOrder } from './lib/llm.js'
import { createRouteOps } from './lib/route-ops.js'
import { createDriver } from './lib/driver.js'
import { createPreheatReader } from './lib/preheat.js'
import { createGoalSync } from './lib/goal-link.js'
import { buildCommanderPrompt } from './lib/prompt.js'
import { ensureDocs } from './lib/docs.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'
import { sendConsult, waitReply } from './lib/consult.js'
import { DEFAULT_MODE, LABELS, resolveMode, shouldSyncGoal } from './lib/modes.js'
import { shouldDriveOnTakeover } from './lib/handoff.js'
import { askUserDenial, directMessageDenial, goalGate, invalidatesApproval, nativeGoalAction, readOnlyShellViolation, toolSurfaceDenial, writeScopeViolation } from './lib/gate.js'
import { findCommander, findCommanderResult, listMembers, pickCommanderName, resolveCwd as resolveCwdHost, restrictCommander, rootIdOf as rootIdOfHost, sendToCommander as sendHost, spawnCommander, subtreeBusy } from './lib/commander.js'

// 测试与老调用方从这里取；实现已经搬进 lib/llm.js
export { buildAgentOptions } from './lib/llm.js'

export const name = 'dsh-commander'
export const inject = ['tools', 'subagents']

const DEFAULTS = {
  toolName: 'commander',
  recordToolName: 'commander_record',
  commanderName: 'commander',
  // 指挥员的显示标签。**它同时是认领指挥员的第二判据**：云端 0.2.1 返回的成员行
  // 没有 name/path，只能靠 label 认出来（否则会以为"没有指挥员"而反复新建）。
  commanderLabel: '指挥员（架构设计 + 督察验收；可写但默认不动手、可续接）',
  routePath: '/commander/takeover',
  docDir: 'doc',
  provider: 'fork',
  // 指挥员自己的 LLM 路由。留空 = 继承主会话（旧行为）。
  //
  // 老 README 里最重的一条建议是「不要用同源模型当指挥员」，而宿主把子会话的
  // allowedModels 白名单设成「主会话当前那一个」，所以在 UI 里换不了模型；
  // 唯一能换的地方就是这里——创建时用 agentOptions 指定。
  llmProvider: '',
  llmModel: '',
  llmReasoningEffort: '',
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
  for (const key of ['llmProvider', 'llmModel', 'llmReasoningEffort']) {
    config[key] = typeof config[key] === 'string' ? config[key].trim() : ''
  }
  return config
}

const toPosix = (value) => String(value).split(sep).join('/')

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const store = createStore({ path: resolve(String(config.statePath)), logger: ctx.logger })

  // 本轮语义：刻意只放内存，重启即清（放行/批准/已咨询都不该跨进程复活）。
  const inFlight = new Map()
  /**
   * 哪些 agent 是指挥员。**这是"它是不是指挥员"的判据，不是"本会话有没有指挥员"。**
   * 早先拿它的集合大小当后者用，等于把进程级事实当会话级事实：
   * 任何会话建过一次指挥员之后，所有新会话的门禁都会误生效。
   */
  const commanderIds = new Set()
  /**
   * 哪些 rootId **已确认**有指挥员——同步门禁唯一可用的按会话判据。
   *
   * `tools.guard` 与 `goalGateError` 都是同步入口，不能 await `listDescendants`，
   * 所以只能靠这个由异步路径（路由 / 工具 / agent 生命周期）填充的集合。
   * 代价：进程刚启动、还没解析过某个会话时它是空的 → 那段时间 fail-open（不拦）。
   * 这个失败方向是刻意选的：漏拦一次，比把整场会话误拦一天安全得多。
   */
  const knownCommanderRoots = new Set()
  /** 指挥员 id → 它所属的 rootId，用于销毁时回收 knownCommanderRoots。 */
  const commanderRoots = new Map()
  /**
   * 指挥员 id → 宿主的激活句柄。**只有本次进程内创建的才有。**
   *
   * 没有它就无法销毁指挥员：`Agent` 上只有 `cancel()`，`subagents` 服务没有任何删除方法，
   * 唯一能真正拆掉子会话的是 `startActivation` 返回的 `dispose()`。
   */
  const commanderHandles = new Map()
  const approvals = new Map()
  const released = new Set()
  const consulted = new Set()
  const restrictions = new Map()

  const rootIdOf = (agent) => rootIdOfHost(ctx, agent)
  /** 查到指挥员就登记它的 id 并收紧工具面：重启后第一次解析到时也必须收紧。 */
  const remember = (member, rootId) => {
    if (member === undefined || typeof member.id !== 'string') return member
    commanderIds.add(member.id)
    if (typeof member.dispose === 'function') commanderHandles.set(member.id, member.dispose)
    if (typeof rootId === 'string' && rootId.length > 0) {
      knownCommanderRoots.add(rootId)
      commanderRoots.set(member.id, rootId)
    }
    const live = ctx.get('agents')?.get?.(member.id)
    if (live !== undefined) applyRestriction(live)
    return member
  }
  /** 销毁一个指挥员时回收它的 rootId，让该会话退回 fail-open 而不是永久误拦。 */
  const forgetCommander = (agentId) => {
    commanderIds.delete(agentId)
    commanderHandles.delete(agentId)
    const rootId = commanderRoots.get(agentId)
    commanderRoots.delete(agentId)
    if (rootId === undefined) return
    // 同一 rootId 下可能还有别的指挥员（理论上不该有），确认没有才摘掉。
    for (const owner of commanderRoots.values()) {
      if (owner === rootId) return
    }
    knownCommanderRoots.delete(rootId)
  }
  const find = async (rootId, signal) => {
    const member = remember(
      await findCommander(ctx, rootId, config.commanderName, signal, store.forgotten(rootId)),
      rootId,
    )
    return member
  }
  /**
   * 同 `find`，但**区分"查不到"和"确实没有"**。
   *
   * 云端真踩过：web 实例刚起来时 `sessionQuery` 里还没有这个会话的投影，
   * `listDescendants` 抛 `SESSION_QUERY_SESSION_NOT_FOUND`；老代码把它当成
   * "没有指挥员"，于是初始化一遍遍建新指挥员，而状态查询又读不到——
   * 界面上就是"点了初始化，指挥员不见了"。
   *
   * 现在只有**真的读到**并且里面没有指挥员，才允许建立。
   */
  const findEx = async (rootId, signal) => {
    const result = await findCommanderResult(ctx, rootId, config.commanderName, signal, store.forgotten(rootId))
    if (result.member === undefined) return { member: undefined, unavailable: result.unavailable === true }
    const member = remember(result.member, rootId)
    return { member, unavailable: false }
  }
  const hasCommander = async (rootId) => (await find(rootId)) !== undefined

  const modeOf = async (agent) => {
    const rootId = rootIdOf(agent)
    return resolveMode({ hasCommander: await hasCommander(rootId), override: store.mode(rootId) }).mode
  }
  /** goal 记录（可能没有 goals 服务、也可能该会话没有 goal）。 */
  const goalRecord = (agent) => {
    try {
      return ctx.get('goals')?.get?.(agent)
    } catch {
      return undefined
    }
  }
  const goalObjective = (agent) => goalRecord(agent)?.objective
  const goalPhase = (agent) => goalRecord(agent)?.phase
  const goalRounds = (agent) => {
    const record = goalRecord(agent)
    if (record === undefined) return undefined
    return { started: record.roundsStarted, max: record.maxGoalRounds }
  }

  const app = {
    ctx, config, store, inFlight, commanderIds, approvals, released, consulted,
    rootIdOf, findCommander: find, hasCommander, modeOf, goalObjective, goalPhase, goalRounds,
    /**
     * 登记"这个会话确实有指挥员"。
     *
     * 同步门禁（`tools.guard`、`goalGateError`）不能 await 宿主，只能读
     * `knownCommanderRoots`。任何**已经确认**有指挥员的路径都该登记——
     * 尤其是状态查询这条最高频的入口，否则云端会出现
     * "初始化成功了，门禁却始终没生效"。
     */
    markCommanderRoot: (rootId) => {
      if (typeof rootId !== 'string' || rootId.length === 0) return
      knownCommanderRoots.add(rootId)
    },
    listMembers: (rootId, signal) => listMembers(ctx, rootId, signal),
    sendRaw: (agent, targetId, text, signal) => sendHost(ctx, agent, targetId, text, signal),
    sendToCommander: (agent, _targetId, text, signal) => sendConsult(app, agent, text, signal),
    resolveCwd: (agent, signal) => resolveCwdHost(ctx, agent, signal),
    // 给 routes 用：客户端的模型选择器需要"当前全部可用路由"。
    collectModelRoutes: () => collectModelRoutes(ctx),
    preheat: createPreheatReader({ ctx, findCommander: find, rootIdOf, name: config.commanderName }),
    /**
     * 销毁本会话的指挥员，供 `commander(action="dispose")` 调用。
     *
     * 三种结局，调用方必须分别处理：
     *   - `not-found`：本会话没有指挥员
     *   - `forgotten`：找到了，但它是**重启前创建、靠认领找到的**，没有句柄可拆。
     *     宿主没有第二条路（`Agent` 只有 cancel，`subagents` 没有 delete，
     *     归档/删除子会话也不会让 catalog 条目消失），所以改为**在插件层遗忘**：
     *     把这个 id 写进黑名单，从此不再认领它；磁盘上的会话数据原样保留。
     *   - ok：真拆掉了，并且在途的驱动/审批状态一起清干净。
     */
    disposeCommander: async (rootId, signal) => {
      const member = await find(rootId, signal)
      if (member === undefined) return { ok: false, reason: 'not-found' }
      const handle = commanderHandles.get(member.id)
      if (handle === undefined) {
        // 没有句柄 → 遗忘。这是用户唯一能"解散"重启前那个指挥员的实际办法。
        store.addForgotten(rootId, member.id)
        commanderIds.delete(member.id)
        commanderRoots.delete(member.id)
        knownCommanderRoots.delete(rootId)
        released.delete(rootId)
        approvals.delete(rootId)
        consulted.delete(rootId)
        return { ok: false, reason: 'forgotten', id: member.id }
      }
      try {
        await handle()
      } catch (error) {
        return { ok: false, reason: 'failed', id: member.id, message: String(error?.message ?? error) }
      }
      // 宿主一般也会发 agent/disposed，但别依赖它：这里主动把状态清干净。
      // **同时写黑名单**：子会话的 catalog 条目是父会话日志里的持久投影，
      // dispose 不会让它消失，所以不记黑名单的话下一次 find 又会把这个已销毁的
      // 指挥员认领回来——重建（recreate / dispose→start）就会变成"看起来没反应"。
      store.addForgotten(rootId, member.id)
      driver.stop({ id: member.id })
      forgetCommander(member.id)
      const dispose = restrictions.get(member.id)
      if (dispose !== undefined) {
        try {
          dispose()
        } catch {
          // 已释放
        }
        restrictions.delete(member.id)
      }
      released.delete(rootId)
      approvals.delete(rootId)
      consulted.delete(rootId)
      return { ok: true, id: member.id }
    },
  }

  // 重建：实现在 lib/route-ops.js（只要 ctx 与几个查找函数，不是整份 app）
  // `probeRoute` 同时挂到 app 上：路由层在建立前要先验模型，避免造出"出生即坏"的指挥员。
  /** 工具层的 args → 存储用的 route（缺字段就是没给）。 */
  app.routeFromArgs = (args) => {
    const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
    const model = typeof args?.model === 'string' ? args.model.trim() : ''
    if (provider.length === 0 || model.length === 0) return undefined
    const effort = typeof args?.reasoningEffort === 'string' ? args.reasoningEffort.trim() : ''
    return effort.length > 0 ? { provider, model, reasoningEffort: effort } : { provider, model }
  }
  app.probeRoute = (route, options) => probeRoute(ctx, route, options)
  Object.assign(app, createRouteOps(app, { probeRoute }))

  const syncGoal = createGoalSync({ ctx, rootIdOf })

  /** 建立指挥员（缺失时）；建完立刻收紧它的工具面。 */
  app.ensureCommander = async (agent, signal) => {
    const rootId = rootIdOf(agent)
    const probe = await findEx(rootId, signal)
    if (probe.member !== undefined) return probe.member
    // 只有**连这个会话本身都读不到**时才停手（重启后未加载）。
    // 全新会话没有 catalog 投影是正常状态，必须继续建——早先把它当"读不到"，
    // 结果新会话永远建不出指挥员。
    if (probe.unavailable) {
      throw new Error('当前进程还读不到这个会话（多半是刚重启、会话尚未加载）。请先在这个会话里发一句话，再点初始化。')
    }
    const cwd = await resolveCwdHost(ctx, agent, signal)
    await ensureDocs(cwd, config.docDir)
    const prompt = buildCommanderPrompt({
      cwd, docDir: config.docDir, name: config.commanderName, goal: goalObjective(agent),
    })
    let agentOptions = buildAgentOptions(config, store.route(rootId))
    // 出生前先验一次：路由不可用就别建（建出来每轮都报错，比建失败更难排查）。
    if (agentOptions !== undefined) {
      const probed = await probeRoute(ctx, agentOptions, { allowDropEffort: true })
      if (probed.ok !== true) {
        throw new Error(
          `指挥员路由不可用：${agentOptions.provider ?? '(继承)'}/${agentOptions.model ?? '(继承)'}（${probed.message}）`,
        )
      }
      if (probed.dropped !== undefined) {
        ctx.logger?.warn?.(
          `dsh-commander: ${agentOptions.provider}/${agentOptions.model} 不支持 reasoningEffort ${probed.dropped}，已忽略该项`,
        )
      }
      agentOptions = probed.route
    }
    const order = providerOrder(config, agentOptions)
    // 名字要挑一个没被占用的：dispose 不会释放父会话里的名字，
    // 所以"换模型重建"必然要用 commander-2 / commander-3…
    const name = await pickCommanderName(ctx, rootId, config.commanderName, signal)
    let lastError
    for (const provider of order) {
      try {
        const spawned = await spawnCommander(ctx, {
          agent, name, label: config.commanderLabel,
          prompt, provider, signal, agentOptions,
        })
        if (provider !== order[0]) ctx.logger?.warn?.(`dsh-commander: provider ${order[0]} 不可用，已退回 ${provider}`)
        if (agentOptions !== undefined) {
          ctx.logger?.info?.(`dsh-commander: 指挥员使用自定义路由 ${JSON.stringify(agentOptions)}（走 spawn，不吃 fork 的缓存）`)
        }
        // 记下这条会话实际用的路由：`status` 靠它回答"跑在哪个模型上"。
        // 不能靠读指挥员的会话事件——它预热完进入 idle 后 residency 就释放了，
        // 那时 agents.get / sessions.get 都拿不到（实测）。
        if (agentOptions !== undefined) store.setRoute(rootId, agentOptions)
        return remember(spawned, rootId)
      } catch (error) {
        lastError = error
        // 带上栈：宿主深处的异常（例如配置未注入）只看 message 定位不到来源。
        const stack = String(error?.stack ?? '').split('\n').slice(0, 8).join('\n')
        ctx.logger?.warn?.(`dsh-commander: provider ${provider} 建立失败：${error?.message ?? error}\n${stack}`)
      }
    }
    throw lastError ?? new Error('建立指挥员失败')
  }

  /** 切挡位：写值 → 级别真的变了才动 goal → 清停运标志。
   *
   * `rootIdOverride` 给"会话暂时未激活"的场合用：那时拿不到 Agent，
   * 无法 rootIdOf，但挡位本身是按会话 id 持久化的，照样该能改。
   * 没有 Agent 就不碰 goal（没有会话就没有 goal 可同步）。
   */
  app.applyMode = async (agent, next, before, rootIdOverride) => {
    const rootId = rootIdOverride ?? rootIdOf(agent)
    const previous = before ?? DEFAULT_MODE
    // 必须在 syncGoal 之前读：同步可能恰好新建 goal，那不算「用户本来就有目标」。
    const goalWasActive = agent !== undefined && goalPhase(agent) === 'active'
    store.setMode(rootId, next, 'user')
    consulted.delete(rootId)
    if (agent !== undefined && shouldSyncGoal(before ?? DEFAULT_MODE, next)) await syncGoal(agent, next)
    if (agent !== undefined) {
      app.driver?.reset(agent)
      // 退出全接管：在途等待立刻收口，不挂满 waitMs（唤醒仍由 shouldWakeParent 兜底）。
      if (previous === 'full' && next !== 'full') app.driver?.cancelWait(agent)
      // 进入全接管：面板直接切挡位没有 turn/end 事件，这里补一次驱动，
      // 否则「切了全接管，主会话却一直不动」。
      if (shouldDriveOnTakeover({ before: previous, next, goalPhase: goalWasActive ? 'active' : undefined })) {
        const state = app.driver?.stateFor(agent)
        if (state !== undefined) {
          state.turnEnded = true
          app.driver.requestDrive(state)
        }
      }
    }
    return true
  }

  app.goalGateError = (agent, action) => {
    const gateRootId = rootIdOf(agent)
    // 按**会话**判，不看进程里有没有指挥员：否则别的会话建过，这个会话就被误拦。
    const gateHasCommander = knownCommanderRoots.has(gateRootId)
    return goalGate({
      enforceApproval: config.enforceApproval === true,
      isRoot: !agent?.session?.header?.parentSession,
      hasCommander: gateHasCommander,
      mode: resolveMode({ hasCommander: gateHasCommander, override: store.mode(gateRootId) }).mode,
      action,
      phase: goalPhase(agent),
      approvals: approvals.get(gateRootId),
      released: released.has(gateRootId),
      messages: {
        needRelease: 'goal complete 需要指挥员的「允许结束」放行；先 say 汇报再 wait。',
        resumeByUser: 'paused goal 只能由用户在界面恢复，模型无权 resume。',
        needApproval: (act) => `goal ${act} 需要指挥员的「批准：goal ${act}」。`,
        needApprovalPhase: (act, phase) => `当前 goal 处于 ${phase}；goal ${act} 需要「批准：goal ${act}」。`,
      },
    })
  }

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
      // 指挥员被销毁 → 回收它的 rootId，免得该会话从此被永久误判为"有指挥员"。
      forgetCommander(agent.id)
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
      // 按**会话**判：`commanderIds` 只回答"某个 agent 是不是指挥员"，
      // 不能拿它的 size 当"本会话有没有指挥员"——那会让新会话继承别人会话的门禁。
      const mode = resolveMode({ hasCommander: knownCommanderRoots.has(rootId), override: store.mode(rootId) }).mode
      const ask = askUserDenial({
        toolName: exec.name, mode, consulted: consulted.has(rootId),
        message: '全接管下问用户前必须先用 commander(action="say") 咨询指挥员。',
      })
      if (ask !== undefined) return ask

      const isCommander = commanderIds.has(agent.id)
      // 原生 goal 工具也要过同一道门：主 agent 手里有 create_goal / update_goal，
      // 只挡 commander(action="goal") 那条自家通道等于没挡。
      const goalAction = nativeGoalAction(exec.name, exec.arguments)
      if (goalAction !== undefined) {
        const denial = app.goalGateError(agent, goalAction)
        if (denial !== undefined) return denial
        // 放行是一次性的：过了就把「允许结束」收掉（guard 在调用前跑，只能在这里消费）。
        if (goalAction === 'complete') released.delete(rootId)
      }
      if (!isCommander) {
        // 这里传**显式**挡位而不是推导值：推导会在"重启后还没解析到指挥员"时得到 off，
        // 于是把合法的直连也拦掉。只挡用户真的亲手切到 off 的情况。
        return directMessageDenial({
          toolName: exec.name, args: exec.arguments, mode: store.mode(rootId), commanderName: config.commanderName,
        })
      }
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

  // 工具与路由各自返回 disposer，一个 effect 里一起登记。
  ctx.effect(() => {
    const offTools = registerTools(app)
    const offRoutes = registerRoutes(app)
    return () => {
      offTools?.()
      offRoutes?.()
    }
  })

  // 预热同步快照：tools.guard 是同步入口，挡位必须在第一次交互前就位。
  void store.ready()

  ctx.logger?.info?.(`dsh-commander: 已加载（工具 ${config.toolName}，挡位默认 ${LABELS[DEFAULT_MODE]}）`)
}

