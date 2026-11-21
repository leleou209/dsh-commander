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
 *
 * **但 `caller` 只覆盖我们自己建的那次激活。** 指挥员结算后 residency 会被释放，
 * 之后的发送走宿主的冷恢复路径（`restoreTarget()` → `materialize()`），那里**不传
 * delivery**，于是落回默认的 `"parent"`——实测每轮冷恢复都会给父会话塞一条通知、
 * 白烧一次 turn。所以每次发完都要把那个激活的 delivery 补回 caller（见 pinCallerDelivery）。
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

/**
 * 会话的工作目录。**顺序有讲究**：会话自带的 cwd 最可靠。
 * 宿主的 `workingDirectory.get` 要 **session**（且是同步返回值）；传成 agent 或用错，
 * 就只能一路退到 `process.cwd()`——而 Electron 进程的 cwd 是 profile 目录，
 * 于是 doc/ 被建到那里、指挥员预热读了个空（真踩过）。
 */

/**
 * 会话的工作目录。**顺序有讲究**：会话自带的 cwd 最可靠。
 * 宿主的 `workingDirectory.get` 要 **session**（且是同步返回值）；传成 agent 或用错，
 * 就只能一路退到 `process.cwd()`——而 Electron 进程的 cwd 是 profile 目录，
 * 于是 doc/ 被建到那里、指挥员预热读了个空（真踩过）。
 */
export async function resolveCwd(ctx, agent, signal) {
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

/**
 * 宿主列举 → 成员行。
 *
 * 字段全部按宿主 `SubagentDescendantListEntry` 契约读，别猜：
 *   - `kind: 'child' | 'diagnostic'` —— diagnostic 是读不到的坏分支，跳过；
 *   - `mode: 'one-shot' | 'continuable' | 'external'` —— 只有 continuable 能续接、有名字；
 *   - 名字在 **`path`**（宿主文档：`SubagentActivation.name` 和 listDescendants 行的 `path`
 *     字段都携带完整名称）；`name` 是 optional，只作为兜底；
 *   - `depth` 来自 descendant 行；`activity: 'running' | 'inactive'` 在 catalog 行上。
 */
function toRows(ctx, entries) {
  const rows = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'child' || typeof entry.id !== 'string') continue
    // 不可续接的成员没有持久身份，既不该被当成指挥员，也不该参与"并行子任务还没收口"的等待。
    if (entry.mode !== undefined && entry.mode !== 'continuable') continue
    const name =
      typeof entry.path === 'string' && entry.path.length > 0
        ? entry.path
        : typeof entry.name === 'string'
          ? entry.name
          : ''
    let live
    try {
      live = ctx.get('agents')?.get?.(entry.id)
    } catch {
      live = undefined
    }
    // `agents.get().status` 是当下的执行态（idle/running），比 catalog 的 activity 更准；
    // 拿不到活动的 agent 时退回 activity，再不行就当它不忙。
    const status = live?.status ?? (entry.activity === 'running' ? 'running' : 'inactive')
    rows.push({
      id: entry.id,
      name,
      label: typeof entry.label === 'string' ? entry.label : '',
      status,
      depth: typeof entry.depth === 'number' ? entry.depth : 1,
    })
  }
  return rows
}

/**
 * 列出根会话下的全部可续接子agent。**读不到一律返回 `[]`**（谁都不该因此报错）。
 *
 * 需要区分"确实没有"和"连会话都读不到"的场合，用 {@link listMembersResult}。
 */
export async function listMembers(ctx, rootId, signal) {
  return (await listMembersResult(ctx, rootId, signal)).rows
}

/**
 * 同 {@link listMembers}，但额外回答"这次到底能不能下结论"。
 *
 * **关键区别，弄错过一次：**
 *   - 全新会话**本来就没有** `subagentCatalog` 投影，宿主会抛
 *     `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` 或 `SESSION_QUERY_SESSION_NOT_FOUND`。
 *     这是「还没有子会话」的正常状态，**必须当成"没有指挥员"继续建**；
 *   - 只有当**这个会话本身在当前进程里也读不到**（`sessions.get` 拿不到），
 *     或根本没有 subagents 服务时，才是真的"此刻不能下结论"。
 *
 * 早先把第一种也当成"读不到"直接抛错，结果**新会话永远建不出指挥员**。
 *
 * @returns {{rows: Array, unavailable: boolean, code?: string}}
 */
