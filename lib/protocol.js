/**
 * 指挥员↔主agent 的文本协议（纯函数）。
 *
 * 三个令牌刻意保持中文原样：它们是**契约**，不是 UI 文案，不参与任何翻译。
 *   [REQ <id>]              请求号，把回复和 pending 对上
 *   决定：继续 / 需澄清 / 允许结束
 *   批准：goal <动作>        一次性批准
 *   允许结束                 放行 goal complete
 */

const RELEASE_TOKEN = '允许结束'

/**
 * 契约头块：从开头到第一个空行之间的行。
 *
 * 决定/批准只在这个块里生效。正文里引用一句「决定：允许结束」是**说明**，
 * 不是命令——曾经把正文里的引用当成放行/批准，等于让一段解释文字改掉门禁。
 */
export function headerBlock(text) {
  const head = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim().length === 0) break
    head.push(line)
  }
  return head
}

/** 从文本里取请求号；取不到返回 undefined。 */
export function parseRequestId(text) {
  const match = /\[REQ\s+([^\]\s]+)\s*\]/.exec(String(text ?? ''))
  return match ? match[1] : undefined
}

/**
 * 解析决议行。允许行尾带说明（「决定：继续（理由…）」）。
 * 只认头块，见 headerBlock。
 * @returns {'finish'|'clarify'|'continue'|undefined}
 */
export function parseDecision(text) {
  const body = String(text ?? '')
  const line = headerBlock(body).find((row) => /^\s*决定\s*[：:]/.test(row))
  if (line === undefined) return undefined
  const value = line.replace(/^\s*决定\s*[：:]\s*/, '').trim()
  if (value.startsWith(RELEASE_TOKEN)) return 'finish'
  if (value.startsWith('需澄清')) return 'clarify'
  if (value.startsWith('继续')) return 'continue'
  return undefined
}

/**
 * 回复分类：驱动只关心「要不要停」。
 * 缺决议行时按继续处理——指挥员偶尔忘写格式，不该因此把任务卡死。
 */
export function classifyReply(text) {
  return parseDecision(text) === 'finish' ? 'finish' : 'continue'
}

/** 解析一次性 goal 批准（可多条，逗号/空格分隔）。只认头块。 */
export function parseGoalApprovals(text) {
  const found = new Set()
  const body = headerBlock(text).join('\n')
  const pattern = /批准\s*[：:]\s*goal\s+([a-z,\s]+)/gi
  let match = pattern.exec(body)
  while (match !== null) {
    for (const token of match[1].split(/[,\s]+/)) {
      const action = token.trim().toLowerCase()
      if (action.length > 0) found.add(action)
    }
    match = pattern.exec(body)
  }
  return found
}

/** 文本里是否给了「允许结束」放行：只认头块（正文里的引用不算）。 */
export function hasRelease(text) {
  if (parseDecision(text) === 'finish') return true
  return headerBlock(text).join('\n').includes(RELEASE_TOKEN)
}

/** 生成一个请求号。 */
export function newRequestId(random = Math.random) {
  return `req-${random().toString(16).slice(2, 10)}-${Date.now().toString(36)}`
}
