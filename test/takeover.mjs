/**
 * 接管状态（takeover）单测：四态推导、门禁判定、用户回归降级、循环。
 */
import assert from 'node:assert/strict'
import {
  blockedWhenOff,
  commanderMemberOf,
  DEFAULT_TAKEOVER,
  normalizeTakeover,
  requiresConsultBeforeAsking,
  requiresGoalApproval,
  resolveTakeover,
  startedInSession,
  TAKEOVER_LABELS,
  TAKEOVER_STATES,
} from '../lib/takeover.js'
import { createTakeoverStore } from '../lib/takeover-store.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('没有指挥员 → off（任何门禁都不生效）', () => {
  const { state, source } = resolveTakeover({ hasCommander: false, goalActive: true })
  assert.equal(state, 'off')
  assert.equal(source, 'derived')
  assert.equal(requiresConsultBeforeAsking(state), false)
  assert.equal(requiresGoalApproval(state), false)
})

check('有指挥员、没设过 → observe（启动默认，督察模式）', () => {
  const { state, source } = resolveTakeover({ hasCommander: true })
  assert.equal(state, 'observe')
  assert.equal(state, DEFAULT_TAKEOVER)
  assert.equal(source, 'derived')
  assert.equal(requiresConsultBeforeAsking(state), false, 'observe 不拦问用户')
  assert.equal(requiresGoalApproval(state), false, 'observe 不拦 goal 命令')
})

check('接管宽度不再跟 goal 走（有 goal 也是同一个默认值）', () => {
  assert.equal(resolveTakeover({ hasCommander: true, goalActive: false }).state, 'observe')
  assert.equal(resolveTakeover({ hasCommander: true, goalActive: true }).state, 'observe')
})

check('用户显式覆盖优先于推导', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, goalActive: true, override: 'full' })
  assert.equal(state, 'full')
  assert.equal(source, 'user')
  assert.equal(requiresConsultBeforeAsking(state), true)
})

check('覆盖值非法时回落到启动默认值', () => {
  const { state, source } = resolveTakeover({ hasCommander: true, override: 'nonsense' })
  assert.equal(state, 'observe')
  assert.equal(source, 'derived')
})

check('没有指挥员时覆盖值不生效（不会留下幽灵 full）', () => {
  const { state, source } = resolveTakeover({ hasCommander: false, override: 'full' })
  assert.equal(state, 'off')
  assert.equal(source, 'derived')
})

check('off 下只拒绝 say / wait，诊断类动作照常', () => {
  assert.equal(blockedWhenOff('say'), true)
  assert.equal(blockedWhenOff('wait'), true)
  for (const action of ['status', 'doctor', 'checks', 'list', 'cancel', 'start', 'goal']) {
    assert.equal(blockedWhenOff(action), false, `${action} 不该被 off 拦`)
  }
})

check('四个状态都有中文名，off 明确写成"不运行指挥职责"', () => {
  for (const state of TAKEOVER_STATES) assert.equal(typeof TAKEOVER_LABELS[state], 'string')
  assert.match(TAKEOVER_LABELS.off, /不运行指挥职责/)
  assert.match(TAKEOVER_LABELS.off, /无指挥/)
})

check('全接管是唯一强制先咨询的状态', () => {
  assert.deepEqual(
    TAKEOVER_STATES.map((state) => [state, requiresConsultBeforeAsking(state)]),
    [
      ['off', false],
      ['observe', false],
      ['partial', false],
      ['full', true],
    ],
  )
})

check('goal 门禁只在 partial/full 生效', () => {
  assert.deepEqual(
    TAKEOVER_STATES.map((state) => [state, requiresGoalApproval(state)]),
    [
      ['off', false],
      ['observe', false],
      ['partial', true],
      ['full', true],
    ],
  )
})

check('覆盖值保留来源（用户设定 / 启动默认）', () => {
  const byUser = resolveTakeover({ hasCommander: true, override: 'full', overrideSource: 'user' })
  assert.equal(byUser.state, 'full')
  assert.equal(byUser.source, 'user')
  const byInit = resolveTakeover({ hasCommander: true, override: 'observe', overrideSource: 'init' })
  assert.equal(byInit.state, 'observe')
  assert.equal(byInit.source, 'init')
  const noSource = resolveTakeover({ hasCommander: true, override: 'full' })
  assert.equal(noSource.source, 'user', '缺省仍按用户设定')
})

check('normalizeTakeover 大小写/空白容错', () => {
  assert.equal(normalizeTakeover('  FULL '), 'full')
  assert.equal(normalizeTakeover('Partial'), 'partial')
  assert.equal(normalizeTakeover('x'), undefined)
  assert.equal(normalizeTakeover(undefined), undefined)
})