export async function listMembersResult(ctx, rootId, signal) {
  const sub = subagentsOf(ctx)
  if (sub === undefined || typeof sub.listDescendants !== 'function') return { rows: [], unavailable: true }
  try {
    return { rows: toRows(ctx, await sub.listDescendants(rootId, ensureAbortSignal(signal))), unavailable: false }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    // 会话在不在，问一次存储；问不到才认输。
    let known = false
    try {
      known = ctx.get('sessions')?.get?.(rootId) !== undefined
    } catch {
      known = false
    }
    if (known) return { rows: [], unavailable: false, code }
    return { rows: [], unavailable: true, code }
  }
}

/**
 * 名字匹配：`commander` 或它的编号变体（`commander-2`、`commander-3`…）。
 *
 * 为什么要变体：宿主的子 agent 名字在**父会话**里是唯一的，而 dispose 不会释放它
 * （旧会话仍在磁盘上、身份投影还在），所以同名重建必然报
 * `agent name "commander" is already used by another subagent you created`。
 * 换模型只能新建一个，于是名字只能往上加编号。
 */
function nameMatches(candidate, base) {
  if (candidate === base) return true
  if (typeof candidate !== 'string' || !candidate.startsWith(`${base}-`)) return false
  return /^\d+$/.test(candidate.slice(base.length + 1))
}

/** 找指挥员；找不到返回 undefined。**这是"指挥员在不在"的唯一判据。** */
export async function findCommander(ctx, rootId, name, signal, excluded) {
  const rows = await listMembers(ctx, rootId, signal)
  const skip = excluded instanceof Set ? excluded : undefined
  return rows.find((row) => nameMatches(row.name, name) && (skip === undefined || !skip.has(row.id)))
}

/**
 * 同 {@link findCommander}，但把"查不到"和"确实没有"分开：
 * `{ member, unavailable }`。**建指挥员之前必须用这个**——查不到时不能建，
 * 否则会一遍遍造新指挥员（云端真发生过）。
 */
export async function findCommanderResult(ctx, rootId, name, signal, excluded) {
  const { rows, unavailable, code } = await listMembersResult(ctx, rootId, signal)
  if (unavailable) return { member: undefined, unavailable: true, code }
  const skip = excluded instanceof Set ? excluded : undefined
  return {
    member: rows.find((row) => nameMatches(row.name, name) && (skip === undefined || !skip.has(row.id))),
    unavailable: false,
  }
}

