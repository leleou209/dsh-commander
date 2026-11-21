/**
 * 存储：async 落盘 + 同步快照（只给 tools.guard）、损坏隔离、pending 生命周期。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const tempFile = async () => path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-')), 'state.json')
const flush = () => new Promise((done) => setTimeout(done, 60))

check('挡位：写入立刻同步可见，并落盘', async () => {
  const file = await tempFile()
  const store = createStore({ path: file })
  await store.ready()
  assert.equal(store.mode('root-1'), undefined)
  assert.equal(store.setMode('root-1', 'partial', 'user'), true)
  assert.equal(store.mode('root-1'), 'partial', '同步读路径必须立刻看到')
  assert.equal(store.modeRecord('root-1').source, 'user')
  await flush()
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(onDisk.modes['root-1'].mode, 'partial')
})

check('挡位跨进程恢复：新 store 读回上次写的值', async () => {
  const file = await tempFile()
  const first = createStore({ path: file })
  await first.ready()
  first.setMode('root-9', 'full', 'user')
  await flush()
  const second = createStore({ path: file })
  await second.ready()
  assert.equal(second.mode('root-9'), 'full', '重启后挡位必须还在')
})

check('非法挡位不写；clearMode 清得掉', async () => {
  const file = await tempFile()
  const store = createStore({ path: file })
  await store.ready()
  assert.equal(store.setMode('r', 'nonsense'), false)
  assert.equal(store.setMode(undefined, 'full'), false)
  store.setMode('r', 'off')
  store.clearMode('r')
  assert.equal(store.mode('r'), undefined)
  await flush()
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(onDisk.modes.r, undefined)
})

check('pending：写读删，删不存在的返回 false', async () => {
  const file = await tempFile()
  const store = createStore({ path: file })
  await store.ready()
  assert.equal(store.pending('r'), undefined)
  store.setPending('r', { requestId: 'req-1', processId: process.pid })
  assert.equal(store.pending('r').requestId, 'req-1')
  assert.equal(store.deletePending('r'), true)
  assert.equal(store.deletePending('r'), false)
  await flush()
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).pending.r, undefined)
})

check('pending 清理：发起进程已退出的条目在加载时丢掉，本进程的保留', async () => {
  const file = await tempFile()
  await fsp.writeFile(file, JSON.stringify({
    schema: 1,
    pending: {
      dead: { requestId: 'req-dead', processId: 999999 },
      live: { requestId: 'req-live', processId: process.pid },
      broken: { requestId: 'req-broken' },
    },
  }), 'utf8')
  const store = createStore({ path: file })
  await store.ready()
  assert.equal(store.pending('dead'), undefined, '死进程留下的 pending 必须丢掉')
  assert.equal(store.pending('broken'), undefined, '没有 processId 的无法确认接收方，也丢')
  assert.equal(store.pending('live')?.requestId, 'req-live', '本进程发起的 pending 要保留')
})

check('pending 清理：PID 被复用也算陈旧（靠时间闸兜底）', async () => {
  const file = await tempFile()
  const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000
  // process.ppid 几乎一定是活的，用它模拟"PID 被别的进程占用了"的死请求
  await fsp.writeFile(file, JSON.stringify({
    schema: 1,
    pending: {
      reused: { requestId: 'req-reused', processId: process.ppid, sentAt: thirteenHoursAgo },
      fresh: { requestId: 'req-fresh', processId: process.ppid, sentAt: Date.now() },
    },
  }), 'utf8')
  const store = createStore({ path: file })
  await store.ready()
  assert.equal(store.pending('reused'), undefined, '活 PID + 超过 12 小时 → 当陈旧丢弃')
  assert.equal(store.pending('fresh')?.requestId, 'req-fresh', '活 PID + 新鲜 → 保留')
})

check('损坏文件：备份后从空状态继续，绝不抛', async () => {
  const file = await tempFile()
  await fsp.writeFile(file, '{ 这不是 JSON', 'utf8')
  const warnings = []
  const store = createStore({ path: file, logger: { warn: (line) => warnings.push(line) } })
  await store.ready()
  assert.equal(store.mode('anything'), undefined)
  assert.equal(warnings.length, 1)
  const dir = await fsp.readdir(path.dirname(file))
  assert.ok(dir.some((name) => name.includes('.broken-')), '损坏文件必须留证')
})

check('缺文件不算错误；ready 幂等', async () => {
  const file = await tempFile()
  const warnings = []
  const store = createStore({ path: file, logger: { warn: (line) => warnings.push(line) } })
  await store.ready()
  await store.ready()
  assert.equal(warnings.length, 0)
  assert.deepEqual(store.snapshot(), { modes: 0, pending: 0 })
})

check('预热代价跨进程保留（活的读不到时靠它）', async () => {
  const file = await tempFile()
  const first = createStore({ path: file })
  await first.ready()
  assert.equal(first.setPreheat('r1', { state: 'done', ms: 5135, steps: 2, tools: 5, tokens: { total: 44189, cacheRead: 271360 } }), true)
  await flush()
  const second = createStore({ path: file })
  await second.ready()
  const record = second.preheat('r1')
  assert.equal(record?.ms, 5135)
  assert.equal(record?.tokens?.total, 44189)
  assert.equal(second.preheat('nobody'), undefined)
})

check('落盘失败只记日志，不影响内存生效', async () => {
  // 把 state.json 的父路径指向一个已存在的**文件**，mkdir 必然失败。
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmdr-core-bad-'))
  const blocker = path.join(dir, 'blocker')
  await fsp.writeFile(blocker, 'x', 'utf8')
  const warnings = []
  const store = createStore({ path: path.join(blocker, 'state.json'), logger: { warn: (line) => warnings.push(line) } })
  await store.ready()
  store.setMode('r', 'full')
  assert.equal(store.mode('r'), 'full', '磁盘坏了也要让挡位在内存里生效')
  await flush()
  assert.ok(warnings.some((line) => line.includes('保存失败')))
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
console.log(`\nSTORE CHECKS PASSED (${checks.length})`)