/**
 * 2.9.44：`listMembers` 抛错时的兜底必须按「当前根会话」判断。
 *
 * 事故形状：别的会话（sessionA）起过指挥员 → 全局集合 size>0 → 在 sessionB 里
 * 误判「已有指挥员」→ `commanderExists` 返回 true → 跳过启动 → 用户点挡位毫无反应。
 * 这里把旧实现原样写成 legacy，断言它在这个形状下返回 true（= 红），
 * 新实现返回 false（= 绿）。
 */
check('commanderExists 兜底：别的会话启动过 ≠ 本会话有指挥员（旧实现 FAIL）', () => {
  const started = new Set(['sessionA'])
  const legacy = (fallback) => (fallback?.size > 0 ? true : false)
  assert.equal(legacy(started), true, '旧实现确实会误判（这是红的那一侧）')
  assert.equal(startedInSession(started, 'sessionB'), false, '新实现：别的会话启动过不算')
  assert.equal(startedInSession(started, 'sessionA'), true, '新实现：本会话启动过算')
})

check('commanderExists 兜底：根会话/子会话都按根 id 判断', () => {
  // 子会话的 id 与它所属根会话不同；调用方传进来的是 rootSessionIdOf(agent)
  const started = new Set(['root-1'])
  assert.equal(startedInSession(started, 'root-1'), true, 'root 分支')
  assert.equal(startedInSession(started, 'child-7'), false, 'child 会话本身的 id 不在集合里')
})

check('commanderExists 兜底：缺 id / 缺集合 / 空集合都判 false（绝不误判为"已存在"）', () => {
  assert.equal(startedInSession(undefined, 'root-1'), false)
  assert.equal(startedInSession(new Set(), 'root-1'), false)
  assert.equal(startedInSession(new Set(['root-1']), undefined), false)
  assert.equal(startedInSession(new Set(['root-1']), ''), false)
  assert.equal(startedInSession({}, 'root-1'), false, '没有 has 方法当没有')
})

check('commanderMemberOf：只认 role=teammate 且同名的成员', () => {
  const members = [
    { id: 'a', role: 'member', name: 'commander' },
    { id: 'b', role: 'teammate', name: 'builder' },
    { id: 'c', role: 'teammate', name: 'commander' },
  ]
  assert.equal(commanderMemberOf(members, 'commander')?.id, 'c')
  assert.equal(commanderMemberOf(members, 'nobody'), undefined)
  assert.equal(commanderMemberOf(undefined, 'commander'), undefined)
  assert.equal(commanderMemberOf([null, undefined], 'commander'), undefined)
})

check('接管挡位持久化（2.9.60）：ready 灌盘 / set 双写 / delete 清除 / 脏数据丢弃', async () => {
  const writes = []
  const unit = () => ({
    loadAll: async () => ({
      tables: {
        takeover: {
          'root-a': { state: 'full', source: 'user', at: 111 },
          'root-b': { state: 'nonsense', source: 'user', at: 222 },
          'root-c': { state: 'off' },
        },
      },
    }),
    putRecord: async (table, key, record) => writes.push(['put', table, key, record.state]),
    deleteRecord: async (table, key) => writes.push(['del', table, key]),
  })
  const map = new Map([['root-keep', { state: 'partial', source: 'user', at: 1 }]])
  const store = createTakeoverStore({ map, unit, now: () => 999 })
  // 内存里已有的值不被磁盘覆盖
  await store.ready()
  assert.equal(map.get('root-a')?.state, 'full', '磁盘挡位要恢复（重启后不丢）')
  assert.equal(map.has('root-b'), false, '非法挡位丢弃')
  assert.equal(map.get('root-c')?.state, 'off')
  assert.equal(map.get('root-c')?.source, 'user', '缺 source 时补 user')
  assert.equal(map.get('root-c')?.at, 999, '缺 at 时用 now')
  assert.equal(map.get('root-keep')?.state, 'partial', '本次进程里更新过的值不被覆盖')
  // set：内存立刻可见 + 异步落盘
  store.set('root-a', { state: 'observe', source: 'user' })
  assert.equal(map.get('root-a')?.state, 'observe', '同步读路径必须立刻看到新值')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(writes[0], ['put', 'takeover', 'root-a', 'observe'])
  // delete
  store.delete('root-a')
  assert.equal(map.has('root-a'), false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(writes[1], ['del', 'takeover', 'root-a'])
})

check('接管挡位持久化：磁盘读失败只记日志，不抛给交互', async () => {
  const warnings = []
  const store = createTakeoverStore({
    map: new Map(),
    unit: async () => {
      throw new Error('disk gone')
    },
    log: { warn: (line) => warnings.push(line) },
  })
  await store.ready()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /disk gone/)
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
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
console.log(`\nTAKEOVER CHECKS PASSED (${checks.length})`)
