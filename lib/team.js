/**
 * Agent Teams 桥（2.9.45）：把插件对「指挥员成员」的读写，落到 DSH 0.2.2 的新 API 上。
 *
 * 为什么需要这一层：
 *   - 0.2.2 起 `ctx.agentTeams` **不再提供** spawnTeammate / listMembers / sendMessage /
 *     membership（rc.2 迁移指南：`docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/`）。
 *     team 现在只管任务板；「成员」= 根会话下**可续接的子agent**，收发消息走 `ctx.subagents`。
 *   - 插件里成员读写点很多（状态、名册、等待、门禁、doctor），逐处改成异步风险大。
 *     这一层保持旧签名（同步 listMembers），用**按根会话缓存**兜住同步调用，异步路径负责刷新。
 *
 * 对应关系：spawnTeammate -> ctx.subagents.startActivation；listMembers -> listDescendants（缓存成同步视图）；
 * sendMessage -> ctx.subagents.sendMessage；membership -> 本层缓存。
 * 失败策略：查询降级成空集合，写入抛错（让调用方给出可读原因）。
 *
 * **resultDelivery（2.9.58）**：spawn 一律用 `delivery: 'caller'`。
 * 宿主的 `delivery: 'parent'` 会在子agent **每轮结束**时走 `notifySettlement` →
 * `sendWaking(parent, …)`，把一条 `subagent-settled` 消息塞进主会话收件箱并**开新一轮**。
 * 这就是「初始化一结束主会话自己动起来」的根因（证据：主会话在子会话 turn/end 后 28ms
 * 收信并 turn/start，主agent 随即开始摸项目，被用户中断）。
 * 指挥员的回复本来就走插件自己的握手（pending + session 事件），不依赖这条推送，
 * 所以 caller 投递只是**拿掉自动唤醒**，不丢任何功能。
 */

import { ensureAbortSignal } from './guards.js'

const SERVICE_METHOD = 'startActivation'

/** rootId -> 上次"冷缓存探测"时间（ensureCommanderKnown 的负缓存，2.9.59）。 */
const coldProbeAt = new Map()

/** 宿主列举行 -> 插件成员行；只保留必要字段。 */
export function toRow(entry, statusOf) {
  if (entry === null || typeof entry !== 'object') return undefined
  if (typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  const row = { id: entry.id, name: typeof entry.name === 'string' ? entry.name : '', role: 'teammate' }
  if (typeof entry.label === 'string' && entry.label.length > 0) row.label = entry.label
  if (typeof entry.mode === 'string') row.mode = entry.mode
  const status = statusOf?.(entry.id)
  if (typeof status === 'string') row.status = status
  return row
}

/** 缓存里的行 -> 对外视图（status 每次取实时值）。 */
export function viewRows(rows, statusOf) {
  const out = []
  for (const row of rows.values()) {
    const live = statusOf?.(row.id)
    out.push(live === undefined ? { ...row } : { ...row, status: live })
  }
  return out
}

/**
 * 用宿主列举结果更新缓存，并摘掉已经不在运行的幽灵行。
 * @returns {Array<object>} 更新后的视图
 */
export function mergeDescendants({ rows, entries, commanderName, statusOf, isLive }) {
  const seen = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== undefined && entry.kind !== 'child' && entry.kind !== 'root') continue
    if (entry?.name !== commanderName) continue
    const row = toRow(entry, statusOf)
    if (row === undefined) continue
    rows.set(row.id, row)
    seen.add(row.id)
  }
  for (const id of [...rows.keys()]) {
    if (seen.has(id)) continue
    if (!isLive?.(id)) rows.delete(id)
  }
  return viewRows(rows, statusOf)
}

/** 这个 agent id 是否在任一缓存里（用于 membership 反查）。 */
export function findMembership(cache, agentId) {
  if (typeof agentId !== 'string') return undefined
  for (const rows of cache.values()) {
    const row = rows.get(agentId)
    if (row !== undefined) return { role: 'teammate', name: row.name }
  }
  return undefined
}

