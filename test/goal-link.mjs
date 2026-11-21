/**
 * goal 联动的**执行**层：真的调宿主 goals，失败只回报不回滚。
 */
import assert from 'node:assert/strict'
import { createGoalSync } from '../lib/goal-link.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

function assertGoalRef(ref, where) {
  // 宿主的 GoalRef 是 `{ id, revision }`（见 DSH 的 GoalRef 接口）。字段名写错时
  // 宿主只会报 `stale goal ref "undefined" revision undefined`——像并发冲突，
  // 其实是形状不对。mock 必须硬校验，否则 mock 和实现一起错、测试照样全绿。
  assert.equal(typeof ref?.id, 'string', `${where} 的 ref.id 必须是字符串`)
  assert.ok(Number.isInteger(ref?.revision), `${where} 的 ref.revision 必须是整数`)
}

function makeCtx(goal, overrides = {}) {
  const calls = []
  const state = { goal }
  const goals = {
    get: () => state.goal,
    create: (_agent, request) => {
      calls.push(['create', request.objective])
      // 宿主 create 之后 goal 立刻可读，revision 从 1 起。
      state.goal = { id: 'g-created', objective: request.objective, phase: 'active', revision: 1 }
    },
    edit: (_agent, ref, request) => {
      assertGoalRef(ref, 'edit')
      calls.push(['edit', request.objective, ref])
      state.goal = { ...state.goal, objective: request.objective, revision: state.goal.revision + 1 }
    },
    pause: (_agent, ref) => {
      assertGoalRef(ref, 'pause')
      calls.push(['pause', ref])
      state.goal = { ...state.goal, phase: 'paused', revision: state.goal.revision + 1 }
    },
    ...overrides,
  }
  return { calls, state, ctx: { get: (name) => (name === 'goals' ? goals : undefined), logger: { warn: () => {} } } }
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

check('退到弱参与 → 还原用户原文并 pause（同一个实例才带 origin 记忆）', async () => {
  const { calls, ctx } = makeCtx({ objective: '把登录修好', phase: 'active', revision: 1, id: 'g' })
  const sync = createGoalSync({ ctx, rootIdOf })
  // 进强参与：覆写成接管文案，同时记下 origin
  await sync(agent, 'full')
  const covered = calls.find((call) => call[0] === 'edit')[1]
  assert.ok(covered.includes('【接管：全接管】'), '先要把用户原文覆写成接管文案')
  // 同一个实例退到弱参与：origin 还在，必须还原用户原文
  const result = await sync(agent, 'observe')
  assert.equal(result.action, 'restore-and-pause')
  const edits = calls.filter((call) => call[0] === 'edit')
  assert.equal(edits.at(-1)[1], '把登录修好', '必须还原用户原文，而不是留占位文案')
  assert.ok(calls.some((call) => call[0] === 'pause'), '还原后要暂停')
})

check('接管自建的占位 goal（无用户原文）退到弱参与 → 只 pause，不写空 objective', async () => {
  const { calls, state, ctx } = makeCtx(undefined)
  const sync = createGoalSync({ ctx, rootIdOf })
  assert.equal((await sync(agent, 'partial')).action, 'create')
  const editsBefore = calls.filter((call) => call[0] === 'edit').length
  const result = await sync(agent, 'observe')
  // origin 是空串：edit('') 会被宿主以 GOAL_INVALID_OBJECTIVE 拒绝，
  // 表现出来就是「退出强参与后 goal 还亮着」。
  assert.equal(result.action, 'pause')
  assert.equal(calls.filter((call) => call[0] === 'edit').length, editsBefore, '不得再 edit')
  assert.ok(calls.filter((call) => call[0] === 'edit').every((call) => call[1].trim().length > 0))
  assert.equal(state.goal.phase, 'paused')
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

check('已完成的 goal 不覆写（产品选择：结束的目标不接管）', async () => {
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
