/**
 * 咨询握手：发请求（登记 pending）+ 等回复。**工具层与交接驱动共用同一套。**
 *
 * 为什么必须共用：驱动如果自己另写一份等待，两边对「什么算回复」的判定就会漂移。
 * 回复一律从指挥员**自己的会话日志**取，并用 [REQ id] 对齐 —— 不依赖宿主的完成推送
 * （那条推送已被 delivery:'caller' 关掉，正是它让主会话在预热后自动开工）。
 */

import { newRequestId, parseRequestId } from './protocol.js'
import { lastAssistantText } from './driver.js'

const sessionOf = (ctx, id) => {
  try {
    return ctx.get('sessions')?.get?.(id)
  } catch {
    return undefined
  }
}

/**
 * 发一次咨询：登记 pending → 带请求号发出。
 * @returns {Promise<{requestId: string, commanderId: string}>}
 */
export async function sendConsult(app, agent, text, signal) {
  const rootId = app.rootIdOf(agent)
  const member = await app.findCommander(rootId, signal)
  if (member === undefined) throw new Error('指挥员还没建立；先 commander(action="start")。')
  const requestId = newRequestId()
  const session = sessionOf(app.ctx, member.id)
  app.store.setPending(rootId, {
    requestId,
    commanderId: member.id,
    sentAt: Date.now(),
    processId: process.pid,
    baselineSeq: session?.seq ?? 0,
  })
  app.consulted.add(rootId)
  await app.sendRaw(agent, member.id, `[REQ ${requestId}]\n${text}`, signal)
  return { requestId, commanderId: member.id }
}

/**
 * 等回复。判定顺序：脏 pending → 已缓存回复 → 成员 failed →
 * 会话里已有匹配回复 → 订阅 session/event 等（带超时与中断）。
 *
 * @returns {Promise<{kind: 'reply'|'stale'|'failed'|'timeout', text?: string, requestId?: string}>}
 */
export async function waitReply(app, agent, requestId, signal) {
  const { ctx, store, config } = app
  const rootId = app.rootIdOf(agent)
  const pending = store.pending(rootId)
  if (pending === undefined) throw new Error('没有未完成的咨询请求；先用 commander(action="say") 发起。')
  if (typeof requestId === 'string' && requestId.length > 0 && requestId !== pending.requestId) {
    throw new Error(`requestId 不匹配（当前 pending 是 ${pending.requestId}）。`)
  }
  // 上个进程遗留的请求：回复永远不会再来，别让 wait 永久阻塞。
  if (pending.processId !== process.pid) {
    store.deletePending(rootId)
    return { kind: 'stale', text: `请求 ${pending.requestId} 属于上一个进程，已清理。` }
  }
  if (typeof pending.lastReply?.text === 'string' && pending.lastReply.text.length > 0) {
    store.deletePending(rootId)
    return { kind: 'reply', text: pending.lastReply.text, requestId: pending.requestId }
  }
  const member = await app.findCommander(rootId, signal)
  if (member?.status === 'failed') {
    store.deletePending(rootId)
    return { kind: 'failed', text: '指挥员状态为 failed，请求已终止。' }
  }

  const match = (session) => {
    const text = lastAssistantText(session, 0, pending.sentAt)
    if (text.length === 0) return undefined
    return parseRequestId(text) === pending.requestId ? text : undefined
  }
  const already = match(sessionOf(ctx, pending.commanderId))
  if (already !== undefined) {
    store.deletePending(rootId)
    return { kind: 'reply', text: already, requestId: pending.requestId }
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let off
    let timer
    const cleanup = () => {
      off?.()
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('等待被中断；pending 已保留，可再次 wait 恢复。'))
    }
    try {
      off = ctx.on('session/event', (session, event) => {
        if (session?.id !== pending.commanderId || event?.type !== 'turn/end') return
        const text = match(session)
        if (text === undefined) return
        store.deletePending(rootId)
        finish({ kind: 'reply', text, requestId: pending.requestId })
      })
    } catch {
      off = undefined
    }
    timer = setTimeout(() => finish({ kind: 'timeout' }), config.waitMs)
    timer.unref?.()
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
