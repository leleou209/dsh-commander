/**
 * 会话日志完整性（session integrity）回归测试。
 *
 * 守三件事：
 *  1. 代码里不再出现 `append('developer/message')` —— 那条通道会被宿主在
 *     `projectToolUpdates` 里过滤掉，且写错位置会让会话在 restore 时整体判死
 *     （2026-11-13 真实事故：一条 `[接管状态]` 通知写在 turn/end 之后）。
 *  2. 接管通知必须走 `user/message` + `source.kind = 'runtime-context'`。
 *  3. `scripts/repair-session.mjs` 能把"越界事件"修掉，且**保持多帧结构**
 *     （把多帧压成单帧会让宿主读不回来，这是修日志时最容易踩的坑）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { frameBounds, validate } from '../scripts/repair-session.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')
const repairScript = join(root, 'scripts', 'repair-session.mjs')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

function sourceFiles() {
  const lib = join(root, 'lib')
  return [join(root, 'index.js'), ...readdirSync(lib).filter((f) => f.endsWith('.js')).map((f) => join(lib, f))]
}

check('源码里不存在 append(\'developer/message\')（2.9.20 的致命写法）', () => {
  const offenders = sourceFiles().filter((file) =>
    /append\s*\(\s*['"]developer\/message['"]/.test(readFileSync(file, 'utf8')),
  )
  assert.deepEqual(offenders, [], `这些文件仍在写 developer/message：${offenders.join(', ')}`)
})

check('接管通知走 runtime-context 的 user 消息', () => {
  const source = readFileSync(join(root, 'index.js'), 'utf8')
  const start = source.indexOf('function announceTakeover')
  assert.ok(start > 0, '找不到 announceTakeover')
  const body = source.slice(start, start + 1200)
  assert.match(body, /append\(\s*\n?\s*['"]user\/message['"]/, 'announceTakeover 应写 user/message')
  assert.match(body, /kind:\s*['"]runtime-context['"]/, '应带 runtime-context 来源')
  assert.doesNotMatch(body, /developer\/message/, '不应再出现 developer/message')
})

check('repair-session：默认拒绝执行（2.9.46 停用旧算法，防二次损坏）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repair-guard-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    const header = { type: 'session', version: 4, id: 'session-guard', createdAt: 1, cwd: 'C:\\tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'cordis' }
    const events = [header, { type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } }]
    writeFileSync(file, Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))))
    const before = readFileSync(file)
    assert.throws(
      () => execFileSync(process.execPath, [repairScript, file, '--drop-seq=1', '--apply'], { stdio: 'pipe' }),
      (error) => error.status === 2,
      '不带 --legacy-unsafe 时必须以 2 退出',
    )
    assert.deepEqual(readFileSync(file), before, '拒绝执行时不得改动文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('repair-session：丢弃越界事件后 seq 连续、保持多帧、其余事件不丢（旧算法对照，需 --legacy-unsafe）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    const header = { type: 'session', version: 4, id: 'session-test', createdAt: 1, cwd: 'C:\\tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'cordis' }
    const events = [
      header,
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      // 越界事件：turn 已结束，却还自称 turn 1 / step 1
      { type: 'developer/message', seq: 5, data: { turn: 1, step: 1, message: { role: 'developer', id: 'commander-takeover-1', content: [{ type: 'text', text: '[接管状态] …' }] } }, surfaceOp: 'append' },
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
      { type: 'step/start', seq: 7, data: { turn: 2, step: 1 } },
      { type: 'user/message', seq: 8, data: { role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    ]
    // 每 2 条一个帧，模拟真实的多帧追加
    const frames = []
    for (let i = 0; i < events.length; i += 2) {
      const chunk = events.slice(i, i + 2).map((e) => JSON.stringify(e)).join('\n') + '\n'
      frames.push(zstdCompressSync(Buffer.from(chunk, 'utf8')))
    }
    writeFileSync(file, Buffer.concat(frames))

    const raw = readFileSync(file)
    assert.ok(frameBounds(raw).length >= 5, '前置条件：输入应是多帧')

    const before = validate(events)
    assert.equal(before.length, 1, `构造的日志应恰好有 1 处违规，实际 ${before.length}`)

    execFileSync(process.execPath, [repairScript, file, '--drop-seq=5', '--apply', '--legacy-unsafe'], { stdio: 'pipe' })

    const fixed = readFileSync(file)
    const fixedBounds = frameBounds(fixed)
    assert.ok(fixedBounds.length >= 5, `修复后仍应是多帧，实际 ${fixedBounds.length}`)

    // 帧参数必须与宿主一致：带校验和、非 single-segment（descriptor 0x04）。
    // 用 Node 默认参数会写出 single_segment=1/checksum=0 的帧，宿主读不回来。
    const descriptor = fixed[fixedBounds[0].start + 4]
    assert.equal(descriptor, 0x04, `帧 descriptor 应为 0x04（宿主风格），实际 0x${descriptor.toString(16)}`)
    assert.equal((descriptor >> 2) & 1, 1, '帧必须带校验和')
    assert.equal((descriptor >> 5) & 1, 0, '帧不应该是 single-segment')

    const text = fixedBounds.filter((b) => !b.skippable).map((b) => zstdDecompressSync(fixed.subarray(b.start, b.end)).toString('utf8')).join('')
    const after = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.equal(after.length, events.length - 1, '应只丢弃 1 条事件')
    assert.equal(validate(after).length, 0, '修复后应通过校验')
    assert.equal(after.some((e) => e.type === 'developer/message'), false, '越界事件应被丢弃')
    const last = after[after.length - 1]
    assert.equal(last.type, 'user/message')
    assert.equal(last.seq, 7, '丢弃后其后 seq 应整体前移一位')
    assert.equal(last.data.content[0].text, '继续', '其余事件内容不应改变')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
console.log(`\nSESSION INTEGRITY CHECKS PASSED (${checks.length})`)
