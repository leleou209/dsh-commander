/**
 * 自动交接（handoff）纯逻辑单测：何时交接、回复分类、两段渲染。
 */
import assert from 'node:assert/strict'
import { afterWait, classifyReply, HANDOFF_SOURCE, renderInstruction, renderReport, shouldHandoff } from '../handoff.js'
import { createTranslator } from '../messages.js'

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

check('工具摘要进汇报，最多 16 行', () => {
  const tools = Array.from({ length: 20 }, (_, i) => `✓ tool${i}: args`)
  const text = renderReport({ report: 'x', tools })
  assert.match(text, /本轮工具：/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ✓')).length, 16)
  assert.equal(renderReport({ report: 'x', tools: [] }).includes('本轮工具'), false, '没有工具就不写这一段')
})

check('等待结果决策：dead/timeout 停运并清 pending', () => {
  for (const kind of ['dead', 'timeout']) {
    const out = afterWait({ kind })
    assert.equal(out.action, 'stop', kind)
    assert.equal(out.clearPending, true, `${kind} 必须清 pending`)
    assert.equal(out.stopped, true, `${kind} 应停运`)
  }
})

check('等待结果决策：用户插话让位一次并清 pending，不注入', () => {
  const out = afterWait({ kind: 'reply', interrupted: true })
  assert.equal(out.action, 'let-go')
  assert.equal(out.clearPending, true)
  assert.equal(out.stopped, false)
})

check('等待结果决策：正常回复注入、不清 pending（waitCommander 已清）', () => {
  const out = afterWait({ kind: 'reply' })
  assert.equal(out.action, 'wake')
  assert.equal(out.clearPending, false)
  assert.equal(out.stopped, false)
})

check('等待结果决策：stale/failed 也停并清 pending；stopping 不动 pending', () => {
  for (const kind of ['stale', 'failed', undefined]) {
    const out = afterWait({ kind })
    assert.equal(out.action, 'stop', String(kind))
    assert.equal(out.clearPending, true)
    assert.equal(out.stopped, false, '只有 dead/timeout 才停运')
  }
  const stopping = afterWait({ kind: 'reply', stopping: true })
  assert.equal(stopping.action, 'stop')
  assert.equal(stopping.clearPending, false, '卸载中不去碰 pending')
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

check('交接文案跟随语言：en 下不出现中文正文，但契约令牌仍是中文', () => {
  const en = createTranslator('en')
  const report = renderReport({ report: 'done', task: 'ship 2.9.35', tools: ['✓ bash: ls'], t: en })
  assert.match(report, /\[Handoff\]/)
  assert.match(report, /Current task: ship 2\.9\.35/)
  assert.match(report, /Tools this turn:/)
  assert.doesNotMatch(report, /自动交接|当前任务|本轮工具/)
  // 契约令牌不随语言变：指挥员永远用中文令牌回复。
  assert.match(report, /允许结束/)
  const instruction = renderInstruction('go on', en)
  assert.match(instruction, /\[Commander instruction\]/)
  assert.doesNotMatch(instruction, /指挥员指令|不要停下来问用户/)
  assert.match(instruction, /go on/)
})

check('交接文案缺省是中文（不传 t 也能用）', () => {
  assert.match(renderReport({ report: 'x' }), /\[自动交接\]/)
  assert.match(renderInstruction('x'), /\[指挥员指令\]/)
})

check('探针文案带 [探针] 前缀且两语言都在', () => {
  assert.match(createTranslator('zh-CN')('handoff.probeTag'), /探针/)
  assert.match(createTranslator('en')('handoff.probeTag'), /probe/i)
  assert.ok(createTranslator('en')('handoff.probeNote').length > 20)
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
