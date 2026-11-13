/**
 * 状态文件加固测试（对应审计改进点 5）。
 *
 * 覆盖：权限 0600/0700、跨进程锁不覆盖、损坏隔离 `.broken-*`、
 * 旧版本迁移、表修剪。Windows 不支持 POSIX 权限位，权限断言会跳过。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { STATE_SCHEMA, createStateStore, migrateState } from '../state-store.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })
const isPosix = process.platform !== 'win32'

const tempState = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commander-state-'))
  return { dir, file: path.join(dir, 'state.json') }
}

check('写盘后文件 0600、目录 0700（POSIX）', async () => {
  const { dir, file } = await tempState()
  const store = await createStateStore({ path: file, pluginVersion: 'test' })
  await store.put('rounds', 'root', { count: 1, at: Date.now() })
  if (!isPosix) return
  const fileMode = (await fsp.stat(file)).mode & 0o777
  const dirMode = (await fsp.stat(dir)).mode & 0o777
  assert.equal(fileMode.toString(8), '600', 'state.json 必须是 0600')
  assert.equal(dirMode.toString(8), '700', '状态目录必须是 0700')
})

check('--fix 能把放宽的权限收回来（POSIX）', async () => {
  const { dir, file } = await tempState()
  const store = await createStateStore({ path: file, pluginVersion: 'test' })
  await store.put('rounds', 'root', { count: 1, at: Date.now() })
  if (!isPosix) return
  await fsp.chmod(file, 0o644)
  await fsp.chmod(dir, 0o755)
  const applied = await store.fixPerms()
  assert.ok(applied.length > 0)
  assert.equal(((await fsp.stat(file)).mode & 0o777).toString(8), '600')
  assert.equal(((await fsp.stat(dir)).mode & 0o777).toString(8), '700')
})

check('别的进程持锁时拒绝覆盖', async () => {
  const { file } = await tempState()
  const store = await createStateStore({ path: file, pluginVersion: 'test', lockWaitMs: 100 })
  await store.put('rounds', 'root', { count: 1, at: Date.now() })
  const before = await fsp.readFile(file, 'utf8')
  // 模拟另一个进程刚拿了锁
  await fsp.writeFile(`${file}.lock`, `${process.pid} ${Date.now()}\n`)
  const ok = await store.put('rounds', 'root', { count: 99, at: Date.now() })
  assert.equal(ok, false, '拿不到锁必须返回 false')
  assert.ok(String(store.state.writeError).includes('另一个进程'))
  assert.equal(await fsp.readFile(file, 'utf8'), before, '磁盘内容不能被覆盖')
  await fsp.unlink(`${file}.lock`).catch(() => {})
})

check('陈旧锁会被回收后继续写', async () => {
  const { file } = await tempState()
  const store = await createStateStore({ path: file, pluginVersion: 'test', lockWaitMs: 500, lockStaleMs: 50 })
  await fsp.writeFile(`${file}.lock`, 'stale\n')
  const old = new Date(Date.now() - 60_000)
  await fsp.utimes(`${file}.lock`, old, old)
  const ok = await store.put('rounds', 'root', { count: 2, at: Date.now() })
  assert.equal(ok, true, '陈旧锁应当被回收')
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).tables.rounds.root.count, 2)
})

check('损坏文件被隔离为 .broken-*，不覆盖原数据', async () => {
  const { dir, file } = await tempState()
  await fsp.writeFile(file, '{ this is not json')
  const store = await createStateStore({ path: file, pluginVersion: 'test' })
  assert.ok(String(store.state.readError).includes('解析失败'), '读错误必须被记录')
  assert.ok(store.state.brokenFile, '必须生成 broken 备份')
  const backups = (await fsp.readdir(dir)).filter((name) => name.includes('.broken-'))
  assert.equal(backups.length, 1, '备份文件应当存在')
  assert.equal(await fsp.readFile(store.state.brokenFile, 'utf8'), '{ this is not json', '备份必须是原始内容')
  await store.put('rounds', 'root', { count: 3, at: Date.now() })
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).tables.rounds.root.count, 3)
})

check('旧版本（2.9.7 的 version 字段）迁移后表完整', async () => {
  const { file } = await tempState()
  await fsp.writeFile(
    file,
    JSON.stringify({ version: '2.9.7', tables: { rounds: { root1: { count: 5 } }, pending: {} } }),
  )
  const store = await createStateStore({ path: file, pluginVersion: 'test' })
  assert.equal(store.state.migratedFrom, '2.9.7', '必须记录迁移来源')
  assert.equal(store.counts().rounds, 1, '旧表必须读进来')
  assert.equal(store.counts().pending, 0)
})

check('平铺格式（最老）也能读', () => {
  const migrated = migrateState({ rounds: { a: { count: 1 } }, interruptions: { b: { at: 1 } } })
  assert.equal(migrated.tables.rounds.a.count, 1)
  assert.equal(migrated.tables.interruptions.b.at, 1)
  assert.equal(migrated.schema, STATE_SCHEMA)
})

check('schema 3 的退役 takeover 表：读得进但不进内存，写一次就消失', async () => {
  const { file } = await tempState()
  await fsp.writeFile(
    file,
    JSON.stringify({
      schema: 3,
      version: '2.9.34',
      tables: {
        // 退役表：还留在旧文件里，不该被复活。
        takeover: { 'session-x': { state: 'full' } },
        rounds: { root1: { count: 7 } },
      },
    }),
  )
  const store = await createStateStore({ path: file, pluginVersion: 'test' })
  assert.equal(store.state.migratedFrom, 'schema 3', 'schema 变化必须记录迁移来源')
  assert.equal(store.counts().takeover, undefined, 'takeover 不在 STATE_TABLES 里')
  assert.equal(store.state.tables.takeover, undefined, '退役表不进内存')
  assert.equal(store.counts().rounds, 1, '活着的表照常读进来')
  await store.put('rounds', 'root1', { count: 8 })
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(onDisk.schema, STATE_SCHEMA)
  assert.equal(onDisk.tables.takeover, undefined, '落盘后退役表自然消失')
  assert.equal(onDisk.tables.rounds.root1.count, 8)
})

check('当前 schema 文件不算迁移（migratedFrom 为空）', async () => {
  const { file } = await tempState()
  await fsp.writeFile(file, JSON.stringify({ schema: STATE_SCHEMA, tables: { rounds: {} } }))
  const store = await createStateStore({ path: file, pluginVersion: 'test' })
  assert.equal(store.state.migratedFrom, undefined, '同版本不该报迁移')
})

check('修剪：每张表只保留最近 N 个会话', async () => {
  const { file } = await tempState()
  const store = await createStateStore({ path: file, pluginVersion: 'test', keepPerTable: 3 })
  const now = Date.now()
  for (let i = 0; i < 6; i += 1) {
    await store.put('rounds', `s${i}`, { count: i, at: now - (6 - i) * 1000 })
  }
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(Object.keys(saved.tables.rounds).length, 3, '只保留 3 个会话')
  assert.deepEqual(Object.keys(saved.tables.rounds).sort(), ['s3', 's4', 's5'], '保留的是最新的三个')
})

check('修剪：超过保留天数的记录被淘汰', async () => {
  const { file } = await tempState()
  const store = await createStateStore({ path: file, pluginVersion: 'test', keepDays: 1 })
  const now = Date.now()
  await store.put('interruptions', 'old', { at: now - 10 * 24 * 3600 * 1000 })
  await store.put('interruptions', 'fresh', { at: now })
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.deepEqual(Object.keys(saved.tables.interruptions), ['fresh'])
})

check('超过大小上限时备份后重置，不抛异常', async () => {
  const { file } = await tempState()
  await fsp.writeFile(file, JSON.stringify({ tables: { rounds: { a: { pad: 'x'.repeat(400) } } } }))
  const store = await createStateStore({ path: file, pluginVersion: 'test', maxBytes: 128 })
  assert.ok(String(store.state.readError).includes('超过上限'))
  assert.ok(store.state.brokenFile)
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
console.log(`\nSTATE STORE CHECKS PASSED (${checks.length})`)