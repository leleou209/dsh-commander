/**
 * 交接判定 + 协议解析。每条守卫都对应一个真实踩过的坑，这里逐条钉住。
 */
import assert from 'node:assert/strict'
import { afterWait, classifyReply, commanderDead, renderInstruction, renderReport, shouldDriveOnTakeover, shouldHandoff, shouldWakeParent } from '../lib/handoff.js'
import { hasRelease, parseDecision, parseGoalApprovals, parseRequestId } from '../lib/protocol.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const ready = {
  stopping: false, inFlight: false, isLead: true, mode: 'full',
  status: 'idle', turnEnded: true, stopped: false, interrupted: false, subtreeBusy: false,
}

check('shouldHandoff：全部条件满足才交接', () => {
  assert.equal(shouldHandoff(ready), true)
})

check('shouldHandoff：九道守卫逐条否决', () => {
  assert.equal(shouldHandoff({ ...ready, stopping: true }), false)
  assert.equal(shouldHandoff({ ...ready, inFlight: true }), false)
  assert.equal(shouldHandoff({ ...ready, isLead: false }), false)
  assert.equal(shouldHandoff({ ...ready, status: 'running' }), false)
  assert.equal(shouldHandoff({ ...ready, turnEnded: false }), false, 'idle 也含 maintenance，必须等真的 turn/end')
  assert.equal(shouldHandoff({ ...ready, stopped: true }), false)
  assert.equal(shouldHandoff({ ...ready, interrupted: true }), false)
  assert.equal(shouldHandoff({ ...ready, subtreeBusy: true }), false)
  for (const mode of ['off', 'observe', 'partial']) {
    assert.equal(shouldHandoff({ ...ready, mode }), false, `${mode} 不自动交接`)
  }
})

check('afterWait：dead/timeout 停运且必须清 pending', () => {
  for (const kind of ['dead', 'timeout']) {
    assert.deepEqual(afterWait({ kind }), { action: 'stop', clearPending: true, stopped: true })
  }
})

check('afterWait：用户插话让位一次；stopping 不清 pending', () => {
  assert.deepEqual(afterWait({ kind: 'reply', interrupted: true }), { action: 'let-go', clearPending: true, stopped: false })
  assert.deepEqual(afterWait({ kind: 'reply', stopping: true }), { action: 'stop', clearPending: false, stopped: false })
  assert.deepEqual(afterWait({ kind: 'reply' }), { action: 'wake', clearPending: false, stopped: false })
  assert.equal(afterWait({ kind: 'unknown' }).action, 'stop')
})

check('shouldWakeParent：退场后迟到的回复不许再点燃主agent', () => {
  assert.equal(shouldWakeParent({ mode: 'full', stopped: false }), true)
  assert.equal(shouldWakeParent({ mode: 'full' }), true)
  for (const mode of ['observe', 'partial', 'off']) {
    assert.equal(shouldWakeParent({ mode, stopped: false }), false)
  }
  assert.equal(shouldWakeParent({ mode: 'full', stopped: true }), false)
  assert.equal(shouldWakeParent({}), false, '读不到挡位一律不唤醒')
})

check('commanderDead：不存在或 failed 都算死', () => {
  assert.equal(commanderDead(undefined), true)
  assert.equal(commanderDead(null), true)
  assert.equal(commanderDead({ status: 'failed' }), true)
  assert.equal(commanderDead({ status: 'inactive' }), false)
})

check('协议：决定/批准/放行只认头块，正文引用不算', () => {
  // 头块 = 开头到第一个空行。正文里引用一句「决定：允许结束」是说明，不是命令。
  assert.equal(parseDecision('说明两句\n决定：继续'), 'continue', '头块内的决议行仍然认')
  assert.equal(parseDecision('先说明。\n\n决定：允许结束'), undefined, '空行之后的决议行不算')
  assert.equal(classifyReply('说明：\n\n决定：允许结束'), 'continue', '正文里的允许结束不得终止交接')
  assert.equal(hasRelease('决定：继续\n\n备注：只有用户能说允许结束'), false, '正文提到不等于放行')
  assert.equal(parseGoalApprovals('背景说明\n\n批准：goal edit').size, 0, '正文里的批准不算')
  assert.equal(parseGoalApprovals('批准：goal edit\n决定：继续').has('edit'), true)
})

