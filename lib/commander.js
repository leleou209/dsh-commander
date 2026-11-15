/**
 * 指挥员的建立 / 查找 / 工具面收紧。**全部 async，不缓存成员。**
 *
 * 这是相对老包最大的一处简化：老包为了维持同步 `listMembers()`，维护了按根会话的
 * 成员缓存 + 刷新 + 幽灵行清理 + 有界刷新 + 负缓存（279 行），而那个缓存重启即空，
 * 直接造成「重启后图标不认指挥员」。这里每次按需向宿主查一次，没有缓存就没有冷缓存。
 *
 * spawn 一律 `delivery: 'caller'`：宿主的 `notifySettlement()` 只在非 caller 时
 * 往父会话收件箱塞 `subagent-settled` 并**开新一轮**。指挥员的回复由本包自己从
 * 它的会话日志取（见 tools.js 的 wait），不需要宿主代转，所以关掉那条推送。
 */

import { ensureAbortSignal } from './gate.js'

/** 沿 parentSession 上溯到根会话 id；取不到父会话时停在最后一个已知 id。 */
export function rootIdOf(ctx, agent) {
  let header = agent?.session?.header
  let id = header?.id ?? agent?.id
  let depth = 0
  while (header?.parentSession && depth < 32) {
    id = header.parentSession
    depth += 1
    try {
      header = ctx.get('sessions')?.get?.(header.parentSession)?.header
    } catch {
      break
    }
  }
  return id
}

const subagentsOf = (ctx) => {
  try {
    return ctx.get('subagents')
  } catch {
    return undefined
  }
}

/** 宿主列举 → 成员行（只保留必要字段，实时补 status）。 */
function toRows(ctx, entries) {
  const rows = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'child' || typeof entry.id !== 'string') continue
    let status
    try {
      status = ctx.get('agents')?.get?.(entry.id)?.status
    } catch {
      status = undefined
    }
    rows.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : '',
      label: typeof entry.label === 'string' ? entry.label : '',
      status: status ?? 'inactive',
      depth: typeof entry.depth === 'number' ? entry.depth : 1,
    })
  }
  return rows
}

/** 列出根会话下的全部可续接子agent（async，无缓存）。 */
export async function listMembers(ctx, rootId, signal) {
  const sub = subagentsOf(ctx)
  if (sub === undefined || typeof sub.listDescendants !== 'function') return []
  try {
    return toRows(ctx, await sub.listDescendants(rootId, ensureAbortSignal(signal)))
  } catch {
    return []
  }
}

/** 找指挥员；找不到返回 undefined。**这是"指挥员在不在"的唯一判据。** */
export async function findCommander(ctx, rootId, name, signal) {
  const rows = await listMembers(ctx, rootId, signal)
  return rows.find((row) => row.name === name)
}

/**
 * 建立指挥员。返回宿主给的成员标识。
 *
 * `delivery: 'caller'` 是刻意的，见文件头。要回到"宿主替我播报完成"的旧行为，
 * 显式传 delivery:'parent' —— 但那会让主会话在每次预热结束后自动开工。
 */
export async function spawnCommander(ctx, input = {}) {
  const sub = subagentsOf(ctx)
  if (sub === undefined || typeof sub.startActivation !== 'function') {
    throw new Error('当前 DSH 没有可用的 subagents 服务（需要 0.2.2+）；请确认 profile 启用了 subagent 能力。')
  }
  const started = await sub.startActivation({
    provider: input.provider,
    label: input.label ?? input.name,
    name: input.name,
    prompt: [{ type: 'text', text: String(input.prompt ?? '') }],
    parent: input.agent,
    signal: ensureAbortSignal(input.signal),
    delivery: input.delivery === 'parent' ? 'parent' : 'caller',
  })
  const id = started?.id ?? started?.childId ?? started?.sessionId
  if (typeof id !== 'string' || id.length === 0) throw new Error('宿主没有返回指挥员的会话 id')
  return { id, name: typeof started?.name === 'string' ? started.name : input.name }
}

/** 给指挥员发消息（async）。 */
export async function sendToCommander(ctx, agent, targetId, text, signal) {
  const sub = subagentsOf(ctx)
  if (sub === undefined || typeof sub.sendMessage !== 'function') {
    throw new Error('当前 DSH 的 subagents 服务不可用，无法发送消息。')
  }
  return sub.sendMessage(agent, targetId, [{ type: 'text', text }], { signal: ensureAbortSignal(signal) })
}

/**
 * 收紧指挥员工具面：只读全盘 + 只读 shell + 写仅限指定作用域。
 * @returns {(() => void)|undefined} disposer
 */
export function restrictCommander(agent, allow) {
  try {
    return agent.ctx.tools.restrict({ allow })
  } catch {
    return undefined
  }
}

/** 并列子agent 是否还在跑（指挥员自己不算）：全接管交接要等它们收口。 */
export async function subtreeBusy(ctx, rootId, commanderIds, signal) {
  const rows = await listMembers(ctx, rootId, signal)
  return rows.some((row) => !commanderIds.has(row.id) && (row.status === 'running' || row.status === 'provisioning'))
}
