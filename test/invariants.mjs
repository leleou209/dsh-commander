/**
 * 架构不变量（静态断言）。
 *
 * 这些不是"功能测试"，是**防止简化被悄悄改回去**的护栏。每一条都对应一个真 bug：
 *   - delivery 必须是 caller：否则宿主 notifySettlement 会唤醒主会话（初始化后自动开工）；
 *   - 初始化不得动 goal：否则 weak→weak 会静默暂停用户正在跑的目标；
 *   - 成员不得缓存：冷缓存就是「重启后图标不认指挥员」的根因；
 *   - 唤醒前必须重读挡位：否则退出全接管后在途回复仍会点燃主agent；
 *   - 子会话判定必须在首帧：否则图标会闪、fetch 失败还会残留。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('spawn 默认 delivery=caller（宿主完成推送已关）', () => {
  const source = read('lib/commander.js')
  assert.ok(source.includes("input.delivery === 'parent' ? 'parent' : 'caller'"), '默认必须是 caller')
  assert.ok(!/delivery:\s*'parent'\s*,\s*\n\s*\}\)/.test(source), '不得写死 parent')
})

check('初始化分支只落挡位：不碰 goal、不发通知', () => {
  const source = read('lib/routes.js')
  const start = source.indexOf("payload?.init === true")
  assert.ok(start > 0, '找不到 init 分支')
  const end = source.indexOf("if (req.method === 'POST') {", start)
  const block = source.slice(start, end > start ? end : start + 1200)
  assert.ok(block.length > 200, '切片太短，断言会失真')
  assert.ok(!block.includes('syncGoal'), 'init 不得动 goal')
  assert.ok(!block.includes('applyMode'), 'init 不得走切挡位路径（那条会动 goal）')
  assert.ok(block.includes("store.setMode(rootId, DEFAULT_MODE, 'init')"), 'init 只落地默认挡位')
})

check('切挡位只在参与级别变化时动 goal', () => {
  const source = read('index.js')
  assert.ok(source.includes('if (shouldSyncGoal(before ?? DEFAULT_MODE, next)) await syncGoal(agent, next)'))
})

check('成员不缓存：commander.js 里没有跨调用缓存容器', () => {
  const source = read('lib/commander.js')
  assert.ok(!/new Map\(/.test(source), '不得出现成员缓存 Map')
  // 用词边界：裸 /ttl/ 会命中 "set-ttl-ement" 这种注释词，造成误报。
  assert.ok(!/\bcoldProbeAt\b|\bttlMs\b|\bnegativeCache\b/.test(source), '不得出现负缓存/冷探测那套适配器')
  assert.ok(source.includes('await sub.listDescendants'), '必须每次按需向宿主查')
})

check('store 一个缓存两种访问器，不反向持有外部 Map', () => {
  const source = read('lib/store.js')
  assert.ok(!/map:\s*/.test(source), '不得由外部注入 Map（老包的反向持有）')
  assert.ok(source.includes('mode: (rootId) =>'), '必须有同步访问器给 tools.guard')
  assert.ok(source.includes('const ready = () =>'), '必须有 async 加载入口')
})

check('驱动唤醒前重读挡位', () => {
  const source = read('lib/driver.js')
  const guard = source.indexOf('shouldWakeParent({ mode: await deps.modeOf(agent)')
  const wake = source.indexOf('wake(agent, result.text')
  assert.ok(guard > 0, '必须有 shouldWakeParent 守卫')
  assert.ok(wake > guard, '守卫必须在唤醒之前')
})

check('工具与驱动共用同一套咨询握手', () => {
  assert.ok(read('lib/tools.js').includes("from './consult.js'"))
  assert.ok(read('index.js').includes("from './lib/consult.js'"))
  // 驱动自己的看门狗返回 timeout 是**合法**的；要禁的是「驱动内联一份等待实现」。
  assert.ok(read('index.js').includes('waitReply: (agent, requestId, signal) => waitReply(app, agent, requestId, signal)'), '驱动的 waitReply 必须接共享实现')
  assert.ok(read('lib/driver.js').includes('deps.waitReply('), '驱动必须通过依赖拿等待能力')
})

check('客户端子会话判定在外壳、首帧同步', () => {
  const source = read('lib/client.js')
  const slot = source.indexOf('function TakeoverSlot(props)')
  const badge = source.indexOf('function Badge(props)')
  assert.ok(slot > 0 && badge > slot, '外壳必须在 Badge 之前')
  const shell = source.slice(slot, badge)
  assert.ok(shell.includes('sessionIsChild(props)'), '外壳必须做子会话判定')
  assert.ok(!shell.includes('useState'), '外壳不得有 hooks（早退才安全）')
  assert.ok(source.includes('props.useSession') && source.includes('props.useSessions'), '必须用宿主 slot 的同步判据')
})

check('预热时长停在第一轮 turn/end', () => {
  const source = read('lib/preheat.js')
  assert.ok(source.includes("end !== undefined && typeof end.time === 'number'"), '终点必须取首个 turn/end')
})

check('解析到指挥员就登记并收紧（重启后不得留下未收紧的指挥员）', () => {
  const source = read('index.js')
  assert.ok(source.includes('remember(await findCommander('), 'find 必须走 remember')
  assert.ok(source.includes('const remember = (member) =>'), '必须有 remember 助手')
  assert.ok(!/commanderIds\.add\(existing\.id\)/.test(source), '不得再有「只登记不收紧」的分支')
})

check('路由必须等 webServer 就位（直取 ctx.get 会整片 404）', () => {
  const source = read('lib/routes.js')
  const tail = source.slice(source.indexOf('export function registerRoutes'))
  assert.ok(tail.includes("ctx.inject(['webServer']"), '必须用 ctx.inject 等 webServer 就位')
  assert.ok(!/const webServer = ctx\.get\('webServer'\)/.test(tail), '不得在注册处直取 webServer（取不到就 return，永远不再注册）')
})

check('cwd 解析优先会话自带的，绝不直取 workingDirectory.get(agent)', () => {
  const source = read('index.js')
  const start = source.indexOf('async function resolveCwd')
  assert.ok(start > 0, '找不到 resolveCwd')
  const block = source.slice(start, start + 1200)
  const own = block.indexOf('agent?.session?.cwd')
  const service = block.indexOf("service.get?.(agent?.session)")
  assert.ok(own > 0, '必须先看 agent.session.cwd')
  assert.ok(service > own, '服务调用只能作为兜底，且必须传 session 而不是 agent')
  assert.ok(!/service\.get\(agent,/.test(block), '不得把 agent 传给 workingDirectory.get')
  assert.ok(block.includes('logger?.warn?.('), '退回进程目录必须留告警（否则 doc 会被悄悄写到 profile 目录）')
})

check('index.js 只做装配：不含工具/路由/驱动的实现体', () => {
  const source = read('index.js')
  assert.ok(!source.includes('webServer.register({'), '路由实现应在 routes.js')
  assert.ok(!source.includes('ctx.tools.register('), '工具注册应在 tools.js')
  assert.ok(!source.includes('async function drive('), '驱动实现应在 driver.js')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
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
console.log(`\nINVARIANT CHECKS PASSED (${checks.length})`)
