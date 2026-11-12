// dsh-commander 离线验证：teammate + pending 请求 + 无超时 wait + cancel。
// 运行：node test/offline.mjs
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import assert from 'node:assert/strict'

const plugin = await import('../index.js')

const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'commander-wait-test-'))
const listeners = new Map()
const tools = new Map()
const guards = []
const commands = new Map()
const emit = (event, ...args) => {
  for (const handler of listeners.get(event) ?? []) handler(...args)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeAgent(id, rootFlag) {
  const restricted = []
  const visible = new Set([
    'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch',
    'write', 'edit', 'apply_patch', 'pwsh', 'send_message', 'list_agents', 'ask_user_question',
  ])
  return {
    id,
    session: { id, header: rootFlag ? { id } : { id, parentSession: 'root-1' }, seq: 0, events: [] },
    ctx: {
      tools: {
        get: (name) => (visible.has(name) ? { name } : undefined),
        restrict: (filter) => {
          restricted.push(filter)
          return () => {}
        },
      },
    },
    restricted,
    status: 'idle',
  }
}

const rootAgent = makeAgent('root-1', true)
const nonRootAgent = makeAgent('child-x', false)

const commanderSession = {
  id: 'teammate-1',
  header: { id: 'teammate-1', parentSession: 'root-1' },
  seq: 0,
  events: [],
  snapshotEvents(fromSeq) {
    return this.events.filter((event) => event.seq >= fromSeq)
  },
}
const commanderAgent = { id: 'teammate-1', status: 'inactive', session: commanderSession }
const descendantSession = { id: 'child-done', header: { id: 'child-done', parentSession: 'root-1' }, seq: 0, events: [] }

const lastRequestId = () => {
  const text = sentMessages[sentMessages.length - 1]?.text ?? ''
  const match = /\[REQ\s+(req-[A-Za-z0-9-]+)\]/.exec(text)
  return match ? match[1] : ''
}

function replyFromCommander(text, time = Date.now(), requestId = lastRequestId()) {
  let body = text
  if (!/^请求\s*[:：]/m.test(text)) {
    const newline = text.indexOf('\n')
    body = newline >= 0
      ? `${text.slice(0, newline + 1)}请求：${requestId}\n${text.slice(newline + 1)}`
      : `${text}\n请求：${requestId}`
  }
  commanderSession.seq += 1
  commanderSession.events.push({
    seq: commanderSession.seq,
    type: 'assistant/message',
    time,
    data: { message: { content: [{ type: 'text', text: body }] } },
  })
  commanderSession.seq += 1
  emit('session/event', commanderSession, { type: 'turn/end', time, seq: commanderSession.seq })
  commanderAgent.status = 'inactive'
}

const lastCodeState = () => {
  const text = sentMessages[sentMessages.length - 1]?.text ?? ''
  const match = /\[CODE_STATE\s+([A-Za-z0-9-]+)\]/.exec(text)
  return match ? match[1] : ''
}

const goalState = { current: undefined }
const goalCalls = []
const selectCalls = []
const goals = {
  get: () => goalState.current,
  create: (agent, request) => {
    goalCalls.push({ op: 'create', request })
    goalState.current = { id: 'goal-1', revision: 1, objective: request.objective, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 256 }
    return { ...goalState.current }
  },
  edit: () => {
    goalCalls.push({ op: 'edit' })
    throw new Error('不应 edit goal')
  },
  resume: () => {
    goalCalls.push({ op: 'resume' })
    goalState.current = { ...goalState.current, phase: 'active', activation: 'armed', revision: (goalState.current?.revision ?? 0) + 1 }
    return { ...goalState.current }
  },
  pause: () => {
    goalCalls.push({ op: 'pause' })
    goalState.current = { ...goalState.current, phase: 'paused', activation: 'disarmed', revision: (goalState.current?.revision ?? 0) + 1 }
    return { ...goalState.current }
  },
  block: (agent, ref, reason) => {
    goalCalls.push({ op: 'block', reason })
    goalState.current = {
      ...goalState.current,
      phase: 'blocked',
      activation: 'disarmed',
      blockedReason: reason,
      revision: (goalState.current?.revision ?? 0) + 1,
    }
    return { ...goalState.current }
  },
  complete: () => {
    goalCalls.push({ op: 'complete' })
    goalState.current = { ...goalState.current, phase: 'complete', activation: 'disarmed', revision: (goalState.current?.revision ?? 0) + 1 }
    return { ...goalState.current }
  },
  clear: () => {
    goalCalls.push({ op: 'clear' })
    goalState.current = undefined
    return { id: 'goal-1', revision: 1 }
  },
}

const resetGoalActive = () => {
  goalState.current = { ...goalState.current, phase: 'active', activation: 'armed', revision: (goalState.current?.revision ?? 0) + 1 }
}

const members = [{ id: 'root-1', name: 'lead', role: 'lead', status: 'running' }]
const spawnCalls = []
const sentMessages = []
const agentTeams = {
  membership(agent) {
    const member = members.find((row) => row.id === agent.id)
    return member ? { role: member.role, name: member.name, root: { id: 'root-1' } } : undefined
  },
  listMembers: () => members.map((row) => ({ ...row })),
  async spawnTeammate(caller, request) {
    spawnCalls.push({ caller: caller.id, request })
    const member = { id: 'teammate-1', name: request.name, role: 'teammate', status: 'provisioning' }
    members.push(member)
    const agent = makeAgent(member.id, false)
    for (const fn of listeners.get('agent/created') ?? []) await fn({ agent })
    return { member: { ...member, status: 'inactive' } }
  },
  async sendMessage(caller, request) {
    sentMessages.push({ caller: caller.id, target: request.target, text: request.content?.[0]?.text ?? '' })
    commanderAgent.status = 'running'
    return 'msg-1'
  },
}

const sessions = new Map([
  ['root-1', rootAgent.session],
  ['teammate-1', commanderSession],
  ['child-done', descendantSession],
])
const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commander-state-test-'))
const statePath = path.join(stateDir, 'state.json')
const readState = async () => {
  try {
    return JSON.parse(await fsp.readFile(statePath, 'utf8'))
  } catch {
    return { tables: { pending: {}, interruptions: {}, approvals: {}, rounds: {} } }
  }
}
// 宿主 storage 的假实现（插件已改用自有状态文件，这里只验证不再依赖它也不会崩）。
const kvData = { tables: { pending: {}, interruptions: {}, approvals: {}, rounds: {} } }
const kvUnit = {
  loadAll: async () => ({ tables: kvData.tables, global: undefined }),
  putRecord: async (table, key, value) => {
    kvData.tables[table][key] = value
  },
  deleteRecord: async (table, key) => {
    delete kvData.tables[table][key]
  },
  close: async () => {},
}
const storageService = {
  form: (name) => (name === 'kv' ? { open: async () => kvUnit } : undefined),
}
const agentsService = {
  roots: () => [rootAgent],
  list: () => [rootAgent, commanderAgent],
  get: (id) => (id === 'root-1' ? rootAgent : id === 'teammate-1' ? commanderAgent : undefined),
}

const fakeCtx = {
  effect(executor) {
    executor()
    return () => {}
  },
  on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event) ?? []
      listeners.set(event, current.filter((item) => item !== handler))
    }
  },
  inject(_deps, callback) {
    callback(fakeCtx)
    return () => {}
  },
  get(name) {
    const services = {
      agents: agentsService,
      goals,
      agentTeams,
      sessions: { get: (id) => sessions.get(id) },
      workingDirectory: { get: () => cwd, ensure: async () => cwd },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
      storage: storageService,
      sessionController: {
        selectModel: async (request) => {
          selectCalls.push(request)
          return { selected: { provider: request.provider, model: request.model } }
        },
      },
    }
    return services[name]
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    guard(guard) {
      guards.push(guard)
      return () => {}
    },
  },
  commands: {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  },
  logger: { info() {}, warn() {}, error() {} },
  subagents: { list: () => [], getProvider: () => undefined, listChildren: async () => [] },
}

