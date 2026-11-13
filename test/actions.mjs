/**
 * action 注册表一致性测试（2.9.39 P2）。
 *
 * 目的：证明"加一个 action 只改 `actions.js` 一处"不是口号——
 * 下面每一处派生/引用都必须和注册表一致，任何一处漏改都会红。
 *
 * 覆盖：schema enum、工具 description、README 工具表、斜杠用法文案、
 * 斜杠 verb 与中文别名、斜杠命令的可委派集合。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACTIONS, ACTION_IDS, actionSegment, resolveSlash } from '../actions.js'
import { COMMANDER_TOOL_DESCRIPTION } from '../manual.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('注册表本身：id 唯一、kebab-case、双语摘要齐全', () => {
  const seen = new Set()
  for (const action of ACTIONS) {
    assert.match(action.id, /^[a-z][a-z-]*$/, `非法 id：${action.id}`)
    assert.ok(!seen.has(action.id), `重复 id：${action.id}`)
    seen.add(action.id)
    assert.ok(action.summary.trim().length > 0, `${action.id} 缺中文摘要`)
    assert.ok(action.summaryEn.trim().length > 0, `${action.id} 缺英文摘要`)
  }
  assert.equal(ACTION_IDS.length, ACTIONS.length)
})

check('schema enum 与注册表一致（不是各写一份）', () => {
  const source = read('index.js')
  const matched = source.match(/action: \{ type: 'string', enum: ([^}]+) \}/)
  assert.ok(matched, '找不到 action enum')
  assert.equal(matched[1].trim(), 'ACTION_IDS', 'enum 必须直接引用 ACTION_IDS')
})

check('工具 description 里的 action 段由注册表派生', () => {
  assert.ok(COMMANDER_TOOL_DESCRIPTION.includes(actionSegment('en')), 'description 没有用 actionSegment("en")')
  for (const action of ACTIONS) {
    assert.ok(
      COMMANDER_TOOL_DESCRIPTION.includes(`${action.id} ${action.summaryEn}`),
      `description 缺 ${action.id} 的英文摘要`,
    )
  }
})

check('README 工具表每个 action 都有一行', () => {
  const readme = read('README.md')
  for (const action of ACTIONS) {
    assert.ok(readme.includes(`| \`${action.id}\` |`), `README 缺 ${action.id} 那一行`)
  }
})

check('斜杠用法文案列出了所有 slash action', () => {
  const messages = read('messages.js')
  const usage = messages.match(/'help\.usage2': '([^']+)'/g) ?? []
  assert.ok(usage.length >= 1, '找不到 help.usage2')
  const joined = usage.join(' ')
  for (const action of ACTIONS.filter((row) => row.slash === true)) {
    assert.ok(joined.includes(action.id), `help.usage2 缺 slash action：${action.id}`)
  }
})

check('斜杠 verb/别名解析与注册表一致', () => {
  for (const action of ACTIONS.filter((row) => row.slash === true)) {
    assert.deepEqual(resolveSlash(action.id), { action: action.id, matched: true }, `verb ${action.id} 解析失败`)
    for (const alias of action.aliases ?? []) {
      assert.deepEqual(resolveSlash(alias), { action: action.id, matched: true }, `别名 ${alias} 解析失败`)
    }
  }
  // 工具专用 action 不该被斜杠解析命中
  for (const action of ACTIONS.filter((row) => row.slash !== true)) {
    assert.equal(resolveSlash(action.id).matched, false, `${action.id} 是工具专用，不该被斜杠解析`)
  }
  assert.equal(resolveSlash('nonsense').matched, false)
  assert.equal(resolveSlash('').matched, false)
})

check('斜杠命令里委派给工具的 action 确实走同一实现', () => {
  const source = read('index.js')
  const matched = source.match(/if \(verb === 'start' \|\| verb === 'list' \|\| verb === 'status'\) \{[\s\S]{0,400}?\}/)
  assert.ok(matched, '找不到委派块')
  assert.ok(matched[0].includes('commanderTool.execute('), '委派块必须调用 commanderTool.execute（同一实现）')
  assert.ok(!matched[0].includes('commanderStatus('), '委派块里不该再自己实现 status')
})

check('中文摘要与斜杠文案里不再各写一份 action 列表', () => {
  // index.js 里不应再出现手写的 action id 数组
  const source = read('index.js')
  assert.ok(
    !/const ACTIONS = \['start'/.test(source),
    'index.js 里还有手写的 action 数组，应该只用 ACTION_IDS',
  )
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
console.log(`\nACTION REGISTRY CHECKS PASSED (${checks.length})`)
