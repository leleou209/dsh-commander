/**
 * Agent Teams 桥单测（2.9.45）。
 *
 * 为什么要有：DSH 0.2.2 起成员不再是 `ctx.agentTeams` 的对象，而是根会话下的
 * **可续接子agent**（`ctx.subagents`）。桥把「同步 listMembers + 旧签名」映射到异步的新 API，
 * 这里是它唯一的真值表：缓存、刷新、幽灵行清理、按名/id 发消息、以及「没有服务时给出可读错误」。
 */

import assert from 'node:assert/strict'

import { createTeamBridge, ensureCommanderKnown, findMembership, listLiveSubagents, mergeDescendants, pickMember, toRow, viewRows } from '../lib/team.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** 造一个最小 ctx：agents 服务 + 可选的 subagents 服务。 */
function makeCtx({ subagents, live = {} } = {}) {
  const services = {
    agents: {
      get: (id) => (id in live ? live[id] : undefined),
    },
  }
  if (subagents !== undefined) services.subagents = subagents
  return {
    get(name) {
      return services[name]
    },
  }
}

function makeAgent(id, rootId = id) {
  return { id, session: { header: { id: rootId } } }
}

check('没有 subagents 服务：available=false，spawn 抛出可读错误', async () => {
  const bridge = createTeamBridge({ ctx: makeCtx(), commanderName: 'commander' })
  assert.equal(bridge.available(), false)
  await assert.rejects(
    () => bridge.spawnTeammate(makeAgent('root-1'), { provider: 'spawn', prompt: 'hi' }),
    /没有可用的 subagents 服务/,
  )
})