plugin.apply(fakeCtx, {
  provider: 'spawn',
  debug: true,
  statePath,
  advisorProvider: 'fake-provider',
  advisorModel: 'fake-model',
  checkCommands: ['echo-hi = echo hi', 'fail = node -e "process.exit(3)"', 'slow = node -e "setTimeout(()=>{},5000)"'],
  checkTimeoutMs: 1200,
})
assert.deepEqual(plugin.inject, ['tools', 'subagents'])
assert.ok(tools.has('commander') && tools.has('commander_record'))

const commander = tools.get('commander')
const record = tools.get('commander_record')
const exec = (agent) => ({ agent, signal: new AbortController().signal })

// 1) status without teammate
let value = await commander.execute({ action: 'status' }, exec(rootAgent))
assert.ok(value.text.includes('指挥员模式状态'))
assert.ok(value.text.includes('未完成请求：（无）'))

// 2) start creates teammate once + goal once
value = await commander.execute({ action: 'start' }, exec(rootAgent))
assert.equal(value.target, 'commander')
assert.equal(spawnCalls.length, 1)
assert.equal(spawnCalls[0].request.name, 'commander')
assert.ok(spawnCalls[0].request.description.includes('指挥员'), 'new teammate description is 指挥员')
assert.equal(goalCalls.filter((call) => call.op === 'create').length, 1)
assert.equal(selectCalls.length, 1, 'start selects configured advisor model')
assert.equal(selectCalls[0].provider, 'fake-provider')
assert.equal(selectCalls[0].model, 'fake-model')
assert.equal(selectCalls[0].sessionId, 'teammate-1')
assert.ok(spawnCalls[0].request.prompt[0].text.includes('写文件'))
assert.ok(spawnCalls[0].request.prompt[0].text.includes('自己决定'))
assert.ok(spawnCalls[0].request.prompt[0].text.includes('批次'), 'prompt defines batch rhythm')
assert.ok(spawnCalls[0].request.prompt[0].text.includes('请求：'), 'prompt requires request id echo')

