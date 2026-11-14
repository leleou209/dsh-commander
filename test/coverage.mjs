/**
 * 检查覆盖度单测（2.9.55）。
 *
 * 判据（用户口径）：「测试全绿」只在**覆盖 = 仓库全集**时成立；
 * live profile 只配了子集时，doctor 必须 FAIL 并列出缺项，而不是替子集背书。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeCheckCoverage, testFilesOf } from '../lib/coverage.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** 造一个临时插件目录，里面放 test/<names>.mjs。 */
function makePluginDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'commander-coverage-'))
  mkdirSync(join(dir, 'test'))
  for (const name of names) writeFileSync(join(dir, 'test', `${name}.mjs`), '// stub\n')
  return dir
}

check('命令里能取出 test 文件名（正斜杠/反斜杠、带引号都认）', () => {
  assert.deepEqual(testFilesOf('node "C:/x/dsh-commander/test/offline.mjs"'), ['offline'])
  assert.deepEqual(testFilesOf('node "C:\\x\\test\\team.mjs" --flag'), ['team'])
  assert.deepEqual(testFilesOf('echo nothing'), [])
})

check('配置是子集 → FAIL，并列出缺的那几套', async () => {
  const dir = makePluginDir(['offline', 'team', 'init'])
  try {
    const catalog = [{ name: 'offline', command: `node "${join(dir, 'test', 'offline.mjs')}"` }]
    const result = await describeCheckCoverage({ pluginDir: dir, catalog })
    assert.equal(result.level, 'FAIL')
    assert.deepEqual(result.missing, ['init', 'team'])
    assert.match(result.text, /1\/3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('配置覆盖全部 → PASS；插件目录未知 → SKIP（不冒充通过也不误报失败）', async () => {
  const dir = makePluginDir(['offline', 'team'])
  try {
    const catalog = [
      { name: 'offline', command: `node "${join(dir, 'test', 'offline.mjs')}"` },
      { name: 'team', command: `node "${join(dir, 'test', 'team.mjs')}"` },
    ]
    const full = await describeCheckCoverage({ pluginDir: dir, catalog })
    assert.equal(full.level, 'PASS')
    assert.match(full.text, /2\/2/)
    const unknown = await describeCheckCoverage({ catalog })
    assert.equal(unknown.level, 'SKIP')
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
console.log(`\nCOVERAGE CHECKS PASSED (${checks.length})`)
