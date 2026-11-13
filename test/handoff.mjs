/**
 * 自动交接（handoff）纯逻辑单测：何时交接、回复分类、两段渲染。
 */
import assert from 'node:assert/strict'
import { classifyReply, HANDOFF_SOURCE, renderInstruction, renderReport, shouldHandoff } from '../handoff.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const base = { isLead: true, takeover: 'full', status: 'idle', turnEnded: true }

check('正常情况：主agent 空闲 + 刚结束一轮 + 全接管 → 交接', () => {
  assert.equal(shouldHandoff(base), true)
})

check('只有 idle 但没真的结束一轮（maintenance / 压缩）→ 不交接', () => {
  assert.equal(shouldHandoff({ ...base, turnEnded: false }), false)
})

check('停运后不再驱动（指挥员挂死/超时）', () => {
  assert.equal(shouldHandoff({ ...base, stopped: true }), false)
})

check('非全接管不交接', () => {
  for (const takeover of ['off', 'observe', 'partial']) {
    assert.equal(shouldHandoff({ ...base, takeover }), false, takeover)
  }
})

check('主agent 还在跑 / 不是根会话 / 正在交接中 → 不交接', () => {
  assert.equal(shouldHandoff({ ...base, status: 'running' }), false)
  assert.equal(shouldHandoff({ ...base, isLead: false }), false)
  assert.equal(shouldHandoff({ ...base, inFlight: true }), false)
})

check('用户刚插过话 → 这一轮不交接', () => {
  assert.equal(shouldHandoff({ ...base, interrupted: true }), false)
})

check('插件卸载中 → 不交接', () => {
  assert.equal(shouldHandoff({ ...base, stopping: true }), false)
})

check('回复分类：允许结束 / 需澄清 / 其余算继续', () => {
  assert.equal(classifyReply('决定：允许结束'), 'finish')
  assert.equal(classifyReply('决定：需澄清'), 'clarify')
  assert.equal(classifyReply('决定：继续'), 'continue')
  assert.equal(classifyReply('随便说点什么'), 'continue')
  assert.equal(classifyReply(''), 'continue')
  assert.equal(classifyReply(undefined), 'continue')
})

check('交给指挥员的汇报带任务与正文，不带轮次', () => {
  const text = renderReport({ task: '发布 dsh-commander 2.9.24', report: '改完了，测试全绿。' })
  assert.match(text, /\[自动交接\]/)
  assert.match(text, /当前任务：发布 dsh-commander 2\.9\.24/)
  assert.match(text, /改完了，测试全绿。/)
  assert.match(text, /继续 \/ 需澄清 \/ 允许结束/)
  assert.doesNotMatch(text, /#\d+/, '不再用轮次编号')
  assert.equal(renderReport({ report: '' }).includes('（本轮没有可见输出）'), true)
})

check('注入回主agent 的指令带原文与「不要问用户」边界', () => {
  const text = renderInstruction('决定：继续，把剩下的测完。')
  assert.match(text, /\[指挥员指令\]/)
  assert.match(text, /决定：继续，把剩下的测完。/)
  assert.match(text, /不要停下来问用户/)
  assert.match(renderInstruction(''), /（指挥员回复为空）/)
})

check('交接消息的 source 是 agent-message relay', () => {
  assert.equal(HANDOFF_SOURCE.kind, 'agent-message')
  assert.equal(HANDOFF_SOURCE.form, 'relay')
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
console.log(`\nHANDOFF CHECKS PASSED (${checks.length})`)
