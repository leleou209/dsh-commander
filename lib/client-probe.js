/**
 * 客户端自证探针（2.9.56）：让「图标在不在、卡在哪一层」不靠用户开 F12。
 *
 * 事件只有四类：load（模块加载）/ ready（首帧拿到状态）/ render-error / fetch-error。
 * 只记**元信息**（事件名、sessionId 来源、错误摘要、时间），不记任何会话内容；
 * 请求体上限 4KB，落盘环形 200 行，`GET` 回最近 20 条。
 *
 * 硬约束：**任何失败都不许 500**——目录不可写就降级为内存 + 一条 warn，
 * 探针自身的故障不能反过来影响接管功能。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PROBE_MAX_BODY = 4096
export const PROBE_MAX_LINES = 200
export const PROBE_GET_LIMIT = 20
export const PROBE_EVENTS = ['load', 'ready', 'render-error', 'fetch-error']

/** 只保留白名单字段，其余一律丢弃（防止把用户内容写进探针）。 */
export function sanitizeProbeEvent(input = {}) {
  const event = PROBE_EVENTS.includes(input?.event) ? input.event : 'unknown'
  const source = typeof input?.sessionSource === 'string' ? input.sessionSource.slice(0, 40) : undefined
  const error = typeof input?.error === 'string' ? input.error.slice(0, 200) : undefined
  const hasSession = input?.hasSession === true || typeof input?.sessionId === 'string'
  const entry = { at: new Date().toISOString(), event }
  if (source) entry.sessionSource = source
  if (error) entry.error = error
  entry.hasSession = hasSession === true
  return entry
}

/** 环形写入：超过上限就重写成最后 N 行（文件本来就小，直接重写最省事）。 */
export async function appendProbeLine(path, line, maxLines = PROBE_MAX_LINES) {
  let lines = []
  try {
    const text = await readFile(path, 'utf8')
    lines = text.split(/\r?\n/).filter((row) => row.length > 0)
  } catch {
    lines = []
  }
  lines.push(line)
  const kept = lines.slice(-maxLines)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8')
  return kept.length
}

/**
 * 探针处理器。`handle(req, res, url)` 永不抛错、永不 500。
 * 目录不可写时降级到内存（只有本次进程内可读），并只记一条 warn。
 */
export function createClientProbe({ file, log = console.warn, maxLines = PROBE_MAX_LINES } = {}) {
  const path = file ?? join(homedir(), '.dsh', 'commander', 'client-probe.jsonl')
  const memory = []
  let degraded = false

  const remember = (entry) => {
    memory.push(entry)
    if (memory.length > maxLines) memory.splice(0, memory.length - maxLines)
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > PROBE_MAX_BODY) req.destroy()
      })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(''))
    })
  }

  async function handle(req, res, url) {
    const send = (body, status = 200) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(payload)
    }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (degraded) return send({ degraded: true, entries: memory.slice(-PROBE_GET_LIMIT) })
        let lines = []
        try {
          const text = await readFile(path, 'utf8')
          lines = text.split(/\r?\n/).filter((row) => row.length > 0)
        } catch {
          lines = []
        }
        const entries = lines.slice(-PROBE_GET_LIMIT).map((row) => {
          try {
            return JSON.parse(row)
          } catch {
            return { malformed: true }
          }
        })
        return send({ degraded: false, count: lines.length, entries })
      }
      if (req.method !== 'POST') return send({ error: 'method not allowed' }, 405)
      const raw = await readBody(req)
      if (raw.length > PROBE_MAX_BODY) return send({ error: 'too large', limit: PROBE_MAX_BODY }, 413)
      let parsed
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        return send({ error: 'invalid json' }, 400)
      }
      const entry = sanitizeProbeEvent(parsed)
      remember(entry)
      if (!degraded) {
        try {
          await appendProbeLine(path, JSON.stringify(entry), maxLines)
        } catch (error) {
          degraded = true
          log('[dsh-commander] client-probe 落盘失败，已降级为内存：', error && error.message ? error.message : error)
        }
      }
      return send({ ok: true, degraded })
    } catch (error) {
      // 探针自身故障也不许影响宿主：回执失败原因，状态码仍是 200。
      log('[dsh-commander] client-probe 处理失败：', error && error.message ? error.message : error)
      return send({ ok: false, error: 'probe-failed' })
    }
  }

  return { handle, path, readMemory: () => memory.slice(), isDegraded: () => degraded }
}

/** 模块级单例：路由接线只需要一行。 */
export const clientProbe = createClientProbe()
