/**
 * 回归测试：CODE_STATE 指纹与决议行解析（纯函数，不启动 Host）。
 *
 * 覆盖审计发现：
 *   P1-3 `.git/HEAD` 只含分支名 → 必须解析到真实提交号；
 *   P2-8 size+mtime 快照 → 改为内容哈希（touch 不再误判，同大小改动能发现）；
 *   P2-9 `doc` 全局排除 → 只排除工作区根部的 doc/；
 *   P2-2 `决定：继续（理由…）` 不被识别 → 允许行尾说明。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { computeCodeState, describeGitHead } from '../code-state.js'
import { parseDecision } from '../protocol.js'
import { createTranslator, localeKeyDiff, messageKeys, resolveLocale } from '../messages.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const makeTemp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'commander-regress-'))

/** 造一个假的 git 目录：HEAD 指向 refs/heads/main，ref 内容是可变的提交号。 */
async function fakeRepo() {
  const root = await makeTemp()
  const git = path.join(root, '.git')
  await fsp.mkdir(path.join(git, 'refs', 'heads'), { recursive: true })
  await fsp.writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/main\n')
  await fsp.writeFile(path.join(git, 'refs', 'heads', 'main'), '1111111111111111111111111111111111111111\n')
  await fsp.writeFile(path.join(root, 'index.js'), 'export const a = 1\n')
  return { root, git }
}

check('2.9.10 提交（ref 变化）不改变 CODE_STATE —— 内容没变就不该失效', async () => {
  const { root, git } = await fakeRepo()
  const before = await computeCodeState(root)
  await fsp.writeFile(path.join(git, 'refs', 'heads', 'main'), '2222222222222222222222222222222222222222\n')
  assert.equal(await computeCodeState(root), before, '提交换哈希但内容没变')
})

check('2.9.10 只提交 doc/ 不改变 CODE_STATE', async () => {
  const { root, git } = await fakeRepo()
  const before = await computeCodeState(root)
  await fsp.mkdir(path.join(root, 'doc'), { recursive: true })
  await fsp.writeFile(path.join(root, 'doc', 'plan.md'), '# plan\n')
  await fsp.writeFile(path.join(git, 'refs', 'heads', 'main'), '6666666666666666666666666666666666666666\n')
  assert.equal(await computeCodeState(root), before, 'doc 写入 + 提交都不该让放行失效')
})

check('2.9.10 提交号仍可读出（只展示，不绑定）', async () => {
  const { root } = await fakeRepo()
  assert.equal(await describeGitHead(root), '11111111')
})

check('2.9.10 代码内容变化仍然改变 CODE_STATE', async () => {
  const { root } = await fakeRepo()
  const before = await computeCodeState(root)
  await fsp.writeFile(path.join(root, 'index.js'), 'export const a = 2\n')
  assert.notEqual(await computeCodeState(root), before, '非 doc 内容变化必须失效')
})

check('P2-8 touch 不改内容时不改变 CODE_STATE', async () => {
  const root = await makeTemp()
  const file = path.join(root, 'a.js')
  await fsp.writeFile(file, 'const x = 1\n')
  const before = await computeCodeState(root)
  const later = new Date(Date.now() + 60_000)
  await fsp.utimes(file, later, later)
  const after = await computeCodeState(root)
  assert.equal(after, before, '只是 mtime 变化不该让放行失效')
})

check('P2-8 同大小内容变更能被发现', async () => {
  const root = await makeTemp()
  const file = path.join(root, 'a.js')
  await fsp.writeFile(file, 'const x = 1\n')
  const info = await fsp.stat(file)
  const before = await computeCodeState(root)
  await fsp.writeFile(file, 'const x = 2\n')
  await fsp.utimes(file, info.atime, info.mtime)
  const after = await computeCodeState(root)
  assert.notEqual(after, before, '内容变了就要变，与 size/mtime 无关')
})

check('P2-9 根部 doc/ 不计入状态', async () => {
  const root = await makeTemp()
  await fsp.writeFile(path.join(root, 'a.js'), 'const x = 1\n')
  const before = await computeCodeState(root)
  await fsp.mkdir(path.join(root, 'doc'), { recursive: true })
  await fsp.writeFile(path.join(root, 'doc', 'plan.md'), '# plan\n')
  assert.equal(await computeCodeState(root), before, 'doc/ 写入不该污染代码状态')
})

check('P2-9 深层 src/doc/ 必须计入状态', async () => {
  const root = await makeTemp()
  await fsp.mkdir(path.join(root, 'src', 'doc'), { recursive: true })
  await fsp.writeFile(path.join(root, 'src', 'doc', 'readme.md'), 'v1\n')
  const before = await computeCodeState(root)
  await fsp.writeFile(path.join(root, 'src', 'doc', 'readme.md'), 'v2\n')
  assert.notEqual(await computeCodeState(root), before, 'src/doc 是真代码目录，不能被排除')
})

check('P2-2 决定行允许带后缀说明', () => {
  assert.equal(parseDecision('决定：继续（理由：等待用户）'), '继续')
  assert.equal(parseDecision('决定：继续'), '继续')
  assert.equal(parseDecision('决定: 允许结束。'), '允许结束')
  assert.equal(parseDecision('决定：需澄清：缺少验证证据'), '需澄清')
  assert.equal(parseDecision('**决定：继续**\n正文'), '继续')
})

check('P2-2 正文中的「决定：」不算决定行', () => {
  assert.equal(parseDecision('本轮决定：继续'), undefined)
  assert.equal(parseDecision('我同意，决定：继续'), undefined)
  assert.equal(parseDecision('没有决定行'), undefined)
})

// ---- 改进点 7：文案目录 ----
check('文案：zh-CN 与 en 的 key 完全对齐', () => {
  const diff = localeKeyDiff()
  assert.deepEqual(diff.missingInEn, [], 'en 缺 key')
  assert.deepEqual(diff.missingInZh, [], 'zh 缺 key')
  assert.ok(messageKeys('zh-CN').length > 40, 'key 数量明显偏少，可能漏了整块')
})

check('文案：缺 key 显式暴露为 ⟦missing:…⟧', () => {
  const seen = []
  const t = createTranslator('zh-CN', { onMissing: (key) => seen.push(key) })
  assert.equal(t('nope.not.here'), '⟦missing:nope.not.here⟧')
  assert.deepEqual(seen, ['nope.not.here'])
})

check('文案：en 有独立译文，不是中文兜底', () => {
  const en = createTranslator('en')
  assert.equal(en('doctor.title'), 'Commander self-check')
  assert.ok(!/[\u4e00-\u9fa5]/.test(en('doctor.conclusionOk')), 'en 文案不应含中文')
})

check('文案：locale 归一化', () => {
  assert.equal(resolveLocale('zh'), 'zh-CN')
  assert.equal(resolveLocale('zh-Hans'), 'zh-CN')
  assert.equal(resolveLocale('en-US'), 'en')
  assert.equal(resolveLocale(''), 'zh-CN')
  assert.equal(resolveLocale('fr'), 'zh-CN')
})

check('文案：参数占位符被替换，缺参数原样保留', () => {
  const t = createTranslator('zh-CN')
  assert.ok(t('persist.file', { path: '/tmp/x' }).includes('/tmp/x'))
  assert.ok(t('persist.file', {}).includes('{path}'))
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
console.log(`\nREGRESSION CHECKS PASSED (${checks.length})`)