/**
 * 初始化流程单测（2.9.57 重写）。
 *
 * 用户口径（2.9.57）：
 *   初始化 = 建立并绑定指挥员 + 让它预热 + 落默认挡位 observe，然后**停住**。
 *   不读输入框草稿、不建 goal、不发契约、不往主会话投递；模式和任务由用户随后自己决定。
 *
 * 这里覆盖：三态转移、默认挡位、启动成功/失败落账、以及"初始化不产生连续行为"的静态断言。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createPhaseTracker,
  ICON_PHASES,
  INIT_DEFAULT_STATE,
  planInit,
  runInitFlow,
  startWithPhase,
} from '../lib/init-flow.js'
import { summarizePreheat, sumPreheatTokens } from '../lib/preheat.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('三态与默认挡位：none / provisioning / ready，默认 observe', () => {
  assert.deepEqual(ICON_PHASES, ['none', 'provisioning', 'ready'])
  assert.equal(INIT_DEFAULT_STATE, 'observe')
})

check('相位只由事件转移：start→provisioning，绑定成功→ready，超时→failed', () => {
  let clock = 1_000
  const tracker = createPhaseTracker({ now: () => clock, timeoutMs: 90_000 })
  assert.equal(tracker.phaseOf({ sessionId: 's1', hasCommander: false }), 'none')
  tracker.markStart('s1')
  assert.equal(tracker.phaseOf({ sessionId: 's1', hasCommander: false }), 'provisioning')
  tracker.markReady('s1')
  assert.equal(tracker.phaseOf({ sessionId: 's1', hasCommander: true }), 'ready')
  tracker.markStart('s2')
  clock += 90_001
  assert.equal(tracker.phaseOf({ sessionId: 's2', hasCommander: false }), 'failed')
  assert.equal(tracker.read('s2').lastError.includes('90'), true)
  assert.equal(tracker.phaseOf({ sessionId: 'legacy', hasCommander: true }), 'ready')
})

check('planInit：只有 none 能初始化；ready / in-flight 一律拒绝', () => {
  assert.equal(planInit({ phase: 'ready' }).allowed, false)
  assert.equal(planInit({ phase: 'ready' }).reason, 'already-ready')
  assert.equal(planInit({ phase: 'provisioning' }).reason, 'in-flight')
  const ok = planInit({ phase: 'none' })
  assert.equal(ok.allowed, true)
  assert.equal(ok.state, 'observe', '初始化后默认不接管')
  assert.equal('draft' in ok, false, '初始化不再带草稿')
})

check('startWithPhase：绑定成功即 ready（不等 90 秒）', async () => {
  const tracker = createPhaseTracker({ now: () => 1_000, timeoutMs: 90_000 })
  tracker.markStart('s1')
  await startWithPhase({ start: async () => {}, tracker, id: 's1' })
  assert.equal(tracker.phaseOf({ sessionId: 's1', hasCommander: true }), 'ready')
})

check('startWithPhase：启动抛错先落 failed+lastError 再抛', async () => {
  const tracker = createPhaseTracker({ now: () => 1_000, timeoutMs: 90_000 })
  tracker.markStart('s2')
  await assert.rejects(
    () => startWithPhase({ start: async () => { throw new Error('spawn boom') }, tracker, id: 's2' }),
    /spawn boom/,
  )
  assert.equal(tracker.phaseOf({ sessionId: 's2', hasCommander: false }), 'failed')
  assert.match(tracker.read('s2').lastError, /spawn boom/)
})

check('runInitFlow：无指挥员 → 启动 + 落 observe；**不投递任何消息**', async () => {
  const calls = []
  const result = await runInitFlow({
    phase: 'none',
    hasCommander: false,
    start: async () => calls.push('start'),
    setState: async (state) => calls.push(`state:${state}`),
    // 旧实现会调 deliver；新实现若仍调用它，这条会立刻炸出来
    deliver: () => {
      throw new Error('初始化不应投递任何消息')
    },
  })
  assert.deepEqual(calls, ['start', 'state:observe'])
  assert.equal(result.started, true)
  assert.equal('delivered' in result, false, '返回值里不应再有 delivered')
})

check('runInitFlow：已有指挥员 → 只落挡位，不再启动', async () => {
  const calls = []
  const result = await runInitFlow({
    phase: 'none',
    hasCommander: true,
    start: async () => calls.push('start'),
    setState: async (state) => calls.push(`state:${state}`),
  })
  assert.deepEqual(calls, ['state:observe'])
  assert.equal(result.started, false)
})

check('runInitFlow：启动失败返回 start-failed，且不落挡位', async () => {
  const calls = []
  const result = await runInitFlow({
    phase: 'none',
    hasCommander: false,
    start: async () => { throw new Error('spawn boom') },
    setState: async (state) => calls.push(`state:${state}`),
  })
  assert.equal(result.reason, 'start-failed')
  assert.match(result.message, /spawn boom/)
  assert.deepEqual(calls, [])
})

check('runInitFlow：ready / provisioning 直接拒绝，无副作用', async () => {
  for (const phase of ['ready', 'provisioning']) {
    const calls = []
    const result = await runInitFlow({
      phase,
      start: async () => calls.push('start'),
      setState: async () => calls.push('state'),
    })
    assert.equal(result.started, false)
    assert.deepEqual(calls, [])
  }
})

check('初始化不产生连续行为：宿主 init 分支没有草稿/投递/goal/契约', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = source.indexOf("payload?.init === true")
  assert.ok(start > 0, '找不到 init 分支')
  // 只取 init 分支本身：到下一个「通用 POST（切挡位）」分支之前为止。
  const nextBranch = source.indexOf("if (req.method === 'POST') {", start)
  const block = source.slice(start, nextBranch > start ? nextBranch : start + 1200)
  assert.ok(block.length > 200, 'init 分支切片太短，断言会失真')
  assert.ok(!block.includes('deliver'), 'init 分支不得投递到主会话')
  assert.ok(!block.includes('draft'), 'init 分支不得使用输入框草稿')
  assert.ok(!block.includes('applyGoalPolicy'), 'init 分支不得建 goal')
  assert.ok(!source.includes('[契约同步]'), '建成员时不得自动发契约同步')
  // 2.9.58：init 不得走 applyTakeoverChange —— 那条路会写接管通知，还会触发 syncGoal
  // 把用户正在跑的 goal 按弱参与静默暂停（paused goal 模型无权 resume）。
  assert.ok(!block.includes('applyTakeoverChange('), 'init 分支不得调用 applyTakeoverChange')
  assert.ok(
    block.includes("setTakeoverOverride(sessionId, state, 'init')"),
    'init 只落地默认挡位，且 source 记为 init（启动默认）',
  )
})

check('2.9.58 宿主机理：spawn 默认 caller，不触发 subagent-settled 唤醒主会话', () => {
  const source = readFileSync(new URL('../lib/team.js', import.meta.url), 'utf8')
  assert.ok(source.includes("request.delivery === 'parent' ? 'parent' : 'caller'"), '默认必须是 caller')
  assert.ok(!/delivery:\s*'parent'\s*,?\s*\n\s*\}\)/.test(source), '不得再把 delivery 写死成 parent')
})

check('预热代价（2.9.62）：从指挥员会话算出 用时/步数/工具/token', () => {
  const events = [
    { type: 'session', time: 1_000 },
    { type: 'step/start', time: 1_020 },
    { type: 'tool/call', time: 1_100, data: { name: 'read' } },
    { type: 'assistant/message', time: 1_200, data: { usage: { inputTokens: 900, outputTokens: 120 } } },
    { type: 'step/start', time: 1_500 },
    { type: 'tool/call', time: 1_600, data: { name: 'read' } },
    { type: 'assistant/message', time: 1_900, data: { usage: { inputTokens: 800, outputTokens: 90 } } },
  ]
  const running = summarizePreheat({ createdAt: 1_000, events })
  assert.equal(running.state, 'running', '还没有 turn/end 就是进行中')
  assert.equal(running.steps, 2)
  assert.equal(running.tools, 2)
  assert.equal(running.ms, 900, '用时＝最后事件 - 创建时刻')
  assert.deepEqual(running.tokens, { input: 1700, output: 210, cacheRead: 0, total: 1910 })
  // 跑完
  const done = summarizePreheat({ createdAt: 1_000, events: [...events, { type: 'turn/end', time: 2_000, data: { reason: { kind: 'completed' } } }] })
  assert.equal(done.state, 'done')
  assert.equal(done.ms, 1_000)
  // 异常收尾
  const failed = summarizePreheat({ createdAt: 1_000, events: [...events, { type: 'turn/end', time: 2_000, data: { reason: { kind: 'error' } } }] })
  assert.equal(failed.state, 'failed')
  // 预热之后的日常轮次不得拉长「预热时长」（重启后读旧会话时最容易出这个假数字）
  const later = summarizePreheat({
    createdAt: 1_000,
    events: [
      ...events,
      { type: 'turn/end', time: 2_000, data: { reason: { kind: 'completed' } } },
      { type: 'turn/start', time: 900_000 },
    ],
  })
  assert.equal(later.ms, 1_000, '多加的日常轮次不得拉长预热时长')
  // 没有事件就没有结论（不编数字）
  assert.equal(summarizePreheat({ createdAt: 1_000, events: [] }), undefined)
  assert.equal(summarizePreheat(), undefined)
  // 缺 usage 的事件不炸
  assert.deepEqual(sumPreheatTokens([{ type: 'assistant/message' }, { type: 'tool/call' }]), { input: 0, output: 0, cacheRead: 0, total: 0 })
})
let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error && error.message ? error.message : error}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\nINIT FLOW CHECKS PASSED (${checks.length})`)
