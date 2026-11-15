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
import { ensureDocs, formatHistoryEntry, prependHistory } from './docs.js'

const ACTIONS = ['start', 'status', 'list', 'say', 'wait', 'cancel', 'goal', 'takeover']
const GOAL_ACTIONS = ['create', 'edit', 'pause', 'resume', 'blocked', 'complete', 'clear']
const OUTPUT = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
const ok = (text) => ({ text })
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

async function runGoal(app, agent, args) {
  const action = String(args?.goalAction ?? '')
  if (!GOAL_ACTIONS.includes(action)) throw new Error(`goalAction 必须是 ${GOAL_ACTIONS.join('/')}`)
  const denial = app.goalGateError(agent, action)
  if (denial !== undefined) return ok(denial)
  const goals = app.ctx.get('goals')
  if (goals === undefined) return ok('当前 DSH 没有 goals 服务。')
  const goal = goals.get(agent)
  const ref = goal !== undefined ? { expectedRevision: goal.revision, goalId: goal.id } : undefined
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
    goals.complete(agent, ref)
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
    if (!hasCommander) await app.ensureCommander(agent, signal)
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
    const lines = [
      `挡位：${LABELS[mode]}（${mode}）`,
      `指挥员：${hasCommander ? '在场' : '未建立'}`,
      `goal：${app.goalObjective(agent) ?? '（无）'}`,
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
  const commanderTool = {
    name: config.toolName,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'start 建立/接管；status 只读状态；list 列成员；say 发咨询；wait 等回复；cancel 取消；goal 管理目标；takeover 切挡位。' },
        message: { type: 'string', description: 'say 要发给指挥员的完整消息。' },
        requestId: { type: 'string', description: 'wait/cancel 可选的请求 id；省略用当前 pending。' },
        state: { type: 'string', enum: MODES, description: 'takeover/start 的挡位：用户说「当顾问」用 observe，说「全接管」用 full。' },
        goalAction: { type: 'string', enum: GOAL_ACTIONS, description: 'goal 动作；create 需要 objective。' },
        objective: { type: 'string', description: 'goal create/edit 的目标文本。' },
        maxRounds: { type: 'number', description: 'goal 轮次上限（可选）。' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('commander 必须由 agent 调用')
      return dispatch(app, agent, args ?? {}, exec.signal)
    },
  }

  const recordTool = {
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
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('commander_record 必须由 agent 调用')
      const summary = oneLine(args?.summary)
      if (summary.length === 0) throw new Error('summary 不能为空')
      const cwd = await app.resolveCwd(agent, exec.signal)
      const paths = await ensureDocs(cwd, config.docDir)
      await prependHistory(paths.history, formatHistoryEntry(summary, args?.details))
      return ok(`已写入 ${relative(cwd, paths.history).split(sep).join('/')}（最新在上）\n\n${summary}`)
    },
  }

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
