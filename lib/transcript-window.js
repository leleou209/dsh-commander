/**
 * transcript-window — 把 UI 初始会话历史收敛到「最近 N 个 turn」的 Host 侧伴生插件。
 *
 * 原理：客户端加载历史走 `sessionController.events` / `observeEvent`（RPC 落到这两个方法），
 * 请求里的 `turnWindow.minTurns/minMessages` 是**最小值**，`maxMessages` 才是**上限**。
 *
 * 2.9.3 的旧实现只把 `minTurns` 抬到 15 —— 那只会让服务端“至少给 15 个 turn”，
 * 永远不能减少返回量，所以看起来毫无效果。这里改成**只向下压**：
 *   - maxMessages   = min(客户端值, 目标上限)
 *   - minTurns      = min(客户端值, turns)
 *   - minMessages   = min(客户端值, 目标上限)
 * 客户端要得更少就照办，绝不向上放宽。
 *
 * 不删除 session log，不改变模型上下文；更早的历史仍可按页向前加载。
 */
import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_MAX_BYTES = 64 * 1024

/** 把客户端要的窗口压到目标窗口（只压不放）。 */
export function clampRequest(request, options = {}) {
  if (!request || typeof request !== 'object') return request
  const turns = Number.isSafeInteger(options.turns) && options.turns > 0 ? options.turns : 15
  const messagesPerTurn =
    Number.isSafeInteger(options.messagesPerTurn) && options.messagesPerTurn > 0 ? options.messagesPerTurn : 2
  // 留一点余量，避免把当前 turn 截断
  const cap = Math.max(4, turns * messagesPerTurn + 4)

  const window = request.turnWindow && typeof request.turnWindow === 'object' ? request.turnWindow : {}
  const pick = (value) => (Number.isFinite(value) && value > 0 ? value : undefined)
  const clientMax = pick(Number(request.maxMessages))
  const clientMinTurns = pick(Number(window.minTurns))
  const clientMinMessages = pick(Number(window.minMessages))

  const nextMax = Math.min(clientMax ?? cap, cap)
  return {
    ...request,
    maxMessages: nextMax,
    turnWindow: {
      ...window,
      minTurns: Math.min(clientMinTurns ?? turns, turns),
      minMessages: Math.min(clientMinMessages ?? nextMax, nextMax),
    },
  }
}

/** 调试用：把每次真实请求的前后参数追加到日志（超过 64KB 自动轮转）。 */
async function appendDebugLog(line) {
  try {
    const dir = join(homedir(), '.dsh', 'commander')
    const file = join(dir, 'transcript-window.log')
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await fsp.stat(file).catch(() => undefined)
    if (info && info.size > LOG_MAX_BYTES) await fsp.rename(file, `${file}.1`).catch(() => {})
    await fsp.appendFile(file, line + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 日志失败不影响主流程
  }
}

/** 在服务就绪的作用域里执行；没有 inject 时退回直接读取（老宿主/测试环境）。 */
function whenSessionControllerReady(ctx, run) {
  const resolveService = (scoped) =>
    scoped?.sessionController ?? scoped?.get?.('sessionController') ?? ctx.get?.('sessionController')
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['sessionController'], (scoped) => {
        const service = resolveService(scoped)
        if (!service) {
          ctx.logger?.warn?.('dsh-commander: transcript-window 注入后仍拿不到 sessionController，历史窗口未生效')
          return
        }
        run(service, typeof scoped?.effect === 'function' ? scoped : ctx)
      })
      return
    } catch (error) {
      ctx.logger?.warn?.(`dsh-commander: transcript-window 注入失败（${error?.message ?? error}），退回直接读取`)
    }
  }
  const service = resolveService(ctx)
  if (!service) {
    ctx.logger?.warn?.('dsh-commander: transcript-window 未找到 sessionController，历史窗口未生效')
    return
  }
  run(service, ctx)
}

export function apply(ctx, config = {}) {
  // 默认开启：它是纯读取侧的窗口收敛，不写、不删、不改模型上下文。
  if (config.enabled === false) return
  const turns = Number.isSafeInteger(config.turns) && config.turns > 0 ? config.turns : 15
  const messagesPerTurn =
    Number.isSafeInteger(config.messagesPerTurn) && config.messagesPerTurn > 0 ? config.messagesPerTurn : 2
  const debug = config.debug === true

  whenSessionControllerReady(ctx, (service, scope) => scope.effect(() => {
    const patched = []
    for (const method of ['events', 'observeEvent']) {
      const original = service[method]
      if (typeof original !== 'function' || original.__transcriptWindow === true) continue
      const wrapped = function transcriptWindowRequest(request, ...rest) {
        const next = clampRequest(request, { turns, messagesPerTurn })
        if (debug) {
          const before = { maxMessages: request?.maxMessages, turnWindow: request?.turnWindow }
          const after = { maxMessages: next?.maxMessages, turnWindow: next?.turnWindow }
          appendDebugLog(
            JSON.stringify({
              at: new Date().toISOString(),
              method,
              before,
              after,
              shrank:
                before.maxMessages !== after.maxMessages ||
                before.turnWindow?.minTurns !== after.turnWindow?.minTurns ||
                before.turnWindow?.minMessages !== after.turnWindow?.minMessages,
            }),
          ).catch(() => {})
        }
        return original.call(service, next, ...rest)
      }
      wrapped.__transcriptWindow = true
      service[method] = wrapped
      patched.push([method, original])
    }
    if (patched.length === 0) {
      ctx.logger?.warn?.('dsh-commander: sessionController 上没有可包装的 events/observeEvent')
    } else {
      // 把生效参数挂到 service 上，status/doctor 才能显示真实数字
      service.__transcriptWindowConfig = { turns, messagesPerTurn, cap: turns * messagesPerTurn + 4 }
      ctx.logger?.info?.(
        `dsh-commander: 历史窗口已挂载（${patched.map(([name]) => name).join(', ')}；${turns} turn / ${turns * messagesPerTurn + 4} 条上限）`,
      )
    }
    return () => {
      for (const [method, original] of patched) service[method] = original
      if (patched.length > 0) delete service.__transcriptWindowConfig
    }
  }))
}