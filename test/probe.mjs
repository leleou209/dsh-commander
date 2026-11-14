/**
 * 客户端自证探针单测（2.9.56）。
 *
 * 判据：只记元信息（不记会话内容）+ 4KB 上限 + 环形裁剪 + **探针自身故障不许 500**。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendProbeLine, createClientProbe, sanitizeProbeEvent } from '../lib/client-probe.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** 假 req：把 body 当一次 data + end 事件发出来。 */
function makeReq({ method = 'POST', body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.destroy = () => {}
  setTimeout(() => {
    if (body.length > 0) req.emit('data', body)
    req.emit('end')
  }, 0)
  return req
}

/** 假 res：记录状态码与 body。 */
function makeRes() {
  const res = { status: 200, headers: null, payload: '' }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (payload) => {
    res.payload = payload
  }
  return res
}

check('脱敏：只保留白名单字段，未知事件归一，error 截断到 200', () => {
  const entry = sanitizeProbeEvent({ event: 'render-error', error: 'x'.repeat(500), sessionId: 's1', secret: 'user text' })
  assert.equal(entry.event, 'render-error')
  assert.equal(entry.error.length, 200)
  assert.equal(entry.hasSession, true)
  assert.ok(!('secret' in entry), '不得落任何会话内容字段')
  assert.equal(sanitizeProbeEvent({ event: 'nope' }).event, 'unknown')
})

check('环形裁剪：超过上限只保留最后 N 行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'commander-probe-'))
  const file = join(dir, 'probe.jsonl')
  try {
    for (let i = 0; i < 5; i += 1) await appendProbeLine(file, JSON.stringify({ n: i }), 3)
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    assert.equal(lines.length, 3)
    assert.deepEqual(JSON.parse(lines[2]), { n: 4 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('处理器：POST 落盘、GET 回读、超 4KB 拒绝、目录不可写降级也不 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'commander-probe2-'))
  const file = join(dir, 'probe.jsonl')
  try {
    const probe = createClientProbe({ file, log: () => {} })
    const post = makeRes()
    await probe.handle(makeReq({ body: JSON.stringify({ event: 'load', sessionSource: 'p' }) }), post, new URL('http://x/commander/takeover/client-probe'))
    assert.equal(post.status, 200)
    const get = makeRes()
    await probe.handle(makeReq({ method: 'GET' }), get, new URL('http://x/commander/takeover/client-probe'))
    const body = JSON.parse(get.payload)
    assert.equal(body.entries.length, 1)
    assert.equal(body.entries[0].event, 'load')

    const tooBig = makeRes()
    await probe.handle(makeReq({ body: JSON.stringify({ event: 'load', pad: 'x'.repeat(5000) }) }), tooBig, new URL('http://x/p'))
    assert.equal(tooBig.status, 413)

    // 指向一个必然不可写的路径：探针必须降级而不是抛错/500
    const broken = createClientProbe({ file: join(dir, 'a', '\u0000bad', 'probe.jsonl'), log: () => {} })
    const degraded = makeRes()
    await broken.handle(makeReq({ body: JSON.stringify({ event: 'ready' }) }), degraded, new URL('http://x/p'))
    assert.equal(degraded.status, 200)
    assert.equal(JSON.parse(degraded.payload).degraded, true)
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
console.log(`\nPROBE CHECKS PASSED (${checks.length})`)
