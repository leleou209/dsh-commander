/**
 * 文档写入：doc/ 四件套骨架、倒序追加的**不嵌套**、plan 记录格式。
 *
 * 这里有一条曾经存在的真 bug：倒序追加时把上一条记录的 `## 标题` 也当成文件头继续跳过，
 * 于是第二条记录会插进第一条的标题和正文之间，越写越乱。已用 `## ` 判断破掉。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureDocs, formatHistoryEntry, formatPlanEntry, prependHistory, prependPlan } from '../lib/docs.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const sandbox = async () => fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-docs-'))

check('ensureDocs：建骨架，已有内容不覆盖', async () => {
  const cwd = await sandbox()
  const paths = await ensureDocs(cwd, 'doc')
  const first = await fsp.readFile(paths.history, 'utf8')
  assert.ok(first.includes('# history'))
  await fsp.writeFile(paths.history, '# history\n\n我的内容\n', 'utf8')
  await ensureDocs(cwd, 'doc')
  assert.equal(await fsp.readFile(paths.history, 'utf8'), '# history\n\n我的内容\n', '重复调用不得覆盖用户内容')
})

check('倒序追加：连写三条也不嵌套（这是修掉的 bug）', async () => {
  const cwd = await sandbox()
  const paths = await ensureDocs(cwd, 'doc')
  await prependHistory(paths.history, formatHistoryEntry('第一条', undefined, new Date(2026, 0, 1, 10, 0)))
  await prependHistory(paths.history, formatHistoryEntry('第二条', undefined, new Date(2026, 0, 1, 11, 0)))
  await prependHistory(paths.history, formatHistoryEntry('第三条', '补充说明', new Date(2026, 0, 1, 12, 0)))
  const text = await fsp.readFile(paths.history, 'utf8')
  const order = ['第三条', '第二条', '第一条'].map((needle) => text.indexOf(needle))
  assert.ok(order.every((index) => index >= 0), '三条都要在')
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '必须最新在上')
  // 每条记录独占一个 ## 段落，且标题紧跟自己的正文
  const blocks = text.split(/\n## /).slice(1)
  assert.equal(blocks.length, 3, '应当正好三段 ## 记录')
  assert.ok(blocks[0].includes('第三条'), '第一段是最新那条')
  assert.ok(blocks[0].includes('补充说明'), '正文必须跟在自己的标题下，不能串到别人那儿')
  assert.ok(blocks[2].includes('第一条'))
})

check('plan：倒序追加、标题可选、正文是多行 Markdown', async () => {
  const cwd = await sandbox()
  const paths = await ensureDocs(cwd, 'doc')
  await prependPlan(paths.plan, formatPlanEntry('- 阶段一\n- 阶段二', '重构计划', new Date(2026, 0, 1, 9, 30)))
  await prependPlan(paths.plan, formatPlanEntry('- 只留一句话', undefined, new Date(2026, 0, 1, 10, 30)))
  const text = await fsp.readFile(paths.plan, 'utf8')
  assert.ok(text.includes('## 2026/01/01 09:30 · 重构计划'), '带标题时要拼在时间戳后面')
  assert.ok(text.includes('## 2026/01/01 10:30'), '不带标题时只有时间戳')
  assert.ok(text.indexOf('10:30') < text.indexOf('09:30'), '最新在上')
  assert.ok(text.includes('- 阶段一') && text.includes('- 阶段二'), '多行正文要完整保留')
})

check('文件不存在时写入：用对应骨架，不写错文件头', async () => {
  const cwd = await sandbox()
  const target = path.join(cwd, 'doc', 'plan.md')
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await prependPlan(target, formatPlanEntry('- x', undefined, new Date(2026, 0, 1, 8, 0)))
  const text = await fsp.readFile(target, 'utf8')
  assert.ok(text.startsWith('# plan'), 'plan 文件要用 # plan 头，不能借 history 的')
  assert.ok(!text.includes('# history'))
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
console.log(`\nDOCS CHECKS PASSED (${checks.length})`)