const teammateAgent = { id: 'teammate-1' }
const approvalGuard = guards[0]
const guard = guards[1]
// 2.9.12 起问用户门禁只对「全接管」生效：goal active 时是 partial，应当放行。
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} }),
  undefined,
  'partial takeover does not block asking the user',
)
const takeoverCmd = commands.get('commander')
await takeoverCmd.handler({
  commandId: 'takeover',
  agent: rootAgent,
  rawInput: 'takeover full',
  attachments: [],
  signal: new AbortController().signal,
})
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} })).includes('全接管'),
  'full takeover blocks asking the user until consulted',
)
await takeoverCmd.handler({
  commandId: 'takeover',
  agent: rootAgent,
  rawInput: 'takeover partial',
  attachments: [],
  signal: new AbortController().signal,
})
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'goal complete blocked without release',
)
assert.equal(guard({ agent: teammateAgent, name: 'read' }), undefined)
assert.equal(guard({ agent: teammateAgent, name: 'write', arguments: { file_path: 'doc/plan.md' } }), undefined, 'write inside doc allowed')
assert.ok(
  String(guard({ agent: teammateAgent, name: 'write', arguments: { file_path: 'index.js' } })).includes('写权限仅限'),
  'write outside doc denied',
)
assert.ok(
  String(guard({ agent: teammateAgent, name: 'apply_patch', arguments: { input: '*** Begin Patch' } })).includes('写权限仅限'),
  'apply_patch without doc path denied',
)
assert.ok(String(guard({ agent: teammateAgent, name: 'run_code' })).includes('拒绝'))
assert.equal(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: 'git status --short' } }), undefined)
assert.equal(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: "Get-Content 'pnpm-workspace.yaml'" } }), undefined)
assert.ok(String(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: 'npm run build' } })).includes('只读'))
assert.ok(String(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: 'git commit -m x' } })).includes('只读'))

// 2d) 管道/分号拆分也只看引号外（2.9.11）
for (const cmd of [
  "Select-String -Pattern 'a|b' index.js", // 引号内的 | 是正则
  'rg "x||y" src',
  'cat index.js | wc -l', // 真管道，但两段都在白名单
  'git status && git log --oneline -1',
]) {
  assert.equal(
    guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: cmd } }),
    undefined,
    `${cmd} 应放行`,
  )
}
for (const cmd of ['cat index.js | npm run build', 'git status; npm run build']) {
  assert.ok(
    String(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: cmd } })).includes('只读'),
    `${cmd} 的第二段应被拒绝`,
  )
}

// 2c) 重定向识别只看「引号外、且真写文件」的 >（2.9.11）
for (const cmd of [
  "git log --format='%h %an <%ae>'", // 尖括号是数据
  'git log --format="%h <%ae>"',
  'git status 2>&1', // 文件描述符复制
  'git log >$null', // 空设备
  'git log >/dev/null',
]) {
  assert.equal(
    guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: cmd } }),
    undefined,
    `${cmd} 不应被当成重定向`,
  )
}
for (const cmd of ['git log > out.txt', 'git log 2> err.txt', 'git log >> log.txt']) {
  assert.ok(
    String(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: cmd } })).includes('重定向'),
    `${cmd} 应被拒绝`,
  )
}

// 2b) 只读 shell 白名单：补了校验/元数据命令，仍挡住会写文件的用法（P2-5）
for (const cmd of [
  'git status --short',
  'git -C . status --short',
  'git -c core.pager=cat -C . log --oneline -3',
  'git --no-pager diff',
  'sha256sum index.js',
  'stat index.js',
  'date +%s',
  'sed -n 1,5p index.js',
]) {
  assert.equal(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: cmd } }), undefined, cmd + ' 应放行')
}
for (const cmd of ['node -e "1"', 'sed -i s/a/b/ index.js', 'git -C . commit -m x']) {
  assert.ok(
    String(guard({ agent: teammateAgent, name: 'pwsh', arguments: { command: cmd } })).includes('只读'),
    cmd + ' 应被拒绝',
  )
}

// 3) start again adopts
value = await commander.execute({ action: 'start' }, exec(rootAgent))
assert.equal(spawnCalls.length, 1)
assert.ok(value.text.includes('已就绪'))

// 4) say registers pending and includes requestId
value = await commander.execute({ action: 'say', message: '评估当前状态' }, exec(rootAgent))
assert.equal(value.action, 'say')
assert.equal(value.target, 'commander')
const requestId = value.requestId
assert.ok(/^req-/.test(requestId))
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} }),
  undefined,
  'asking user is allowed after consulting commander',
)
assert.ok(value.text.includes('wait'))
assert.equal(spawnCalls.length, 1)
assert.equal(sentMessages.length, 1)
assert.ok(sentMessages[0].text.startsWith(`[REQ ${requestId}]`), 'message carries request id')

// duplicate say rejected while pending
let threw = false
try {
  await commander.execute({ action: 'say', message: '再来一次' }, exec(rootAgent))
} catch (error) {
  threw = /已有未完成的指挥请求/.test(String(error && error.message))
}
assert.equal(threw, true, 'second say rejected while pending')

// status shows pending
value = await commander.execute({ action: 'status' }, exec(rootAgent))
assert.ok(value.text.includes(requestId), 'status shows pending request')