check('shouldDriveOnTakeover：只有「切 full + 原本就有 active goal」才补驱动', () => {
  assert.equal(shouldDriveOnTakeover({ before: 'observe', next: 'full', goalPhase: 'active' }), true)
  assert.equal(shouldDriveOnTakeover({ before: 'partial', next: 'full', goalPhase: 'active' }), true)
  assert.equal(shouldDriveOnTakeover({ before: 'observe', next: 'full', goalPhase: undefined }), false, '没有 goal 只建不驱动')
  assert.equal(shouldDriveOnTakeover({ before: 'observe', next: 'full', goalPhase: 'paused' }), false, 'paused 只覆写，不代用户 resume')
  assert.equal(shouldDriveOnTakeover({ before: 'full', next: 'full', goalPhase: 'active' }), false, '已在 full 不重复驱动')
  assert.equal(shouldDriveOnTakeover({ before: 'full', next: 'partial', goalPhase: 'active' }), false)
  assert.equal(shouldDriveOnTakeover({ before: 'observe', next: 'partial', goalPhase: 'active' }), false, 'partial 不驱动')
})

check('协议：请求号 / 决议（允许行尾说明）/ 批准 / 放行', () => {
  assert.equal(parseRequestId('前缀 [REQ req-abc] 正文'), 'req-abc')
  assert.equal(parseRequestId('没有请求号'), undefined)
  assert.equal(parseDecision('决定：继续'), 'continue')
  assert.equal(parseDecision('决定：继续（理由：还差测试）'), 'continue')
  assert.equal(parseDecision('决定：需澄清'), 'clarify')
  assert.equal(parseDecision('决定：允许结束'), 'finish')
  assert.equal(parseDecision('没有决议行'), undefined)
  assert.deepEqual([...parseGoalApprovals('批准：goal edit, pause')].sort(), ['edit', 'pause'])
  assert.equal(parseGoalApprovals('无').size, 0)
  assert.equal(hasRelease('可以了，允许结束'), true)
  assert.equal(hasRelease('继续'), false)
})

check('classifyReply：只有明确「允许结束」才停，缺格式按继续', () => {
  assert.equal(classifyReply('决定：允许结束'), 'finish')
  assert.equal(classifyReply('决定：继续'), 'continue')
  assert.equal(classifyReply('忘了写格式'), 'continue')
})

check('渲染：汇报带目标与工具摘要（超 16 条折叠），指令带用户优先', () => {
  const report = renderReport({ report: '做完了 A', task: '目标 X', tools: Array.from({ length: 20 }, (_, i) => `✓ t${i}`) })
  assert.ok(report.includes('目标 X'))
  assert.ok(report.includes('做完了 A'))
  assert.ok(report.includes('…还有 4 条'))
  assert.ok(report.includes('决定：'))
  assert.ok(renderReport({}).includes('（本轮没有可见文本输出）'))
  const instruction = renderInstruction('去修 B')
  assert.ok(instruction.includes('去修 B'))
  assert.ok(instruction.includes('以用户最新指令为准'))
})

check('汇报里只在全接管链路要求维护 plan', () => {
  const report = renderReport({ report: '本轮输出', tools: ['✓ read: doc/a.md'] })
  assert.ok(report.includes('commander(action="plan")'), '全接管交接要提示先更新计划')
  assert.ok(report.includes('doc/plan.md'), '要点名目标文件')
  assert.ok(report.includes('决定：继续'), '契约行不能被顶掉')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
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
console.log(`\nHANDOFF CHECKS PASSED (${checks.length})`)
