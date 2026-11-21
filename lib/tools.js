/**
 * 工具层：commander（8 个动作）+ commander_record。
 *
 * 与老包差别：没有 doctor / checks / help / handoff 探针（那些是自检与说明书外围，
 * 不属于核心）。wait 的回复直接从指挥员会话日志取，不依赖宿主的完成推送。
 */

import { relative, sep } from 'node:path'
import { blockedWhenOff, LABELS, MODES, normalizeMode, resolveMode } from './modes.js'
import { hasRelease, parseGoalApprovals } from './protocol.js'
import { RELATION_NOTE, TOOL_DESCRIPTION } from './prompt.js'
import { sendConsult, waitReply } from './consult.js'
import { ensureDocs, formatHistoryEntry, formatPlanEntry, prependHistory, prependPlan } from './docs.js'
import { sessionEvents } from './session.js'

const ACTIONS = ['start', 'status', 'list', 'say', 'wait', 'cancel', 'goal', 'takeover', 'plan', 'dispose', 'recreate', 'rebuild']

/**
 * status 用：指挥员实际跑在什么模型上。
 *
 * **以插件记的路由为准**——这是唯一可靠来源。实测：指挥员预热完进入 idle 后
 * residency 被释放，`agents.get` / `sessions.get` 都拿不到它，读会话事件整条路是空的。
 * 只有在没有记录（老状态 / 没配 llm*）时才去会话里找，找不到就如实说"跟随主会话"，
 * 不编一个模型出来。
 */
async function describeRoute(app, rootId) {
  const member = await app.findCommander(rootId).catch(() => undefined)
  if (member === undefined) return '（无指挥员）'
  const recorded = app.store?.route?.(rootId)
  if (recorded !== undefined && typeof recorded.provider === 'string' && typeof recorded.model === 'string') {
    const effort = typeof recorded.reasoningEffort === 'string' && recorded.reasoningEffort.length > 0
      ? `（effort ${recorded.reasoningEffort}）` : ''
    return `${recorded.provider}/${recorded.model}${effort}`
  }
  // 两路都试：活 agent 的 session 有时是空的（刚建立/刚续接），会话存储里有全量；
  // 反过来只有会话存储的情况也常见。
  let events = sessionEvents(app.ctx.get('agents')?.get?.(member.id)?.session)
  if (events.length === 0) events = sessionEvents(app.ctx.get('sessions')?.get?.(member.id))
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/context') {
      const { provider, model } = event.data ?? {}
      if (typeof provider === 'string' && typeof model === 'string') return `${provider}/${model}`
    }
    if (event?.type !== 'subagent/descriptor') continue
    const { agentProvider, agentModel, agentReasoningEffort } = event.data ?? {}
    if (typeof agentProvider === 'string' && typeof agentModel === 'string') {
      const effort = typeof agentReasoningEffort === 'string' && agentReasoningEffort.length > 0 ? `（effort ${agentReasoningEffort}）` : ''
      return `${agentProvider}/${agentModel}${effort}`
    }
  }
  return '跟随主会话'
}

const ok = (text) => ({ text })
const GOAL_ACTIONS = ['create', 'edit', 'pause', 'resume', 'blocked', 'complete', 'clear']
const OUTPUT = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
/** 两个工具共用的外壳：同样的输出渲染、同样的串行约定、同样的 agent 前置检查。 */
const toolShell = (spec) => ({
  ...spec,
  output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
  isConcurrencySafe: () => false,
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error(`${spec.name} 必须由 agent 调用`)
    return spec.run(agent, args ?? {}, exec.signal)
  },
})
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