// 5) wait returns interrupt on another child turn/end, keeps pending
let waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
emit('session/event', descendantSession, { type: 'turn/end', seq: 1 })
let waited = await waitPromise
assert.equal(waited.action, 'wait')
assert.equal(waited.kind, 'interrupt')
assert.ok(waited.text.includes('child-done'))
assert.equal(goalCalls.filter((call) => call.op === 'create').length, 1, 'wait does not create goal')

// pending still there after interrupt
value = await commander.execute({ action: 'status' }, exec(rootAgent))
assert.ok(value.text.includes(requestId))

// 6) wait again until commander replies
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander(`决定：允许结束\n适用状态：${lastCodeState()}\n指挥结论：继续推进 A 工程组`)
waited = await waitPromise
assert.equal(waited.kind, 'reply')
assert.equal(waited.decision, '允许结束')
// 「允许结束」会被 wait 自动 complete；重置成 active 才能继续验证门禁
resetGoalActive()
assert.ok(waited.text.includes('指挥结论'))
assert.equal(waited.requestId, requestId)
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } }),
  undefined,
  'allow end permits goal complete',
)
assert.ok((await readState()).tables.approvals['root-1']?.codeState, 'approval persisted to state file with code state')
approvalGuard({ agent: rootAgent, name: 'write', arguments: {} })
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'write invalidates approval',
)

// grandchild write must invalidate the root Lead approval (multi-level parent chain)
value = await commander.execute({ action: 'say', message: '再批一次' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander(`决定：允许结束\n适用状态：${lastCodeState()}\n验收结论：x\n验证证据：y\n未完成必做项：无\n已知限制：无`)
waited = await waitPromise
assert.equal(waited.decision, '允许结束')
// 「允许结束」会被 wait 自动 complete；重置成 active 才能继续验证门禁
resetGoalActive()
const grandchildSession = { id: 'grandchild', header: { id: 'grandchild', parentSession: 'teammate-1' }, seq: 0, events: [] }
sessions.set('grandchild', grandchildSession)
approvalGuard({ agent: { id: 'grandchild', session: grandchildSession }, name: 'write', arguments: { path: 'index.js' } })
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'grandchild write invalidates root approval',
)

// markdown emphasis on the decision line must still be recognized
value = await commander.execute({ action: 'say', message: '加粗决策测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander(`**决定：允许结束**\n适用状态：${lastCodeState()}\n批准：goal edit`)
waited = await waitPromise
assert.equal(waited.decision, '允许结束', 'bold decision line recognized')
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'edit' } }),
  undefined,
  'goal edit approval is honored',
)
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'edit' } })).includes('需要指挥员批准'),
  'goal approval is one-shot',
)
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'resume' } })).includes('只能由你'),
  'resume is always user-only',
)


assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效') === false,
  'bold allow end grants approval',
)
approvalGuard({ agent: rootAgent, name: 'write', arguments: { file_path: 'doc/plan.md' } })

// value-only emphasis must also parse
value = await commander.execute({ action: 'say', message: '值加粗测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：**继续**\n下一轮：补真实冒烟。')
waited = await waitPromise
assert.equal(waited.decision, '继续', 'value-only emphasis decision recognized')

// commander reply can drive goal pause through the plugin
value = await commander.execute({ action: 'say', message: 'goal pause 测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：继续\n批准：goal pause')
waited = await waitPromise
assert.ok(goalCalls.some((call) => call.op === 'pause'), 'goal pause executed by plugin')
assert.equal(goalState.current.phase, 'paused')
goalState.current = { ...goalState.current, phase: 'active', activation: 'armed', revision: (goalState.current?.revision ?? 0) + 1 }

// a decision in the body must not override the first line
value = await commander.execute({ action: 'say', message: '正文干扰测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：继续\n正文顺带提到允许结束，但这不是放行。')
waited = await waitPromise
assert.equal(waited.decision, '继续', 'only first non-empty line counts')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'body mention does not grant approval',
)

// goal approvals only count from the reply header, and complete is decision-only
value = await commander.execute({ action: 'say', message: 'complete 批准测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：继续\n批准：goal complete')
waited = await waitPromise
assert.equal(waited.decision, '继续')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'approval complete alone does not grant release',
)

value = await commander.execute({ action: 'say', message: '正文示例' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：继续\n\n正文示例：\n批准：goal edit\n')
waited = await waitPromise
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'edit' } })).includes('需要指挥员批准'),
  'body example approval is ignored',
)

// 需澄清 never grants approval
value = await commander.execute({ action: 'say', message: '澄清测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：需澄清\n缺少验证证据。')
waited = await waitPromise
assert.equal(waited.decision, '需澄清')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'needs clarification does not grant approval',
)

// code-state mismatch rejects release and leaves a warning
value = await commander.execute({ action: 'say', message: '状态不匹配测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：允许结束\n适用状态：CS-deadbeefdeadbeef')
waited = await waitPromise
assert.equal(waited.decision, '允许结束')
// 「允许结束」会被 wait 自动 complete；重置成 active 才能继续验证门禁
resetGoalActive()
assert.ok(waited.text.includes('放行未生效'), 'mismatched code state is rejected')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'mismatched code state does not grant approval',
)