check('spawn：把 request 映射成 startActivation 的参数，并登记成员', async () => {
  const calls = []
  const subagents = {
    rootOf: () => makeAgent('root-1'),
    async startActivation(spec) {
      calls.push(spec)
      return { id: 'teammate-1', name: spec.name }
    },
    async listDescendants() {
      return [{ kind: 'child', id: 'teammate-1', name: 'commander' }]
    },
  }
  const bridge = createTeamBridge({ ctx: makeCtx({ subagents, live: { 'teammate-1': { id: 'teammate-1', status: 'running' } } }), commanderName: 'commander' })
  const member = await bridge.spawnTeammate(makeAgent('root-1'), {
    name: 'commander',
    description: '指挥员',
    prompt: [{ type: 'text', text: 'hi' }],
    provider: 'spawn',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'commander')
  assert.equal(calls[0].label, '指挥员')
  assert.equal(calls[0].provider, 'spawn')
  // 2.9.58：默认 caller。宿主的 parent 投递会在子agent 每轮结束把 subagent-settled
  // 塞进主会话收件箱并开新一轮 —— 那就是「初始化一完主会话自己动起来」的根因。
  assert.equal(calls[0].delivery, 'caller', '默认必须是 caller，否则主会话会被自动唤醒')
  assert.ok(calls[0].signal instanceof AbortSignal, 'startActivation 必须收到真 AbortSignal')
  assert.equal(calls[0].parent.id, 'root-1')
  assert.equal(member.id, 'teammate-1')
  assert.equal(bridge.listMembers(makeAgent('root-1'))[0].status, 'running')
})

check('spawn：delivery 只在显式要 parent 时才透传，其余一律 caller', async () => {
  const seen = []
  const subagents = {
    rootOf: () => makeAgent('root-1'),
    async startActivation(spec) {
      seen.push(spec.delivery)
      return { id: 't-1', name: spec.name }
    },
    async listDescendants() {
      return []
    },
  }
  const bridge = createTeamBridge({ ctx: makeCtx({ subagents }), commanderName: 'commander' })
  const agent = makeAgent('root-1')
  await bridge.spawnTeammate(agent, { provider: 'spawn', prompt: 'a', delivery: 'parent' })
  await bridge.spawnTeammate(agent, { provider: 'spawn', prompt: 'b', delivery: 'whatever' })
  await bridge.spawnTeammate(agent, { provider: 'spawn', prompt: 'c' })
  assert.deepEqual(seen, ['parent', 'caller', 'caller'])
})

check('refresh：只收同名 child，过滤别的名字与非 child 行，并清掉幽灵行', async () => {
  const rows = new Map([
    ['dead-1', { id: 'dead-1', name: 'commander', role: 'teammate' }],
  ])
  const view = mergeDescendants({
    rows,
    entries: [
      { kind: 'child', id: 'live-1', name: 'commander', label: '指挥员' },
      { kind: 'child', id: 'other-1', name: 'builder' },
      { kind: 'diagnostic', id: 'diag-1', name: 'commander', reason: 'unavailable' },
    ],
    commanderName: 'commander',
    statusOf: () => 'running',
    isLive: (id) => id === 'live-1',
  })
  assert.deepEqual(view.map((row) => row.id), ['live-1'])
  assert.equal(view[0].label, '指挥员')
  assert.equal(view[0].status, 'running')
  assert.equal(rows.has('dead-1'), false, '不在运行也不在列举里 → 摘掉')
})

check('viewRows：status 每次取实时值，缓存里的旧 status 不生效', () => {
  const rows = new Map([['t-1', { id: 't-1', name: 'commander', role: 'teammate', status: 'provisioning' }]])
  assert.equal(viewRows(rows, () => 'failed')[0].status, 'failed')
  assert.equal(viewRows(rows, () => undefined)[0].status, 'provisioning', '取不到实时值就保留快照')
})

check('membership：跨 bucket 按 agent id 反查', () => {
  const cache = new Map([
    ['root-1', new Map([['t-1', { id: 't-1', name: 'commander', role: 'teammate' }]])],
  ])
  assert.deepEqual(findMembership(cache, 't-1'), { role: 'teammate', name: 'commander' })
  assert.equal(findMembership(cache, 'nobody'), undefined)
  assert.equal(findMembership(cache, undefined), undefined)
})

check('pickMember：名字或 id 都能命中，空集合安全', () => {
  const rows = [{ id: 't-1', name: 'commander' }]
  assert.equal(pickMember(rows, 'commander')?.id, 't-1')
  assert.equal(pickMember(rows, 't-1')?.id, 't-1')
  assert.equal(pickMember(rows, 'x'), undefined)
  assert.equal(pickMember(undefined, 'x'), undefined)
})

check('toRow：缺 id / 非对象一律丢弃，不伪造成员', () => {
  assert.equal(toRow(undefined), undefined)
  assert.equal(toRow({ name: 'commander' }), undefined)
  assert.equal(toRow({ id: '', name: 'commander' }), undefined)
  assert.equal(toRow({ id: 't-1', name: 'commander' })?.role, 'teammate')
})

check('sendMessage：按名字解析成 session id，并传 AbortSignal', async () => {
  const sent = []
  const subagents = {
    rootOf: () => makeAgent('root-1'),
    async listDescendants() {
      return [{ kind: 'child', id: 't-1', name: 'commander' }]
    },
    async startActivation() {
      throw new Error('not used')
    },
    async sendMessage(sender, targetId, content, options) {
      sent.push({ sender: sender.id, targetId, content, options })
      return 'msg-1'
    },
  }
  const bridge = createTeamBridge({ ctx: makeCtx({ subagents }), commanderName: 'commander' })
  const id = await bridge.sendMessage(makeAgent('root-1'), { target: 'commander', content: [{ type: 'text', text: 'hi' }] })
  assert.equal(id, 'msg-1')
  assert.equal(sent[0].targetId, 't-1', '必须发 session id，不是名字')
  assert.ok(sent[0].options.signal instanceof AbortSignal)
  assert.equal(sent[0].content[0].text, 'hi')
})

check('sendMessage：找不到成员时报出现有名字，便于用户自查', async () => {
  const subagents = {
    rootOf: () => makeAgent('root-1'),
    async listDescendants() {
      return []
    },
    async startActivation() {
      throw new Error('not used')
    },
    async sendMessage() {
      throw new Error('not used')
    },
  }
  const bridge = createTeamBridge({ ctx: makeCtx({ subagents }), commanderName: 'commander' })
  await assert.rejects(
    () => bridge.sendMessage(makeAgent('root-1'), { target: 'commander', content: [] }),
    /找不到成员 "commander"（现有：/,
  )
})

check('rootIdOf：rootOf 抛错时退回 header 上的会话 id', () => {
  const subagents = {
    rootOf() {
      throw new Error('no manager')
    },
    async startActivation() {},
    async listDescendants() {
      return []
    },
    async sendMessage() {},
  }
  const bridge = createTeamBridge({ ctx: makeCtx({ subagents }), commanderName: 'commander' })
  assert.equal(bridge.rootIdOf(makeAgent('child-1', 'root-1')), 'root-1')
})

check('listLiveSubagents：只取 child，补上 status/depth（并列子agent 视图）', async () => {
  const sub = {
    async listDescendants() {
      return [
        { kind: 'child', id: 't-1', name: 'commander', depth: 1 },
        { kind: 'child', id: 'b-1', name: 'builder', depth: 2 },
        { kind: 'diagnostic', id: 'd-1', name: 'gone' },
      ]
    },
  }
  const rows = await listLiveSubagents({ sub, rootId: 'root-1', signal: undefined, statusOf: (id) => (id === 'b-1' ? 'running' : undefined) })
  assert.deepEqual(rows.map((row) => row.id), ['t-1', 'b-1'], 'diagnostic 不算')
  assert.equal(rows[0].status, 'inactive', '取不到实时状态就记 inactive')
  assert.equal(rows[1].status, 'running')
  assert.equal(rows[1].depth, 2)
  const empty = await listLiveSubagents({ sub: undefined, rootId: 'root-1', statusOf: () => undefined })
  assert.deepEqual(empty, [], '没有服务 → 空列表，不抛错')
})
check('ensureCommanderKnown（2.9.59）：冷缓存才补一次有界刷新，热缓存/无 agent 都不打扰宿主', async () => {
  const calls = []
  const makeBridge = (rows, rootId = 'root-1') => ({
    listMembers: () => rows,
    rootIdOf: () => rootId,
    refresh: async () => {
      calls.push('refresh')
      rows.push({ id: 'new-1', name: 'commander', role: 'teammate' })
      return rows
    },
  })
  // 热缓存：直接 true，不刷新
  assert.equal(await ensureCommanderKnown(makeBridge([{ id: 'c-1', name: 'commander' }]), makeAgent('root-1'), 'commander'), true)
  assert.deepEqual(calls, [], '缓存里已有指挥员就不该再打宿主')
  // 无 agent：false，不刷新
  assert.equal(await ensureCommanderKnown(makeBridge([]), undefined, 'commander'), false)
  assert.deepEqual(calls, [])
  // 冷缓存：刷新一次，并从空变有
  const rows = []
  const bridge = makeBridge(rows)
  assert.equal(await ensureCommanderKnown(bridge, makeAgent('root-1'), 'commander'), true)
  assert.deepEqual(calls, ['refresh'], '冷缓存必须补一次刷新')
  // 负缓存：同一个根会话 15 秒内不再刷（第一次仍要探测，否则会永远停在问号上）
  const missCalls = []
  const miss = {
    listMembers: () => [],
    rootIdOf: () => 'root-2',
    refresh: async () => {
      missCalls.push('refresh')
      return []
    },
  }
  const clock = { t: 1_700_000_000_000 }
  assert.equal(await ensureCommanderKnown(miss, makeAgent('root-2'), 'commander', { now: () => clock.t }), false)
  assert.equal(missCalls.length, 1, '第一次冷探测必须真的打一次宿主')
  clock.t += 10_000
  assert.equal(await ensureCommanderKnown(miss, makeAgent('root-2'), 'commander', { now: () => clock.t }), false)
  assert.equal(missCalls.length, 1, '负缓存期内不得重复刷新')
  clock.t += 6_000
  assert.equal(await ensureCommanderKnown(miss, makeAgent('root-2'), 'commander', { now: () => clock.t }), false)
  assert.equal(missCalls.length, 2, '过了 15 秒要重新探测，否则指挥员后来起来了也看不到')
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
console.log(`\nTEAM BRIDGE CHECKS PASSED (${checks.length})`)