async function runGoal(app, agent, args) {
  const action = String(args?.goalAction ?? '')
  if (!GOAL_ACTIONS.includes(action)) throw new Error(`goalAction 必须是 ${GOAL_ACTIONS.join('/')}`)
  const denial = app.goalGateError(agent, action)
  if (denial !== undefined) return ok(denial)
  const goals = app.ctx.get('goals')
  if (goals === undefined) return ok('当前 DSH 没有 goals 服务。')
  const goal = goals.get(agent)
  // 宿主的 GoalRef 是 { id, revision }（不是 { goalId, expectedRevision }）：
  // 传错形状时宿主只会报 `stale goal ref "undefined" revision undefined`，
  // 看起来像并发冲突，实际是字段名不对。见 test/invariants.mjs 的静态不变量。
  const ref = goal !== undefined ? { id: goal.id, revision: goal.revision } : undefined
  if (action === 'create') {
    const objective = String(args?.objective ?? '').trim()
    if (objective.length === 0) return ok('create 需要 objective。')
    goals.create(agent, { objective })
    return ok('已创建 goal。')
  }
  if (ref === undefined) return ok('当前会话没有 goal。')
  if (action === 'edit') {
    const patch = {}
    if (typeof args?.objective === 'string') patch.objective = args.objective
    if (Number.isFinite(args?.maxRounds)) patch.maxRounds = Number(args.maxRounds)
    goals.edit(agent, ref, patch)
  } else if (action === 'clear') {
    // 宿主的 `clear` 是墓碑（goal 直接移除）；`complete` 只是标记完成并留档。
    // 拿 complete 冒充 clear 有两个后果：会话里永远留一个「已完成」的 goal；
    // 对已经 complete 的 goal 再 complete 还会被宿主拒（expected active/paused/blocked）。
    if (typeof goals.clear === 'function') goals.clear(agent, ref)
    else goals.complete(agent, ref)
  } else {
    goals[action](agent, ref)
  }
  // 放行是一次性的：complete 成功后立刻收掉。
  if (action === 'complete') app.released.delete(app.rootIdOf(agent))
  return ok(`goal ${action} 已执行。`)
}

