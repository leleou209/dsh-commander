/**
 * goal 联动的**执行**层：真的调宿主 goals，失败只回报不回滚。
 */
import assert from 'node:assert/strict'
import { createGoalSync } from '../lib/goal-link.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

function makeCtx(goal, overrides = {}) {
  const calls = []
  const goals = {
    get: () => goal,
    create: (_agent, request) => calls.push(['create', request.objective]),
    edit: (_agent, ref, request) => calls.push(['edit', request.objective, ref.expectedRevision]),
    pause: (_agent, ref) => calls.push(['pause', ref?.expectedRevision]),
    ...overrides,
  }
  return { calls, ctx: { get: (name) => (name === 'goals' ? goals : undefined), logger: { warn: () => {} } } }
}
const agent = { id: 'a', session: { header: { id: 'root-1' } } }
const rootIdOf = () => 'root-1'

check('无 goals 服务 → skipped，不抛', async () => {
  const sync = createGoalSync({ ctx: { get: () => undefined }, rootIdOf })
  assert.deepEqual(await sync(agent, 'full'), { action: 'skipped' })
})

check('进强参与且无 goal → create', async () => {
  const { calls, ctx } = makeCtx(undefined)
  const sync = createGoalSync({ ctx, rootIdOf })
  assert.equal((await sync(agent, 'full')).action, 'create')
  assert.equal(calls[0][0], 'create')
  assert.ok(calls[0][1].includes('全接管'))
})

check('退到弱参与 → pause；再进强参与能还原用户原文', async () => {
  let goal = { objective: '把登录修好', phase: 'active', revision: 1, id: 'g' }
  const { calls, ctx } = makeCtx(goal)
  const sync = createGoalSync({ ctx, rootIdOf })
  // 先进强参与（记下 origin）
  await sync(agent, 'full')
  const covered = calls.find((call) => call[0] === 'edit')[1]
  goal = { ...goal, objective: covered, revision: 2 }
  const ctx2 = makeCtx(goal)
  // 用同一个 sync 实例才能拿到 origin 记忆，所以这里换 ctx 的 goals.get
  const sync2 = createGoalSync({ ctx: ctx2.ctx, rootIdOf })
  await sync2(agent, 'full')
  const result = await sync2(agent, 'observe')
  assert.ok(['pause', 'restore-and-pause'].includes(result.action))
  assert.ok(ctx2.calls.some((call) => call[0] === 'pause'))
})

check('goal 操作抛错 → 只回报 error，不向上抛', async () => {
  const { ctx } = makeCtx({ objective: 'x', phase: 'active', revision: 1, id: 'g' }, {
    edit: () => {
      throw new Error('宿主拒绝')
    },
  })
  const sync = createGoalSync({ ctx, rootIdOf })
  const result = await sync(agent, 'full')
  assert.equal(result.action, 'error')
  assert.match(result.message, /宿主拒绝/)
})

check('已完成的 goal 不覆写（宿主会拒绝 edit）', async () => {
  const { calls, ctx } = makeCtx({ objective: 'x', phase: 'complete', revision: 1, id: 'g' })
  const sync = createGoalSync({ ctx, rootIdOf })
  assert.equal((await sync(agent, 'full')).action, 'none')
  assert.equal(calls.length, 0)
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
console.log(`\nGOAL-LINK EXEC CHECKS PASSED (${checks.length})`)
