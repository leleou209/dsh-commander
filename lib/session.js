/**
 * 会话事件的两种读法。
 *
 * 别小看这点封装：宿主在「活 Agent」和「只有会话存储」两种情况下 API 不一样，
 * 项目里四处踩过同一个坑（status 说"跟随主会话"、预热读不到、交接摘要为空）。
 * 读事件是高频路径，任何一步抛错都必须当"读不到"，不能让 caller 崩。
 */

/** 活 Agent / 已加载会话：从 fromSeq 起的事件窗口。 */
export function snapshotEvents(session, fromSeq = 0) {
  if (session === undefined || session === null) return []
  try {
    if (typeof session.snapshotEvents !== 'function') return []
    const list = session.snapshotEvents(fromSeq)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 全量读法：先试 `snapshotEvents`，再退回逐条 `eventAt`。
 *
 * 指挥员预热完进入 idle 后 residency 会被释放——`agents.get` 拿不到它，
 * 但 `sessions.get` 里历史还在，这条路就是为那种情况留的。
 */
export function sessionEvents(session) {
  if (session === undefined || session === null) return []
  const snapshot = snapshotEvents(session, 0)
  if (snapshot.length > 0) return snapshot
  const events = []
  try {
    const last = Number(session.seq)
    if (!Number.isFinite(last) || last < 0) return events
    for (let seq = 0; seq <= last; seq += 1) {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
      if (event !== undefined && event !== null) events.push(event)
    }
  } catch {
    return events
  }
  return events
}