async function dispatch(app, agent, args, signal) {
  const action = ACTIONS.includes(args?.action) ? args.action : 'status'
  const rootId = app.rootIdOf(agent)
  const hasCommander = await app.hasCommander(rootId)
  const mode = resolveMode({ hasCommander, override: app.store.mode(rootId) }).mode

  if (blockedWhenOff(action) && mode === 'off') {
    return ok('当前挡位是「不运行指挥职责」，say/wait 不可用。请自行思考，或先切到不接管及以上。')
  }

  if (action === 'start') {
    if (!hasCommander) {
      // 模型是建立时的一次性决策。工具层也不能绕过：要么显式给出路由，
      // 要么 profile 里配了 llm*，否则拒绝——不能悄悄"跟随主会话"建一个出来。
      const chosen = app.routeFromArgs?.(args)
      if (chosen !== undefined) app.store.setRoute(rootId, chosen)
      // 空字符串也算"没配"（config 的默认值就是空串）。
      const configured = typeof app.config.llmModel === 'string' && app.config.llmModel.trim().length > 0
      if (app.store.route(rootId) === undefined && !configured) {
        return ok(
          '建立指挥员之前必须先选定模型（模型建立后不可更改）。\n'
          + '给一个 provider/model，例如 commander(action="start", provider="qwen", model="qwen4-max-preview")；\n'
          + '或者在 profile 里配置 llmProvider / llmModel。',
        )
      }
      await app.ensureCommander(agent, signal)
    }
    const requested = normalizeMode(args?.state)
    if (requested !== undefined) await app.applyMode(agent, requested, mode)
    // 建立关系时把声明说一次（只落一次对话历史，不额外占每轮提示词）。
    const headline = hasCommander ? '指挥员已在场。' : '指挥员已建立并开始预热；预热完它会待命，不会让本会话自动开工。'
    return ok(`${headline}\n\n${RELATION_NOTE}`)
  }
  if (action === 'list') {
    const rows = await app.listMembers(rootId, signal)
    if (rows.length === 0) return ok('本会话下没有可续接子agent。')
    return ok(rows.map((row) => `- ${row.name || row.id}（${row.status}，depth ${row.depth}）`).join('\n'))
  }
  if (action === 'status') {
    const preheat = await app.preheat(agent)
    // 只报 objective 会把「已结束/已暂停」的 goal 显示得像还在跑：
    // 用户看到 goal 文本、agent 以为还能推进，实测最容易在 clear/complete 上撞墙。
    const objective = app.goalObjective(agent)
    const phase = app.goalPhase?.(agent)
    const rounds = app.goalRounds?.(agent)
    const goalLine = objective === undefined
      ? 'goal：（无）'
      : `goal（${phase ?? '未知'}${rounds === undefined ? '' : `，轮次 ${rounds.started}/${rounds.max}`}）：${objective}`
    const lines = [
      `挡位：${LABELS[mode]}（${mode}）`,
      `指挥员：${hasCommander ? '在场' : '未建立'}`,
      `指挥员路由：${await describeRoute(app, rootId)}`,
      goalLine,
      `未完成请求：${app.store.pending(rootId)?.requestId ?? '（无）'}`,
      `放行：${app.released.has(rootId) ? '有' : '无'}｜批准：${[...(app.approvals.get(rootId) ?? [])].join('/') || '无'}`,
    ]
    if (preheat !== undefined) {
      lines.push(`预热：${preheat.state}，${Math.round(preheat.ms / 1000)}s / ${preheat.steps} 步 / ${preheat.tools} 次工具 / ${preheat.tokens.total} token`)
    }
    return ok(lines.join('\n'))
  }
  if (action === 'say') {
    const message = String(args?.message ?? '').trim()
    if (message.length === 0) return ok('say 需要 message。')
    const sent = await sendConsult(app, agent, message, signal)
    return ok(`已发出咨询 ${sent.requestId}；用 commander(action="wait") 等回复。`)
  }
  if (action === 'wait') {
    try {
      const result = await waitReply(app, agent, args?.requestId, signal)
      if (result.kind !== 'reply') return ok(`等待结束（${result.kind}）：${result.text ?? ''}`)
      if (hasRelease(result.text)) app.released.add(rootId)
      const approvals = parseGoalApprovals(result.text)
      if (approvals.size > 0) app.approvals.set(rootId, approvals)
      return ok(result.text)
    } finally {
      app.consulted.add(rootId)
    }
  }
  if (action === 'cancel') {
    return ok(app.store.deletePending(rootId) ? '已取消等待并清掉 pending。' : '当前没有未完成的请求。')
  }
  if (action === 'dispose') {
    // 解散指挥员（一般是换模型重建的前一步）。下次 start 会重新建立。
    const result = await app.disposeCommander(rootId, signal)
    if (result.ok) return ok(`已销毁指挥员（${result.id}）。下次 start 会用当前配置重新建立。`)
    if (result.reason === 'not-found') return ok('本会话没有指挥员，不需要解散。')
    if (result.reason === 'forgotten') {
      return ok(
        `已遗忘指挥员（${result.id}），下次 start 会新建一个。`
        + '\n\n说明：它是插件启动前创建的，没有销毁句柄，而宿主的 catalog 是父会话里的持久投影——'
        + '归档或删除子会话都不会让那条记录消失，所以只能从插件这一层不再认领它。'
        + '它的会话数据仍留在磁盘上，没有删。',
      )
    }
    return ok(`解散失败：${result.message ?? '未知原因'}。`)
  }
  if (action === 'recreate' || action === 'rebuild') {
    // 两个名字做同一件事：拆掉旧的、按给定路由建一个新的。
    // **这不是"换模型"**——上下文会重置，所以返回里必须说清楚，
    // 否则用户会以为还能接着之前的对话。
    const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
    const model = typeof args?.model === 'string' ? args.model.trim() : ''
    if (provider.length === 0 || model.length === 0) {
      return ok(`${action} 需要同时给出 provider 和 model（例如 provider="qwen", model="qwen4-max-preview"）。`)
    }
    const reasoningEffort = typeof args?.reasoningEffort === 'string' ? args.reasoningEffort.trim() : ''
    const route = { provider, model, reasoningEffort }
    const label = `${provider}/${model}${reasoningEffort.length > 0 ? `（effort ${reasoningEffort}）` : ''}`

    let result
    try {
      result = await app.rebuildCommander(agent, route, signal)
    } catch (error) {
      return ok(`${action} 失败：${error?.message ?? error}。没有做任何改动。`)
    }
    if (result?.ok !== true) {
      if (result?.reason === 'unknown-route') {
        return ok(
          `这个路由不可用：${label}\n${result.message ?? ''}`
          + '\n\n没有做任何改动。用 commander(action="status") 看当前路由，或从模型清单里重选。',
        )
      }
      return ok(`${action} 失败：${result?.message ?? result?.reason ?? '未知原因'}。`)
    }
    return ok(
      `已重建指挥员 → ${label}`
      + '\n**上下文已重置**：新指挥员是全新的，旧会话仍在磁盘上但不再续接。',
    )
  }
  if (action === 'plan') {
    // 计划是**写一次、可演进**的产物：倒序追加，最新一条就是当前计划。
    const body = String(args?.plan ?? '').trim()
    if (body.length === 0) return ok('plan 需要 plan（Markdown 正文）。')
    const cwd = await app.resolveCwd(agent, signal)
    const paths = await ensureDocs(cwd, app.config.docDir)
    await prependPlan(paths.plan, formatPlanEntry(body, args?.planTitle))
    return ok(`已写入 ${relative(cwd, paths.plan).split(sep).join('/')}（最新在上）`)
  }
  if (action === 'takeover') {
    const next = normalizeMode(args?.state)
    if (next === undefined) return ok(`state 必须是 ${MODES.join('/')}`)
    if (next !== 'off' && !hasCommander) await app.ensureCommander(agent, signal)
    await app.applyMode(agent, next, mode)
    return ok(`挡位已切到「${LABELS[next]}」。`)
  }
  return runGoal(app, agent, args)
}

