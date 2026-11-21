/**
 * 交接驱动的执行层：进场补驱动、退场即收口、唤醒前重读挡位。
 *
 * 这三件事只在真实驱动里发生（不是纯判定），所以用假宿主把驱动跑起来：
 * 真发一次汇报、真等一次回复、真 abort 一次等待。
 */
import assert from 'node:assert/strict'
import { createDriver } from '../lib/driver.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms))

function makeWorld() {
  const log = { sent: [], followups: [], deleted: [] }
  let mode = 'full'
  const assistantText = (text) => ({
    type: 'assistant/message',
    seq: 12,
    time: Date.now(),
    data: { message: { content: [{ type: 'text', text }] } },
  })
  const session = {
    seq: 12,
    header: {},
    ownEvents: () => [{ type: 'turn/start', seq: 10 }],
    // 每次快照都是「刚写完的一轮」：时间取当下，否则 lastAt 基线会把它过滤掉。
    snapshotEvents: (from) => [assistantText('做完了 A')].filter((event) => event.seq >= from),
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session,
    followup: (message) => log.followups.push(message),
  }
  const store = {
    pending: () => ({ requestId: 'r1', commanderId: 'c1' }),
    deletePending: () => log.deleted.push('r1'),
  }
  const waits = []
  const driver = createDriver({
    ctx: {
      get: (name) => (name === 'agents' ? { withoutInitiator: (fn) => fn() } : undefined),
      on: () => () => {},
      logger: { warn: () => {} },
    },
    store,
    waitMs: 5000,
    pollMs: 10,
    rootIdOf: () => 'root',
    modeOf: async () => mode,
    findCommander: async () => ({ id: 'c1', status: 'active' }),
    sendToCommander: async (_agent, _id, text) => {
      log.sent.push(text)
      return { requestId: 'r1' }
    },
    // 与 consult.waitReply 一致：abort 时 reject，pending 由调用方处理。
    waitReply: (_agent, _requestId, signal) => new Promise((resolve, reject) => {
      waits.push({ resolve, reject })
      signal?.addEventListener?.('abort', () => reject(new Error('等待被中断；pending 已保留，可再次 wait 恢复。')), { once: true })
    }),
    subtreeBusy: async () => false,
    resolveCwd: async () => '.',
    goalObjective: () => '目标 X',
  })
  return { driver, log, agent, waits, setMode: (next) => { mode = next } }
}

check('进场驱动：驱动一次就发一次汇报，回复「继续」则唤醒主agent', async () => {
  const world = makeWorld()
  const state = world.driver.stateFor(world.agent)
  state.turnEnded = true
  world.driver.requestDrive(state)
  await tick(30)
  assert.equal(world.log.sent.length, 1, '应当只发一次汇报')
  assert.ok(world.log.sent[0].includes('目标 X'), '汇报要带目标')
  world.waits[0].resolve({ kind: 'reply', text: '[REQ r1]\n决定：继续\n\n继续做 B' })
  await tick(30)
  assert.equal(world.log.followups.length, 1, '有人值守时应当唤醒一次')
  assert.ok(world.log.followups[0].content[0].text.includes('继续做 B'))
})

check('退场即收口：cancelWait 立刻结束等待、清 pending、不唤醒', async () => {
  const world = makeWorld()
  const state = world.driver.stateFor(world.agent)
  state.turnEnded = true
  world.driver.requestDrive(state)
  await tick(30)
  assert.equal(world.log.sent.length, 1)
  world.setMode('partial')
  assert.equal(world.driver.cancelWait(world.agent), true)
  await tick(40)
  assert.equal(world.log.followups.length, 0, '切走后迟到回复不得点燃主agent')
  assert.ok(world.log.deleted.includes('r1'), '收口要清 pending，不留脏记录')
  assert.equal(state.inFlight, false, '收口后必须放开 inFlight，否则再也驱动不了')
})

check('守卫不回退：等待期间切走挡位，回复到达也不唤醒', async () => {
  const world = makeWorld()
  const state = world.driver.stateFor(world.agent)
  state.turnEnded = true
  world.driver.requestDrive(state)
  await tick(30)
  world.setMode('partial')
  world.waits[0].resolve({ kind: 'reply', text: '[REQ r1]\n决定：继续\n\n继续做 D' })
  await tick(30)
  assert.equal(world.log.followups.length, 0)
})

check('重新进入 full：reset 后恢复可交接', async () => {
  const world = makeWorld()
  const state = world.driver.stateFor(world.agent)
  state.turnEnded = true
  world.driver.requestDrive(state)
  await tick(30)
  world.driver.cancelWait(world.agent)
  await tick(40)
  // 回到 full：清停运/让位标志，再来一轮
  world.driver.reset(world.agent)
  state.turnEnded = true
  world.driver.requestDrive(state)
  await tick(30)
  assert.equal(world.log.sent.length, 2, '恢复后应再次汇报')
  world.waits.at(-1).resolve({ kind: 'reply', text: '[REQ r1]\n决定：继续\n\n继续做 C' })
  await tick(30)
  assert.equal(world.log.followups.length, 1, '恢复后应能再次唤醒')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\nDRIVER CHECKS PASSED (${checks.length})`)