// wait must recompute the current code state before granting release
value = await commander.execute({ action: 'say', message: '等待期间改代码' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
await fsp.writeFile(path.join(cwd, 'probe-code.txt'), 'changed\n')
replyFromCommander(`决定：允许结束\n适用状态：${lastCodeState()}`)
waited = await waitPromise
assert.ok(waited.text.includes('代码已经变化'), 'wait recomputes state and rejects drift')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'drifted state does not grant approval',
)

// doc writes must not invalidate the code state
value = await commander.execute({ action: 'say', message: '记录后状态不变' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander(`决定：允许结束\n适用状态：${lastCodeState()}`)
waited = await waitPromise
assert.equal(waited.decision, '允许结束')
// 「允许结束」会被 wait 自动 complete；重置成 active 才能继续验证门禁
resetGoalActive()
await record.execute({ summary: 'doc 不污染代码状态' }, exec(rootAgent))
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } }),
  undefined,
  'commander_record does not invalidate approval',
)

// async complete gate recomputes code state
const preExec = (listeners.get('tools/pre-execute') ?? [])[0]
assert.ok(typeof preExec === 'function', 'pre-execute gate registered')
const allowNext = async () => ({ kind: 'allow' })
let decision = await preExec({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } }, allowNext)
assert.equal(decision.kind, 'allow', 'valid approval passes async gate')
await fsp.writeFile(path.join(cwd, 'probe-late.txt'), 'late\n')
decision = await preExec({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } }, allowNext)
assert.equal(decision.kind, 'deny', 'external change denied by async gate')
assert.ok(String(decision.reason).includes('放行已失效'))

// fenced approval in the header block is ignored
value = await commander.execute({ action: 'say', message: '围栏批准测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：继续\n```\n批准：goal edit\n```')
waited = await waitPromise
assert.ok(waited.text.includes('批准行不在回复头部块'), 'fenced approval is reported as misplaced')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'edit' } })).includes('需要指挥员批准'),
  'fenced approval is not effective',
)

// body CODE_STATE example does not count
value = await commander.execute({ action: 'say', message: '正文 token 测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：允许结束\n验收结论：x\n\n正文示例 CODE_STATE CS-deadbeefdeadbeef')
waited = await waitPromise
assert.ok(waited.text.includes('缺少「适用状态'), 'body token is ignored')
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'complete' } })).includes('没有有效'),
  'body token does not grant approval',
)

// pending cleared
value = await commander.execute({ action: 'status' }, exec(rootAgent))
assert.ok(value.text.includes('未完成请求：（无）'))

// 7) cancel clears a pending request
value = await commander.execute({ action: 'say', message: '再咨询一次' }, exec(rootAgent))
const secondRequest = value.requestId
value = await commander.execute({ action: 'cancel' }, exec(rootAgent))
assert.equal(value.action, 'cancel')
assert.ok(value.text.includes(secondRequest))
value = await commander.execute({ action: 'status' }, exec(rootAgent))
assert.ok(value.text.includes('未完成请求：（无）'))

// 8) paused goal untouched by say/wait/cancel
goalState.current = { ...goalState.current, phase: 'paused', activation: 'disarmed' }
const pausedBefore = goalCalls.length
await commander.execute({ action: 'say', message: '还在吗' }, exec(rootAgent))
await commander.execute({ action: 'cancel' }, exec(rootAgent))
assert.equal(goalCalls.length, pausedBefore, 'say/cancel do not touch goal')
assert.equal(goalState.current.phase, 'paused')

// 9) non-root rejected
threw = false
try {
  await commander.execute({ action: 'say', message: 'x' }, exec(nonRootAgent))
} catch (error) {
  threw = /主会话/.test(String(error && error.message))
}
assert.equal(threw, true)

// 10) record
const rec = await record.execute({ summary: '等待协议冒烟' }, exec(rootAgent))
assert.equal(rec.path, 'doc/history.md')
const history = await fsp.readFile(path.join(cwd, 'doc', 'history.md'), 'utf8')
assert.ok(history.includes('等待协议冒烟'))