export function registerTools(app) {
  const { ctx, config } = app
  const commanderTool = toolShell({
    name: config.toolName,
    description: TOOL_DESCRIPTION,
    run: (agent, args, signal) => dispatch(app, agent, args, signal),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'start 建立/接管；status 只读状态；list 列成员；say 发咨询；wait 等回复；cancel 取消；goal 管理目标；takeover 切挡位；plan 维护 doc/plan.md（当前计划，最新在上）；dispose 销毁指挥员（下次 start 重建）；recreate / rebuild 拆旧建新（上下文会重置，需要 provider + model）；换模型不是运行时能力——模型在建立时选定。' },
        message: { type: 'string', description: 'say 要发给指挥员的完整消息。' },
        plan: { type: 'string', description: 'plan 的 Markdown 正文：目标拆解、阶段、验收点。每次写入都会保留旧版，最新一条即当前计划。' },
        planTitle: { type: 'string', description: 'plan 可选的一句话标题，会跟在时间戳后面。' },
        requestId: { type: 'string', description: 'wait/cancel 可选的请求 id；省略用当前 pending。' },
        state: { type: 'string', enum: MODES, description: 'takeover/start 的挡位：用户说「当顾问」用 observe，说「全接管」用 full。' },
        goalAction: { type: 'string', enum: GOAL_ACTIONS, description: 'goal 动作；create 需要 objective。' },
        provider: { type: 'string', description: 'start/recreate/rebuild 用：指挥员的 LLM provider（例如 qwen）。' },
        model: { type: 'string', description: 'start/recreate/rebuild 用：模型 id（例如 qwen4-max-preview）。' },
        reasoningEffort: { type: 'string', description: 'recreate/rebuild 用：可选推理档位（如 high）。' },
        objective: { type: 'string', description: 'goal create/edit 的目标文本。' },
        maxRounds: { type: 'number', description: 'goal 轮次上限（可选）。' },
      },
      required: ['action'],
    },
  })

  const recordTool = toolShell({
    name: config.recordToolName,
    description: '把刚完成的实质行为倒序（最新在上）追加到 doc/history.md，供下一轮指挥员判断进度。只记事实，不写计划或建议。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: '一句话概括本轮完成的行为。' },
        details: { type: 'string', description: '可选补充（Markdown）：改动文件、验证方式、遗留问题。' },
      },
      required: ['summary'],
    },
    async run(agent, args, signal) {
      const summary = oneLine(args.summary)
      if (summary.length === 0) throw new Error('summary 不能为空')
      const cwd = await app.resolveCwd(agent, signal)
      const paths = await ensureDocs(cwd, config.docDir)
      await prependHistory(paths.history, formatHistoryEntry(summary, args.details))
      return ok(`已写入 ${relative(cwd, paths.history).split(sep).join('/')}（最新在上）\n\n${summary}`)
    },
  })

  const disposers = [ctx.tools.register(commanderTool), ctx.tools.register(recordTool)]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 已释放
      }
    }
  }
}