/** 按名字或 id 找成员；返回 undefined 表示没找到。 */
export function pickMember(rows, target) {
  return (Array.isArray(rows) ? rows : []).find((row) => row.name === target || row.id === target)
}

/** agent id 是否还活着（宿主 agents 服务里有它）。 */
export function agentIsLive(ctx, id) {
  try {
    return ctx.get('agents')?.get?.(id) !== undefined
  } catch {
    return false
  }
}

/**
 * 并列子agent 列表（指挥员用它看 Lead 的并行工作）。
 * @param {{sub: any, rootId: string, signal: AbortSignal, statusOf: (id: string) => string|undefined}} input
 */
export async function listLiveSubagents({ sub, rootId, signal, statusOf }) {
  if (sub === undefined || typeof sub.listDescendants !== 'function') return []
  try {
    const entries = await sub.listDescendants(rootId, ensureAbortSignal(signal))
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.kind === 'child')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : '',
        status: statusOf(entry.id) ?? 'inactive',
        depth: typeof entry.depth === 'number' ? entry.depth : 1,
      }))
  } catch {
    return []
  }
}

/**
 * 冷缓存兜底（2.9.59）：重启后成员缓存是空的，`listMembers` 会说「没有指挥员」。
 *
 * 图标判相位只看缓存，于是重启后第一次 GET 得到 `hasCommander:false` → 画成问号，
 * 用户看到的就是"图标不认指挥员了"。指挥员的会话 id 记在父会话日志的 `subagent/catalog`
 * 里，`listDescendants` 能读回来，所以这里补一次**有界**刷新（超时就不等了，
 * 客户端 8 秒后自己会再问）。
 *
 * 没有指挥员的会话也会走到这里，所以对"刚探测过还是空"记 15 秒负缓存，避免每轮都打宿主。
 *
 * @param {{listMembers: Function, refresh: Function, rootIdOf: Function}} bridge 成员桥
 * @param {any} agent 当前会话的活 agent（拿不到就没法刷新）
 * @param {string} commanderName 指挥员名字
 * @param {{now?: () => number, timeoutMs?: number, ttlMs?: number}} [options]
 * @returns {Promise<boolean>} 缓存里现在能不能看到指挥员
 */