// 14) reply cache survives an interrupted wait
value = await commander.execute({ action: 'say', message: '缓存回复测试' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：继续\n缓存回复内容')
const cachedWait = await commander.execute({ action: 'wait' }, exec(rootAgent))
assert.equal(cachedWait.kind, 'reply')
assert.ok(cachedWait.text.includes('缓存回复内容'), 'cached reply returned')
assert.ok(!Object.values(cachedWait).includes(undefined), 'wait payload has no undefined fields')

// 14b) a late reply carrying the OLD request id must be ignored, not fail the new pending
const oldRequestId = requestId
value = await commander.execute({ action: 'say', message: '新请求' }, exec(rootAgent))
const newRequestId = value.requestId
let staleSettled = false
const staleWait = commander.execute({ action: 'wait' }, exec(rootAgent)).then((result) => {
  staleSettled = true
  return result
})
await sleep(30)
replyFromCommander('决定：继续\n旧请求的迟到回复', Date.now(), oldRequestId)
await sleep(300)
assert.equal(staleSettled, false, 'old request reply leaves wait pending')
replyFromCommander('决定：继续\n新请求的回复', Date.now(), newRequestId)
const matchedWait = await staleWait
assert.equal(matchedWait.kind, 'reply')
assert.ok(matchedWait.text.includes('新请求的回复'))
assert.ok(!matchedWait.text.includes('迟到回复'))

// 14c) a reply with no REQ echo fails the request
value = await commander.execute({ action: 'say', message: '无请求号测试' }, exec(rootAgent))
replyFromCommander('决定：继续\n没有请求号的回复', Date.now(), '')
const noReqWait = await commander.execute({ action: 'wait' }, exec(rootAgent))
assert.equal(noReqWait.kind, 'failed')
assert.ok(noReqWait.text.includes('缺少请求号'))

// 14d) cancel -> new say -> old reply ignored -> new reply accepted
value = await commander.execute({ action: 'say', message: 'R1' }, exec(rootAgent))
const r1 = value.requestId
await commander.execute({ action: 'cancel' }, exec(rootAgent))
value = await commander.execute({ action: 'say', message: 'R2' }, exec(rootAgent))
const r2 = value.requestId
let seqSettled = false
const seqWait = commander.execute({ action: 'wait' }, exec(rootAgent)).then((result) => {
  seqSettled = true
  return result
})
await sleep(30)
replyFromCommander('决定：继续\nR1 的迟到回复', Date.now(), r1)
await sleep(200)
assert.equal(seqSettled, false, 'R1 late reply does not settle R2')
replyFromCommander('决定：继续\nR2 的回复', Date.now(), r2)
const seqResult = await seqWait
assert.ok(seqResult.text.includes('R2 的回复'))
assert.ok(!seqResult.text.includes('R1 的迟到回复'))

// 15) wait does not fast-fail while a teammate is cold-resuming
value = await commander.execute({ action: 'say', message: '冷恢复测试' }, exec(rootAgent))
members.find((row) => row.id === 'teammate-1').status = 'inactive'
let coldSettled = false
const coldWait = commander.execute({ action: 'wait' }, exec(rootAgent)).then((result) => {
  coldSettled = true
  return result
})
await sleep(300)
assert.equal(coldSettled, false, 'wait stays pending during cold resume')
replyFromCommander('决定：继续\n冷恢复后回复')
const coldResult = await coldWait
assert.equal(coldResult.kind, 'reply')
assert.ok(coldResult.text.includes('冷恢复后回复'))

// 16) failed / disposed teammate terminates wait
value = await commander.execute({ action: 'say', message: 'disposed 测试' }, exec(rootAgent))
const disposedWait = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
emit('agent/disposed', { agent: { id: 'teammate-1' } })
const disposedResult = await disposedWait
assert.equal(disposedResult.kind, 'failed')
assert.ok(disposedResult.text.includes('已退出'), 'disposed commander ends the wait')

value = await commander.execute({ action: 'say', message: 'failed 测试' }, exec(rootAgent))
members.find((row) => row.id === 'teammate-1').status = 'failed'
const failedResult = await commander.execute({ action: 'wait' }, exec(rootAgent))
assert.equal(failedResult.kind, 'failed')
members.find((row) => row.id === 'teammate-1').status = 'inactive'

// 17) wait/cancel payloads are lossless JSON
const emptyCancel = await commander.execute({ action: 'cancel' }, exec(rootAgent))
assert.ok(!('requestId' in emptyCancel), 'empty cancel omits requestId')

// 11) command surface
const command = commands.get('commander')
const invoke = (rawInput) =>
  command.handler({ commandId: 'cmd', agent: rootAgent, rawInput, attachments: [], signal: new AbortController().signal })
let result = await invoke('list')
assert.equal(result.kind, 'success')
result = await invoke('say 继续')
assert.equal(result.kind, 'success')
assert.ok(result.text.includes('wait'))
result = await invoke('cancel')
assert.equal(result.kind, 'success')
result = await invoke('status')
assert.equal(result.kind, 'success')
result = await invoke('record 命令记录')
assert.equal(result.kind, 'success')
result = await invoke('help')
assert.ok(result.text.includes('用法：/commander'))
// 拼错的英文子命令给出提示，不当作消息
result = await invoke('statsu')
assert.equal(result.kind, 'error')
assert.ok(result.text.includes('status'))
// 自由文本（中文需求 / 非子命令单词）直接按咨询投递给指挥员
result = await invoke('你帮我检索第五人格wiki中所有监管者的设计并统计下来')
assert.equal(result.kind, 'success')
assert.ok(result.text.includes('按咨询处理'))
await invoke('cancel')
result = await invoke('nonsense')
assert.equal(result.kind, 'success')
await invoke('cancel')
// 中文别名
result = await invoke('帮助')
assert.ok(result.text.includes('用法：/commander'))
result = await invoke('自检')
assert.ok(result.text.includes('指挥员自检'), 'alias 自检 runs doctor')
result = await invoke('checks')
assert.ok(result.text.includes('echo-hi'), 'slash checks lists configured items')
result = await invoke('checks echo-hi')
assert.equal(result.kind, 'success')
assert.ok(result.text.includes('PASS'), 'slash checks runs a passing check')

// 空参数只显示用法：不建指挥员、不动 goal（P2-1）
goalCalls.length = 0
const spawnsBefore = spawnCalls.length
result = await invoke('')
assert.ok(result.text.includes('用法：/commander'), 'empty input shows usage')
assert.equal(goalCalls.length, 0, 'empty input does not touch goal')
assert.equal(spawnCalls.length, spawnsBefore, 'empty input does not spawn commander')

// 12b) goal 批准被 wait 消费后再调 update_goal 应幂等放行（P1-2）
goalState.current = { ...goalState.current, phase: 'active', activation: 'armed', revision: 30 }
value = await commander.execute({ action: 'say', message: '暂停作结测试' }, exec(rootAgent))
waitPromise = commander.execute({ action: 'wait' }, exec(rootAgent))
await sleep(20)
replyFromCommander('决定：需澄清\n批准：goal pause')
waited = await waitPromise
assert.equal(waited.decision, '需澄清')
assert.equal(goalState.current.phase, 'paused', 'plugin applied pause from the approval')
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'pause' } }),
  undefined,
  'goal already paused: update_goal is idempotent, not denied',
)
goalState.current = { ...goalState.current, phase: 'blocked', revision: 31 }
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'blocked' } }),
  undefined,
  'goal already blocked: update_goal is idempotent, not denied',
)
goalState.current = { ...goalState.current, phase: 'active', revision: 32 }
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'update_goal', arguments: { action: 'blocked' } })).includes('需要指挥员批准'),
  'a real phase change still needs approval',
)