/** 取一个没被占用的名字：优先 base 本身，其次 base-2、base-3… */
export async function pickCommanderName(ctx, rootId, base, signal) {
  const rows = await listMembers(ctx, rootId, signal)
  const used = new Set(rows.map((row) => row.name))
  if (!used.has(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * 建立指挥员。返回 `{ id, name, dispose? }`。
 *
 * **`dispose` 必须留住。** 宿主的 `SubagentActivation` 是唯一能销毁这个子会话的东西
 * （文档：*the published handle cancels and reaches quiescence through dispose()*；
 * `Agent` 上只有 `cancel()`，`subagents` 服务也没有删除方法）。
 * 早先这里只取了 id 就把它扔了，导致插件**从来没有**销毁指挥员的能力——
 * 想换模型重建时只能去界面里手动归档。
 *
 * 注意：只有**本次进程内创建**的才有 handle。重启后靠 `findCommander` 认领的成员
 * 只能拿到 catalog 行，拿不到 handle，因此永远无法由插件销毁。
 *
 * `delivery: 'caller'` 是刻意的，见文件头。要回到"宿主替我播报完成"的旧行为，
 * 显式传 delivery:'parent' —— 但那会让主会话在每次预热结束后自动开工。
 *
 * `agentOptions` 用来给指挥员指定**独立的 LLM 路由**（provider / model / reasoningEffort）。
 * 不传就继承主会话。注意：只有 spawn 后端理会它；fork 为保住 KV cache 会主动丢弃。
 */
export async function spawnCommander(ctx, input = {}) {
  const sub = subagentsOf(ctx)
  if (sub === undefined || typeof sub.startActivation !== 'function') {
    throw new Error('当前 DSH 没有可用的 subagents 服务（需要 0.2.2+）；请确认 profile 启用了 subagent 能力。')
  }
  // 宿主 0.2.2 的 `startActivation` 收**扁平**参数：parent / prompt / maxDepth 都在顶层
  // （0.2.1 是嵌套的 `{ request: {...} }`，已不再支持）。
  const spec = {
    provider: input.provider,
    name: input.name,
    // label 绝不能是 undefined：宿主要把它写进子会话 descriptor，undefined 过不了 JSON 往返。
    label: input.label ?? input.name,
    prompt: [{ type: 'text', text: String(input.prompt ?? '') }],
    parent: input.agent,
    delivery: input.delivery === 'parent' ? 'parent' : 'caller',
    signal: ensureAbortSignal(input.signal),
    // 深度：明确给，别让宿主去读它自己的配置（某些 profile 里 subagent 插件的 config
    // 没被注入，走兜底会抛 Cannot read properties of undefined）。
    // 传 1 = 指挥员本身在第 1 层、且不再往下派（它的工具面本来也不允许）。
    maxDepth: input.maxDepth ?? 1,
  }
  if (typeof sub.resolveMaxDepth === 'function') {
    spec.maxDepth = sub.resolveMaxDepth(spec.maxDepth) ?? spec.maxDepth
  }
  if (input.agentOptions !== undefined && input.agentOptions !== null) spec.agentOptions = input.agentOptions
  const started = await sub.startActivation(spec)
  const id = started?.id ?? started?.childId ?? started?.sessionId
  if (typeof id !== 'string' || id.length === 0) throw new Error('宿主没有返回指挥员的会话 id')
  const member = { id, name: typeof started?.name === 'string' ? started.name : input.name }
  if (typeof started?.dispose === 'function') {
    // 包一层：调用方不必知道句柄长什么样，也不会拿到一个能乱用的对象。
    member.dispose = () => started.dispose()
  }
  return member
}

/** 给指挥员发消息（async）。 */
/** 真正持有 resident 的是服务内部的 manager，不是服务本身（服务上的 resident 是 undefined）。 */
const managerOf = (sub) => [sub?.manager, sub].find(
  (candidate) => typeof candidate?.resident?.get === 'function',
)

/**
 * 把这次交付所用激活的 `delivery` 补回 `'caller'`。
 *
 * 宿主的冷恢复路径 `restoreTarget()` → `materialize()` **不传 delivery**，
 * 于是恢复出来的激活是默认的 `"parent"`；它结算时 `notifySettlement()` 就会
 * 往父会话塞 `subagent-settled` 并**开新一轮**——实测每咨询一次白烧一轮。
 *
 * 这里不去改宿主的交付流程（抢先恢复会让它走别的准入分支，实测会卡住），
 * 而是在 `sendMessage` 返回后、子会话结算**之前**把这个字段改回来：
 * 结算发生在子会话跑完一整轮之后（数秒以上），而 sendMessage 是立刻返回的。
 *
 * 只改内存里的一个字段，不写任何会话事件：宿主换实现时最坏退化成"又收到通知"。
 */
function pinCallerDelivery(sub, targetId) {
  try {
    const activation = managerOf(sub)?.resident?.get?.(targetId)
    if (activation !== null && typeof activation === 'object' && activation.delivery === 'parent') {
      activation.delivery = 'caller'
    }
  } catch {
    // 拿不到就算了：最坏结果是又收到一条通知，不影响消息本身。
  }
}

export async function sendToCommander(ctx, agent, targetId, text, signal) {
  const sub = subagentsOf(ctx)
  if (sub === undefined || typeof sub.sendMessage !== 'function') {
    throw new Error('当前 DSH 的 subagents 服务不可用，无法发送消息。')
  }
  const abort = ensureAbortSignal(signal)
  const sent = await sub.sendMessage(agent, targetId, [{ type: 'text', text }], { signal: abort })
  pinCallerDelivery(sub, targetId)
  return sent
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