export async function ensureCommanderKnown(bridge, agent, commanderName, options = {}) {
  if (agent === undefined || agent === null) return false
  const cached = () => bridge.listMembers(agent).some((row) => row.name === commanderName)
  if (cached() === true) return true
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : 15_000
  const rootId = String(bridge.rootIdOf(agent) ?? '')
  if (now() - (coldProbeAt.get(rootId) ?? 0) < ttl) return false
  coldProbeAt.set(rootId, now())
  let timer
  const limit = new Promise((done) => {
    timer = setTimeout(done, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1_500)
    timer.unref?.()
  })
  try {
    await Promise.race([bridge.refresh(agent, ensureAbortSignal(undefined)), limit])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
  return cached()
}

/**
 * @param {object} input
 * @param {object} input.ctx 插件 ctx（只用到 get('subagents') / get('agents')）
 * @param {string} input.commanderName 指挥员的 agent 名（也是 send_message 的 target）
 */
export function createTeamBridge({ ctx, commanderName }) {
  const cache = new Map()

  const subagents = () => {
    try {
      const sub = ctx.get('subagents')
      return sub !== undefined && typeof sub[SERVICE_METHOD] === 'function' ? sub : undefined
    } catch {
      return undefined
    }
  }
  const statusOf = (id) => {
    try {
      const agent = ctx.get('agents')?.get?.(id)
      if (agent === undefined) return undefined
      return typeof agent.status === 'string' ? agent.status : 'running'
    } catch {
      return undefined
    }
  }
  const isLive = (id) => agentIsLive(ctx, id)
  const rootIdOf = (agent) => {
    try {
      const root = subagents()?.rootOf?.(agent)
      const id = root?.session?.header?.id ?? root?.id
      if (typeof id === 'string' && id.length > 0) return id
    } catch {
      // rootOf 不可用：退回 header 上溯结果
    }
    return agent?.session?.header?.id ?? agent?.id
  }
  const bucket = (rootId) => {
    let rows = cache.get(rootId)
    if (rows === undefined) {
      rows = new Map()
      cache.set(rootId, rows)
    }
    return rows
  }
  const listMembers = (agent) => viewRows(bucket(rootIdOf(agent)), statusOf)
  const membership = (agent) => findMembership(cache, agent?.id)

  async function refresh(agent, signal) {
    const sub = subagents()
    const rows = bucket(rootIdOf(agent))
    if (sub === undefined || typeof sub.listDescendants !== 'function') return viewRows(rows, statusOf)
    try {
      const entries = await sub.listDescendants(rootIdOf(agent), ensureAbortSignal(signal))
      return mergeDescendants({ rows, entries, commanderName, statusOf, isLive })
    } catch {
      return viewRows(rows, statusOf)
    }
  }

  async function spawnTeammate(agent, request = {}) {
    const sub = subagents()
    if (sub === undefined) {
      throw new Error(
        'dsh-commander: 当前 DSH 没有可用的 subagents 服务（需要 0.2.2+ 的 ctx.subagents.startActivation）；请确认 profile 启用了 base/subagent 能力。',
      )
    }
    const signal = ensureAbortSignal(request.signal)
    const prompt = Array.isArray(request.prompt) ? request.prompt : [{ type: 'text', text: String(request.prompt ?? '') }]
    const name = request.name ?? commanderName
    const started = await sub.startActivation({
      provider: request.provider,
      label: request.description ?? request.label ?? commanderName,
      name,
      prompt,
      parent: agent,
      signal,
      // 默认 caller：不做宿主的「完成即唤醒父会话」推送（见文件头 resultDelivery 说明）。
      delivery: request.delivery === 'parent' ? 'parent' : 'caller',
    })
    const startedId = started?.id ?? started?.sessionId ?? started?.childId
    const startedName = typeof started?.name === 'string' && started.name.length > 0 ? started.name : name
    if (typeof startedId === 'string' && startedId.length > 0) {
      const placeholder = { id: startedId, name: startedName, role: 'teammate' }
      placeholder.status = statusOf(startedId) ?? 'provisioning'
      bucket(rootIdOf(agent)).set(startedId, placeholder)
    }
    const found = pickMember(await refresh(agent, signal), startedId ?? startedName)
    return found ?? { id: startedId ?? startedName, name: startedName, role: 'teammate', status: 'provisioning' }
  }

  async function sendMessage(agent, request = {}) {
    const sub = subagents()
    if (sub === undefined || typeof sub.sendMessage !== 'function') {
      throw new Error('dsh-commander: 当前 DSH 的 subagents 服务不可用，无法发送消息。')
    }
    const target = typeof request.target === 'string' && request.target.length > 0 ? request.target : commanderName
    const signal = ensureAbortSignal(request.signal)
    let hit = pickMember(listMembers(agent), target)
    if (hit === undefined) hit = pickMember(await refresh(agent, signal), target)
    if (hit === undefined) {
      const names = listMembers(agent).map((row) => row.name).join('、') || '（无）'
      throw new Error(`dsh-commander: 找不到成员 "${target}"（现有：${names}）；请先 start 或 list。`)
    }
    const content = Array.isArray(request.content) ? request.content : [{ type: 'text', text: String(request.content ?? '') }]
    const messageId = await sub.sendMessage(agent, hit.id, content, { signal })
    return typeof messageId === 'string' ? messageId : undefined
  }

  const liveSubagents = (agent, signal) => listLiveSubagents({ sub: subagents(), rootId: rootIdOf(agent), signal, statusOf })

  return {
    available: () => subagents() !== undefined,
    listMembers,
    membership,
    refresh,
    spawnTeammate,
    sendMessage,
    rootIdOf,
    liveSubagents,
  }
}