// 12c) status 明示持久化模式（P1-1）
const statusText = (await commander.execute({ action: 'status' }, exec(rootAgent))).text
assert.ok(statusText.includes('持久化：文件'), 'status reports file persistence')
assert.ok(statusText.includes('当前代码状态：CS-'), 'status exposes the bound CODE_STATE')
assert.ok(statusText.includes('问用户门禁：'), 'status shows the ask gate')

// 12e) doctor：一条命令出 PASS/WARN/FAIL 结论
const doctor = await commander.execute({ action: 'doctor' }, exec(rootAgent))
assert.ok(doctor.text.includes('指挥员自检'), 'doctor has a title')
assert.ok(/PASS/.test(doctor.text), 'doctor reports PASS rows')
assert.ok(doctor.text.includes('结论：'), 'doctor has a conclusion')
assert.ok(doctor.text.split('\n').length <= 26, 'doctor must stay short')

// 12f) checks：只执行配置内的命令，超时被杀
let checkResult = await commander.execute({ action: 'checks' }, exec(rootAgent))
assert.ok(checkResult.text.includes('echo-hi'), 'checks lists configured items')
checkResult = await commander.execute({ action: 'checks', name: 'echo-hi' }, exec(rootAgent))
assert.equal(checkResult.exitCode, 0, 'echo-hi exits 0')
assert.ok(checkResult.text.includes('PASS'), 'passing check reported as PASS')
checkResult = await commander.execute({ action: 'checks', name: 'fail' }, exec(rootAgent))
assert.notEqual(checkResult.exitCode, 0, 'failing check reports non-zero exit')
checkResult = await commander.execute({ action: 'checks', name: 'slow' }, exec(rootAgent))
assert.ok(/超时|killed/.test(checkResult.text), 'timeout is killed and reported')
checkResult = await commander.execute({ action: 'checks', name: 'not-configured' }, exec(rootAgent))
assert.ok(checkResult.text.includes('没有名为'), 'unconfigured check is rejected')

// 12d) 全接管下的门禁：真实用户消息把 full 降级为 partial，于是又能问用户
// 先来一条真实用户消息（consulted=false），再切 full —— 这才是「我走了」的真实顺序
emit('session/event', rootAgent.session, { type: 'user/message', data: { source: { kind: 'user' } } })
await takeoverCmd.handler({
  commandId: 'takeover',
  agent: rootAgent,
  rawInput: 'takeover full',
  attachments: [],
  signal: new AbortController().signal,
})
assert.ok(
  String(approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} })).includes('全接管'),
  'full takeover blocks asking the user',
)
value = await commander.execute({ action: 'say', message: '门禁重置测试' }, exec(rootAgent))
await invoke('cancel')
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} }),
  undefined,
  'consulted opens the ask gate even under full takeover',
)
emit('session/event', rootAgent.session, { type: 'user/message', data: { source: { kind: 'agent-message' } } })
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} }),
  undefined,
  'synthetic message does not reset the gate',
)
emit('session/event', rootAgent.session, { type: 'user/message', data: { source: { kind: 'user' } } })
assert.equal(
  approvalGuard({ agent: rootAgent, name: 'ask_user_question', arguments: {} }),
  undefined,
  'a real user message downgrades full to partial, so asking is allowed again',
)
const afterReturn = await commander.execute({ action: 'status' }, exec(rootAgent))
assert.ok(afterReturn.text.includes('部分接管'), 'status shows the downgraded takeover state')

