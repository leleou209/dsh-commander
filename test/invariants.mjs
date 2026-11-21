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

check('startActivation 必须用 0.2.2 的扁平 spec（本机 0.2.2-rc.3 读 spec.parent.id）', () => {
  // 宿主 0.2.2-rc.3 的 startActivation 直接读 spec.parent.id / spec.maxDepth（扁平）；
  // 包进 request 内层会让它拿到 undefined，报 "Cannot read properties of undefined (reading 'id')"
  // ——本机新建指挥员失败就是这个。0.2.1 的嵌套契约已不再支持。
  const source = read('lib/commander.js')
  const start = source.indexOf('const spec = {')
  assert.ok(start > 0, '找不到扁平 spec 字面量')
  const end = source.indexOf('\n  }', start)
  assert.ok(end > start, '找不到 spec 收尾')
  const literal = source.slice(start, end)
  for (const key of ['provider', 'name', 'label', 'prompt', 'parent', 'delivery', 'signal', 'maxDepth']) {
    assert.ok(new RegExp(`^\\s*${key}:`, 'm').test(literal), `spec 顶层必须有 ${key}`)
  }
  assert.ok(!source.includes('buildActivationSpec'), '不得再有把字段包进 request 的适配函数')
  assert.ok(source.includes("const started = await sub.startActivation(spec)"), '要直接传扁平 spec')
  // label 绝不能是 undefined：宿主要写进 descriptor，undefined 过不了 JSON 往返。
  assert.ok(/label: input\.label \?\? input\.name/.test(source), 'label 必须兜底成 name')
  assert.ok(/maxDepth: input\.maxDepth \?\? 1/.test(source), 'maxDepth 必须显式给')
})

check('模型在建立时固定：文档不许再承诺"换模型不丢上下文"', () => {
  // README 曾经写着"指挥员可以自由换模型，而且不丢上下文"——宿主做不到，
  // 硬做的结果是子会话被写坏、连话都说不上。这条不变量防止那句话再被写回去。
  const readme = read('README.md')
  assert.ok(!readme.includes('不丢上下文'), 'README 不得再承诺"不丢上下文"')
  assert.ok(!/可以自由换模型/.test(readme), 'README 不得再承诺"自由换模型"')
  assert.ok(readme.includes('建立之前选定'), 'README 要说明模型在建立前选定')
  assert.ok(readme.includes('不可更改') || readme.includes('不能更换'), 'README 要说明建立后不可改')

  // 界面层：挡位面板里不许再有"指挥员模型"这个可点入口。
  const client = read('lib/client.js')
  assert.ok(!/\}, '指挥员模型'\)/.test(client), '客户端不得再有"指挥员模型"入口行')
  assert.ok(client.includes('模型（建立时固定）'), '客户端要把模型显示成只读信息')
  assert.ok(client.includes('选定后建立指挥员'), '未建立时要提示"选了就固定"')

  // 路由层：任何 route 请求都必须被拒绝。
  const routes = read('lib/routes.js')
  assert.ok(routes.includes("error: 'model-locked'"), '路由层必须明确拒绝换模型')
})

