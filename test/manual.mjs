/**
 * 主agent 说明书测试。
 *
 * 守三件事：
 *   1. 索引里的每个 topic 都能取到正文（发现性不能断）；
 *   2. `AGENT-MANUAL.md` 与 `manual.js` 逐字节一致（防漂移：改了源忘了生成）；
 *   3. 工具说明不超过预算（常驻上下文成本）。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDER_TOOL_DESCRIPTION } from '../manual.js'
import {
  MANUAL_INDEX_MAX_LINES,
  MANUAL_TOPICS,
  manualTopic,
  manualTopicIds,
  renderManualIndex,
  renderManualMarkdown,
  renderManualTopic,
} from '../manual.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('每个 topic 都有 id/title/when/body，且 id 唯一', () => {
  assert.ok(MANUAL_TOPICS.length >= 8, `topic 至少 8 个，实际 ${MANUAL_TOPICS.length}`)
  const seen = new Set()
  for (const topic of MANUAL_TOPICS) {
    assert.match(topic.id, /^[a-z][a-z-]*$/, `topic id 必须是 kebab-case：${topic.id}`)
    assert.ok(!seen.has(topic.id), `topic id 重复：${topic.id}`)
    seen.add(topic.id)
    assert.ok(topic.title.trim().length > 0, `${topic.id} 缺 title`)
    assert.ok(topic.when.trim().length > 0, `${topic.id} 缺 when（索引里要写"什么时候看"）`)
    assert.ok(topic.body.trim().length > 40, `${topic.id} 正文太短，等于没写`)
  }
})

check('索引里列出的每个 id 都能取到正文', () => {
  const index = renderManualIndex()
  for (const id of manualTopicIds()) {
    assert.ok(index.includes(`**${id}**`), `索引缺 ${id}`)
    const body = renderManualTopic(id)
    assert.ok(body && body.includes('## '), `${id} 取不到正文`)
  }
})

check('索引长度受控（不会把索引撑成正文）', () => {
  const lines = renderManualIndex().split('\n')
  assert.ok(lines.length <= MANUAL_INDEX_MAX_LINES, `索引 ${lines.length} 行，上限 ${MANUAL_INDEX_MAX_LINES}`)
})

check('未知 topic 取不到正文（由调用方给索引兜底）', () => {
  assert.equal(renderManualTopic('nope'), undefined)
  assert.equal(manualTopic('nope'), undefined)
  assert.equal(manualTopic('  LOOP  ').id, 'loop', '大小写/空白要容错')
})

check('索引可以带"没有这个分段"的提示头', () => {
  const text = renderManualIndex({ header: '## 没有名为 "x" 的分段', unknown: '可用：a、b' })
  assert.ok(text.startsWith('## 没有名为 "x" 的分段'))
  assert.ok(text.includes('可用：a、b'))
})

check('AGENT-MANUAL.md 与 manual.js 逐字节一致', async () => {
  const file = path.join(repoRoot, 'AGENT-MANUAL.md')
  const onDisk = await fsp.readFile(file, 'utf8')
  assert.equal(
    onDisk,
    renderManualMarkdown(),
    'AGENT-MANUAL.md 已过期：改完 manual.js 要重新生成（node -e "import(\'./manual.js\')..."）',
  )
})

check('工具说明不超过 800 字符，且指路了 help', () => {
  assert.ok(
    COMMANDER_TOOL_DESCRIPTION.length <= 800,
    `工具说明 ${COMMANDER_TOOL_DESCRIPTION.length} 字符，超过 800 预算`,
  )
  assert.match(COMMANDER_TOOL_DESCRIPTION, /commander\(action="help"\)/)
  // 三条硬门禁必须在常驻说明里（不能只写在说明书里）
  assert.match(COMMANDER_TOOL_DESCRIPTION, /允许结束/)
  assert.match(COMMANDER_TOOL_DESCRIPTION, /批准：goal/)
  assert.match(COMMANDER_TOOL_DESCRIPTION, /全接管/)
})

check('说明书不含密钥与本机绝对路径', () => {
  const all = MANUAL_TOPICS.map((topic) => `${topic.title}\n${topic.when}\n${topic.body}`).join('\n')
  for (const pattern of [/C:\\\\Users/i, /gho_/, /ghp_/, /github_pat_/, /\/home\/admin/, /\d+\.\d+\.\d+\.\d+/]) {
    assert.ok(!pattern.test(all), `说明书里出现了不该有的东西：${pattern}`)
  }
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
console.log(`\nMANUAL CHECKS PASSED (${checks.length})`)
