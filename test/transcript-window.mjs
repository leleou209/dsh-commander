// transcript-window 离线验证：把历史页请求「只压不放」，不改数据、不改模型上下文。
import assert from 'node:assert/strict'
import { apply, clampRequest } from '../transcript-window.js'

// ---- 纯函数：只向下压 ----
const CAP = 15 * 2 + 4 // 34

let out = clampRequest({ maxMessages: 5000, turnWindow: { minTurns: 100, minMessages: 5000 } })
assert.equal(out.maxMessages, CAP, 'maxMessages 必须压到上限')
assert.equal(out.turnWindow.minTurns, 15, 'minTurns 压到 15')
assert.equal(out.turnWindow.minMessages, CAP, 'minMessages 不得超过 maxMessages')

out = clampRequest({ maxMessages: 20, turnWindow: { minTurns: 3, minMessages: 10 } })
assert.equal(out.maxMessages, 20, '客户端要得更少时照办，不能放大')
assert.equal(out.turnWindow.minTurns, 3)
assert.equal(out.turnWindow.minMessages, 10)

out = clampRequest({})
assert.equal(out.maxMessages, CAP, '没写 maxMessages 时补上限')
assert.equal(out.turnWindow.minTurns, 15)

out = clampRequest({ beforeSeq: 123 })
assert.equal(out.beforeSeq, 123, '其它字段原样保留')

assert.equal(clampRequest(undefined), undefined, '空请求直接返回')

// 自定义 turns
out = clampRequest({ maxMessages: 999 }, { turns: 5, messagesPerTurn: 2 })
assert.equal(out.maxMessages, 14)
assert.equal(out.turnWindow.minTurns, 5)

// ---- 真正替换服务方法 ----
const calls = []
const service = {
  async events(request, signal) {
    calls.push({ method: 'events', request })
    return { records: [] }
  },
  async observeEvent(request, signal) {
    calls.push({ method: 'observeEvent', request })
    return []
  },
}
const ctx = {
  effect(fn) {
    return fn()
  },
  get(name) {
    return name === 'sessionController' ? service : undefined
  },
}
apply(ctx, { turns: 15 })
assert.equal(service.events.__transcriptWindow, true, 'events 被包装')
assert.equal(service.observeEvent.__transcriptWindow, true, 'observeEvent 被包装')

const original = service.events
await service.events({ maxMessages: 5000, turnWindow: { minTurns: 100, minMessages: 5000 } })
await service.observeEvent({ maxMessages: 20, turnWindow: { minTurns: 2 } })
assert.equal(calls[0].request.maxMessages, CAP)
assert.equal(calls[0].request.turnWindow.minTurns, 15)
assert.equal(calls[1].request.maxMessages, 20, '小上限请求不被放大')
assert.equal(calls[1].request.turnWindow.minTurns, 2)

// enabled:false 时完全不挂载
const fresh = { events: async () => [], observeEvent: async () => [] }
apply({ effect: (fn) => fn(), get: () => fresh }, { enabled: false })
assert.equal(fresh.events.__transcriptWindow, undefined, 'enabled:false 时不包装')

// 卸载后恢复原方法
let dispose
const ctx2 = {
  effect(fn) {
    dispose = fn()
    return dispose
  },
  get: () => service,
}
const beforePatch = service.events
apply(ctx2, { turns: 15 })
dispose()
assert.equal(service.events, beforePatch, '卸载后方法应恢复')

// 服务晚到：用 ctx.inject 等它就绪后再挂载
{
  let fire = undefined
  const lateService = {
    events: async () => [],
    observeEvent: async () => [],
  }
  const lateCtx = {
    logger: { warn() {}, info() {} },
    effect: (fn) => fn(),
    get: () => undefined,
    inject(deps, cb) {
      assert.deepEqual(deps, ['sessionController'])
      fire = () => cb({ sessionController: lateService, effect: (fn) => fn() })
    },
  }
  apply(lateCtx, { turns: 15 })
  assert.equal(lateService.events.__transcriptWindow, undefined, '服务没到时不该假装挂载')
  assert.equal(typeof fire, 'function', '应当通过 inject 等 service 就绪')
  fire()
  assert.equal(lateService.events.__transcriptWindow, true, '服务晚到也能挂上')
  assert.equal(lateService.__transcriptWindowConfig.turns, 15)
}

// 注入后仍拿不到服务：只落日志，不抛
{
  const warns = []
  const noServiceCtx = {
    logger: { warn: (message) => warns.push(message), info() {} },
    effect: (fn) => fn(),
    get: () => undefined,
    inject: (_deps, cb) => cb({ effect: (fn) => fn() }),
  }
  apply(noServiceCtx, { turns: 15 })
  assert.ok(warns.some((line) => line.includes('拿不到 sessionController')), '必须落日志而不是静默')
}

console.log('TRANSCRIPT WINDOW CHECKS PASSED')