// 12) interruption classification: abnormal resumes goal, user abort does not
goalState.current = { ...goalState.current, phase: 'active', activation: 'disarmed', revision: 10 }
const resumesBefore = goalCalls.filter((call) => call.op === 'resume').length
emit('session/event', rootAgent.session, {
  type: 'turn/end',
  time: Date.now(),
  data: { reason: { kind: 'error', error: { message: 'boom' } } },
})
await sleep(30)
assert.equal((await readState()).tables.interruptions['root-1']?.abnormal, true, 'abnormal interruption persisted')
emit('agent/created', { agent: rootAgent })
await sleep(30)
assert.equal(
  goalCalls.filter((call) => call.op === 'resume').length,
  resumesBefore + 1,
  'abnormal interruption resumes goal',
)
assert.equal(goalState.current.activation, 'armed')

goalState.current = { ...goalState.current, phase: 'active', activation: 'disarmed', revision: 11 }
const resumesAfterAbnormal = goalCalls.filter((call) => call.op === 'resume').length
emit('session/event', rootAgent.session, {
  type: 'turn/end',
  time: Date.now(),
  data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
})
await sleep(30)
emit('agent/created', { agent: rootAgent })
await sleep(30)
assert.equal(
  goalCalls.filter((call) => call.op === 'resume').length,
  resumesAfterAbnormal,
  'user interruption does not auto-resume',
)

// 13) pending survives a plugin re-apply through the state file
value = await commander.execute({ action: 'say', message: '持久化测试' }, exec(rootAgent))
const persistedRequest = value.requestId
assert.equal((await readState()).tables.pending['root-1']?.requestId, persistedRequest, 'pending written to state file')

const tools2 = new Map()
const commands2 = new Map()
const fakeCtx2 = {
  ...fakeCtx,
  tools: {
    ...fakeCtx.tools,
    register(definition) {
      tools2.set(definition.name, definition)
      return () => tools2.delete(definition.name)
    },
  },
  commands: {
    register(definition) {
      commands2.set(definition.name, definition)
      return () => commands2.delete(definition.name)
    },
  },
}
plugin.apply(fakeCtx2, { provider: 'spawn', advisorProvider: 'fake-provider', advisorModel: 'fake-model', statePath })
const commander2 = tools2.get('commander')
assert.ok(commander2)
const status2 = await commander2.execute({ action: 'status' }, exec(rootAgent))
assert.ok(status2.text.includes(persistedRequest), 're-applied plugin reads pending from the state file')
assert.match(status2.text, /已完成指挥轮次：[1-9]\d*/, 'round counter persists across re-apply')
const cancelled2 = await commander2.execute({ action: 'cancel' }, exec(rootAgent))
assert.equal(cancelled2.requestId, persistedRequest)
assert.equal((await readState()).tables.pending['root-1'], undefined, 'cancel deletes persisted pending')

// 14) 陈旧 pending（上个进程遗留）不再卡住新 say；窗口未挂载只是 WARN
const staleDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'commander-stale-'))
const stalePath = path.join(staleDir, 'state.json')
await fsp.writeFile(
  stalePath,
  JSON.stringify({
    schema: 3,
    tables: {
      pending: {
        'root-1': {
          requestId: 'req-stale-1',
          leadId: 'root-1',
          commanderId: 'teammate-1',
          target: 'commander',
          sentAt: Date.now() - 3_600_000,
          baselineSeq: 0,
          codeState: 'CS-stale',
        },
      },
      interruptions: {},
      approvals: {},
      rounds: {},
    },
  }),
)
const tools3 = new Map()
const commands3 = new Map()
const fakeCtx3 = {
  ...fakeCtx,
  tools: {
    ...fakeCtx.tools,
    register(definition) {
      tools3.set(definition.name, definition)
      return () => tools3.delete(definition.name)
    },
  },
  commands: {
    register(definition) {
      commands3.set(definition.name, definition)
      return () => commands3.delete(definition.name)
    },
  },
}
plugin.apply(fakeCtx3, { provider: 'spawn', statePath: stalePath, expectTranscriptWindow: true })
const commander3 = tools3.get('commander')
const staleStatus = await commander3.execute({ action: 'status' }, exec(rootAgent))
assert.ok(staleStatus.text.includes('陈旧'), 'status marks the stale pending')
const staleResult = await commander3.execute({ action: 'wait' }, exec(rootAgent))
assert.equal(staleResult.kind, 'stale', 'wait returns stale instead of blocking forever')
assert.ok(staleResult.text.includes('上个进程'), 'stale wait explains the cause')
const staleSay = await commander3.execute({ action: 'say', message: '重启后新请求' }, exec(rootAgent))
assert.ok(String(staleSay.requestId).startsWith('req-'), 'new say is not blocked by the stale pending')
const doctor3 = await commander3.execute({ action: 'doctor' }, exec(rootAgent))
assert.ok(/WARN 历史窗口/.test(doctor3.text), 'unmounted window is WARN, not FAIL')
assert.ok(!/FAIL 历史窗口/.test(doctor3.text), 'config expectation never fails the doctor')

console.log('ALL CHECKS PASSED')
console.log('cwd:', cwd)