check('换模型 = 拆旧建新，且不许再往子会话写 model/selection', () => {
  // 原地换（append model/selection）会把子会话写坏：每换一次多一条选择，
  // 宿主 resume 时又补一个 session/end-seed，累积几次后 resume 直接失败
  // （实测 subagent "…" is unavailable，此后无法再与该指挥员通信）。
  const ops = read('lib/route-ops.js')
  assert.ok(!ops.includes('setCommanderRoute'), '不得再有原地换模型')
  assert.ok(ops.includes('recreateCommander'), '换模型入口要在')
  assert.ok(/disposeCommander\(/.test(ops), '必须先拆旧的')
  assert.ok(/ensureCommander\(/.test(ops), '再按新路由建新的')
  assert.ok(!ops.includes('selectModel('), '换模型不得再调 model.select')
  const idx = read('index.js')
  assert.ok(!idx.includes('applyDeferredRoute'), '不得有"延迟应用路由"（也是写坏会话的路径）')
  assert.ok(!idx.includes('selectModel'), '装配层不该再引用换模型函数')
})

check('建指挥员前必须区分"查不到"和"确实没有"（否则会造幽灵指挥员）', () => {
  // 云端真踩过：sessionQuery 里还没有会话投影时 listDescendants 抛错，
  // 老代码当成"没有指挥员"，于是初始化一遍遍新建，状态查询又读不到。
  const source = read('index.js')
  assert.ok(source.includes('findCommanderResult'), '必须用能区分查不到/确实没有的查找')
  assert.ok(source.includes('if (probe.unavailable)'), 'ensureCommander 必须先判 unavailable 再决定建不建')
  assert.ok(!/const existing = await find\(rootId, signal\)\s*\n\s*if \(existing !== undefined\) return existing/.test(source), '不得再用"找不到就建"的旧写法')
  // 判据必须是「会话本身读不到」，不是「没有 catalog 投影」——
  // 全新会话本来就没有投影，把它当读不到会让新会话永远建不出指挥员（本地回归过）。
  const lib = read('lib/commander.js')
  assert.ok(lib.includes("ctx.get('sessions')?.get?.(rootId)"), '会话在不在要问存储')
  assert.ok(!/NOT_FOUND_CODES\.has/.test(lib), '不得只凭 not-found 错误码判定读不到')
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
  // 现在多了一个"没有 Agent 时也允许改挡位"的分支：那时没有会话可同步 goal，
  // 所以前置 agent 非空判断是刻意的，不是绕过。
  assert.ok(
    source.includes('if (agent !== undefined && shouldSyncGoal(before ?? DEFAULT_MODE, next)) await syncGoal(agent, next)'),
    'syncGoal 必须仍然受 shouldSyncGoal 门控（且 agent 缺失时跳过）',
  )
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
  // 用正则容忍换行：意图是"必须经过 remember"，不是"必须写成一行"。
  assert.ok(/remember\(\s*await findCommander\(/.test(source), 'find 必须走 remember')
  assert.ok(source.includes('const remember = (member, rootId) =>'), '必须有 remember 助手，且要带上 rootId')
  assert.ok(!/commanderIds\.add\(existing\.id\)/.test(source), '不得再有「只登记不收紧」的分支')
})

check('同步门禁不得用进程级 commanderIds 判"本会话有没有指挥员"', () => {
  const source = read('index.js')
  assert.ok(!/commanderIds\.size\s*>\s*0/.test(source), '禁止拿集合大小当会话判据——任何会话建过指挥员就会污染全部新会话')
  assert.ok(source.includes('knownCommanderRoots.has(rootId)'), 'guard 必须按 rootId 判')
  assert.ok(source.includes('knownCommanderRoots.has(gateRootId)'), 'goalGateError 必须按 rootId 判')
  assert.ok(source.includes('knownCommanderRoots.add(rootId)'), 'remember 必须登记 rootId')
  assert.ok(source.includes('forgetCommander('), '指挥员销毁时必须回收 rootId，否则该会话永久误拦')
})

check('成员行按宿主契约读字段：名字优先 path，跳过非 continuable', () => {
  const source = read('lib/commander.js')
  const start = source.indexOf('function toRows')
  const block = source.slice(start, source.indexOf('/** 列出根会话下', start) > start ? source.indexOf('/** 列出根会话下', start) : start + 2000)
  assert.ok(block.length > 300, '切片太短，断言会失真')
  assert.ok(block.includes('entry.path'), '名字要优先读 path（宿主文档：path 携带完整名称）')
  assert.ok(block.includes("entry.mode !== 'continuable'"), '必须跳过不可续接的成员')
  assert.ok(block.includes('entry.activity'), 'status 要有 activity 兜底')
})

check('路由必须等 webServer 就位（直取 ctx.get 会整片 404）', () => {
  const source = read('lib/routes.js')
  const tail = source.slice(source.indexOf('export function registerRoutes'))
  assert.ok(tail.includes("ctx.inject(['webServer']"), '必须用 ctx.inject 等 webServer 就位')
  assert.ok(!/const webServer = ctx\.get\('webServer'\)/.test(tail), '不得在注册处直取 webServer（取不到就 return，永远不再注册）')
})

check('cwd 解析优先会话自带的，绝不直取 workingDirectory.get(agent)', () => {
  // resolveCwd 已搬进 lib/commander.js（和建立/查找指挥员放一起）
  const source = read('lib/commander.js')
  const start = source.indexOf('export async function resolveCwd')
  assert.ok(start > 0, '找不到 resolveCwd')
  const block = source.slice(start, start + 1200)
  const own = block.indexOf('agent?.session?.cwd')
  const service = block.indexOf("service.get?.(agent?.session)")
  assert.ok(own > 0, '必须先看 agent.session.cwd')
  assert.ok(service > own, '服务调用只能作为兜底，且必须传 session 而不是 agent')
  assert.ok(!/service\.get\(agent,/.test(block), '不得把 agent 传给 workingDirectory.get')
  assert.ok(block.includes('logger?.warn?.('), '退回进程目录必须留告警（否则 doc 会被悄悄写到 profile 目录）')
})

check('门禁必须覆盖原生 goal 工具，不能只挡自家通道', () => {
  const source = read('index.js')
  assert.ok(source.includes('nativeGoalAction(exec.name, exec.arguments)'), 'tools.guard 必须翻译原生 goal 工具')
  const gate = read('lib/gate.js')
  assert.ok(gate.includes("create_goal: 'create'") && gate.includes("update_goal: 'action'"), '两个原生 goal 工具都要认')
  // 顺带钉住：问用户的两个工具名、以及 off 下直连指挥员的拦截
  assert.ok(gate.includes("'request_user_input'"), '问用户工具名要多认一个')
  assert.ok(source.includes('directMessageDenial('), 'off 挡位要挡直连')
  assert.ok(source.includes('mode: store.mode(rootId), commanderName'), '直连拦截要用显式挡位，不能用推导值（否则重启后误拦）')
})

check('关系声明与「督促用 team」各只出现一次，别又长回去', () => {
  const prompt = read('lib/prompt.js')
  // 声明进工具说明（每个请求都带，所以只许一行）
  assert.ok(prompt.includes('RELATION_NOTE,'), '工具说明必须带上关系声明')
  assert.ok(prompt.includes('指挥员不影响 agent team 的运行'), '声明原文要保留')
  // 督促句进指挥员首轮提示词（一次性，不占每轮）
  assert.ok(prompt.includes('可以适度督促主会话使用 agent team'), '指挥员提示词要有这句')
  const noteLine = prompt.split('\n').find((line) => line.includes('export const RELATION_NOTE'))
  assert.ok(noteLine !== undefined)
  // 工具说明不许再膨胀：正文里一个 agent team 都不许写死，只能引用 RELATION_NOTE 那一行。
  const descStart = prompt.indexOf('export const TOOL_DESCRIPTION')
  const desc = prompt.slice(descStart, prompt.indexOf('].join', descStart))
  assert.ok(desc.length > 100, '切片太短，断言会失真')
  assert.equal((desc.match(/agent team/g) ?? []).length, 0, '工具说明正文不得再展开 agent team 论述')
  assert.equal((desc.match(/RELATION_NOTE/g) ?? []).length, 1, '工具说明只引用一次声明')
})

check('四大件是 agent/suggest/plan/history（README 不在其中），且初始化要带骨架', () => {
  // 口径（用户定的）：readme 已变成常驻门面，实例事实由 suggest.md 承担。
  const prompt = read('lib/prompt.js')
  const match = prompt.match(/DOC_FILES = \[([^\]]+)\]/)
  assert.ok(match, '找不到 DOC_FILES')
  const files = match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.deepEqual(files, ['agent.md', 'suggest.md', 'plan.md', 'history.md'], '四大件的顺序与集合')
  assert.ok(!files.includes('README.md'), 'README 不属于四大件')
  // 初始化必须给内容，不能只写一行标题
  const docs = read('lib/docs.js')
  assert.ok(docs.includes('const AGENT_MD'), 'agent.md 要有模板')
  assert.ok(docs.includes('const SUGGEST_MD'), 'suggest.md 要有模板')
  assert.ok(docs.includes('const PLAN_MD'), 'plan.md 要有模板')
  assert.ok(docs.includes('const HISTORY_MD'), 'history.md 要有模板')
  assert.ok(/writeFile\(full, scaffoldFor\(file\)/.test(docs) || docs.includes('scaffoldFor(file)'), '缺文件时要用模板')
})

check('配了模型就不能走 fork（fork 会静默丢弃模型参数）', () => {
  // providerOrder 已搬进 lib/llm.js（index.js 只做装配）
  const llmSource = read('lib/llm.js')
  assert.ok(llmSource.includes('export function providerOrder(config, agentOptions)'), '找不到 providerOrder')
  assert.ok(llmSource.includes("return ['spawn']"), '有模型配置时必须只给 spawn')
  const source = read('index.js')
  // 判据必须来自 buildAgentOptions（现在由调用方先算好、带着 route override 一起传进来）。
  // `let` 是因为建立前还会过一次路由校验（不支持的 effort 会被丢掉，靠重新赋值）。
  assert.ok(/(?:const|let) agentOptions = buildAgentOptions\(config, store\.route\(rootId\)\)/.test(source), '判据要来自 buildAgentOptions 且带上会话覆盖')
  assert.ok(source.includes('const order = providerOrder(config, agentOptions)'), 'providerOrder 要收到同一个 agentOptions')
  // agentOptions 必须真的传下去，否则配置形同虚设
  assert.ok(source.includes('prompt, provider, signal, agentOptions,'), 'ensureCommander 要把 agentOptions 传给 spawnCommander')
  assert.ok(read('lib/commander.js').includes('spec.agentOptions = input.agentOptions'), 'spawnCommander 要把它塞进 startActivation')
})

check('LLM 路由的判定只在 lib/llm.js，装配文件不得自带实现', () => {
  const source = read('index.js')
  for (const marker of ['resolveCallConfig', 'listProviders', 'listModels']) {
    assert.ok(!source.includes(marker), `index.js 不该出现 ${marker}（实现应在 lib/llm.js）`)
  }
  assert.ok(read('lib/llm.js').includes('resolveCallConfig'), 'lib/llm.js 才是校验路由的地方')
})

check('index.js 只做装配：不含工具/路由/驱动的实现体', () => {
  const source = read('index.js')
  assert.ok(!source.includes('webServer.register({'), '路由实现应在 routes.js')
  assert.ok(!source.includes('ctx.tools.register('), '工具注册应在 tools.js')
  assert.ok(!source.includes('async function drive('), '驱动实现应在 driver.js')
})

check('goal 引用必须是宿主形状 { id, revision }（写错会被当成并发冲突）', () => {
  // 宿主的 GoalRef 是 `{ id, revision }`。写成 `{ goalId, expectedRevision }` 时
  // 宿主只报 `stale goal ref "undefined" revision undefined`——看起来像并发冲突，
  // 实际每一次 edit / pause / complete 都失败：goal 静默留在 active，
  // full 的接管标签也不更新。这类错必须在静态层钉住，光靠 mock 测不出来。
  for (const file of ['index.js', 'lib/tools.js', 'lib/goal-link.js', 'lib/driver.js', 'lib/preheat.js', 'lib/commander.js']) {
    // 只看代码，不看注释：注释里解释"别写成 expectedRevision"是应该的。
    const source = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!source.includes('expectedRevision'), `${file} 不得再用 expectedRevision`)
    assert.ok(!/\bgoalId\s*:/.test(source), `${file} 不得再用 goalId: 形状`)
  }
  assert.ok(
    read('lib/goal-link.js').includes('{ id: goal.id, revision: goal.revision }'),
    'goal-link 要按 { id, revision } 建 ref',
  )
  assert.ok(
    read('lib/tools.js').includes('{ id: goal.id, revision: goal.revision }'),
    'tools 要按 { id, revision } 建 ref',
  )
  // mock 也必须硬校验形状：否则 mock 和实现一起写错，测试照样全绿。
  assert.ok(read('test/goal-link.mjs').includes('ref?.id'), 'goal-link 的 mock 要校验 ref.id')
  assert.ok(read('test/load.mjs').includes('assertGoalRef'), 'load 的 mock 要校验 ref 形状')
  // clear 必须用宿主的 clear（墓碑）；complete 只是标记完成，不能冒充清理。
  assert.ok(
    read('lib/tools.js').includes("typeof goals.clear === 'function'"),
    'goalAction=clear 要用宿主的 clear，不能拿 complete 冒充',
  )
})

check('切 full 补一次驱动；退场中断在途等待；唤醒只在 driver.js', () => {
  const indexSource = read('index.js')
  assert.ok(indexSource.includes('shouldDriveOnTakeover('), 'applyMode 必须用统一判据决定要不要补驱动')
  assert.ok(indexSource.includes('state.turnEnded = true'), '补驱动前必须置 turnEnded（否则交接判定永远不放行）')
  assert.ok(indexSource.includes('app.driver?.cancelWait(agent)'), '退出 full 必须收口在途等待')
  assert.ok(read('lib/handoff.js').includes("goalPhase === 'active'"), '只有切换前 active 的 goal 才补驱动')
  assert.ok(read('lib/driver.js').includes('cancelWait(agent)'), 'driver 必须暴露 cancelWait')
  // 唤醒主agent 只允许一处实现：别的文件自己 followup 就会出现「谁点亮了主会话」查不清。
  for (const file of ['index.js', 'lib/tools.js', 'lib/commander.js', 'lib/routes.js', 'lib/consult.js']) {
    assert.ok(!read(file).includes('.followup('), `${file} 不得自己唤醒主agent（只在 lib/driver.js）`)
  }
})

check('协议只认头块：正文里的决定/批准/放行不算', () => {
  const source = read('lib/protocol.js')
  assert.ok(source.includes('export function headerBlock'), '必须有「头块」定义')
  assert.ok(source.includes('headerBlock(body).find('), 'parseDecision 只扫头块')
  assert.ok(source.includes('headerBlock(text).join'), 'hasRelease 只扫头块')
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
