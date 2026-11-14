/**
 * 客户端渲染冒烟（2.9.50）。
 *
 * 为什么要有：client.js 是浏览器模块，node --check 只能证明语法；上一版就把
 * `fast` 放到 useEffect 依赖之后，触发 TDZ（Cannot access 'fast' before initialization），
 * 组件渲染直接抛错 → composer 里的图标整个消失，而所有 node 测试仍然是绿的。
 * 这里用最小 React/window/document stub 真正调用一次组件，把这类错误挡在发布前。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** 最小 React stub：state 固定、effect 立即执行、元素只是普通对象；顺带数 hooks 次数。 */
function makeReact({ state = null, states = null } = {}) {
  const elements = []
  const counter = { hooks: 0 }
  let stateIndex = 0
  return {
    elements,
    counter,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length > 0) merged.children = children
      // 函数组件要真的调用一次，否则 PhaseIcon 之类的分支渲染根本不会发生。
      const element = typeof type === 'function' ? type(merged) : { type, props: merged }
      elements.push(element)
      return element
    },
    useState(initial) {
      counter.hooks += 1
      // states 数组按 useState 调用顺序给值（snapshot/open/anchor/busy/failed）；
      // 只给一个 state 时全部 state 都等于它（老用例的简化写法）。
      const index = stateIndex
      stateIndex += 1
      const value = states === null ? (state === null ? initial : state) : (states[index] ?? initial)
      return [value, () => {}]
    },
    useRef(initial) {
      counter.hooks += 1
      return { current: initial ?? null }
    },
    useEffect(fn) {
      counter.hooks += 1
      // 立即执行一次：真实渲染里 effect 也会在挂载后跑，这里能暴露依赖数组求值错误。
      fn()
      return undefined
    },
  }
}

/** 把 client.js 放进一个假环境跑一遍，返回注册到 slot 的组件。 */
function loadComponent({ state = null, states = null } = {}) {
  const React = makeReact({ state, states })
  const ReactDOM = { createPortal: (node) => node }
  const styleNodes = []
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (node) => styleNodes.push(node) },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const fetchCalls = []
  const fetch = async (url, options) => {
    fetchCalls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ state: 'off', phase: 'none', hasCommander: false, labels: {} }) }
  }
  let registered
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        const module = factory((name) => (name === 'react-dom' ? ReactDOM : React))
        module.apply({
          slots: {
            inject: (_name, callback) => callback(),
            register: (_definition, component) => {
              registered = component
            },
          },
        })
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  }
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', source)
  run(window, document, fetch, () => 0, () => 0)
  return { component: registered, fetchCalls, styleNodes, counter: React.counter }
}

check('client.js 能被模块加载器跑通，并注册到 composer 槽位', () => {
  const { component } = loadComponent()
  assert.equal(typeof component, 'function', '应注册一个组件到 conversation.input.right')
})

check('首帧（固定 state=null）不抛错，且**仍然渲染出图标**（不能依赖 fetch 成功）', () => {
  const { component } = loadComponent({ state: null })
  const result = component({ sessionId: 'session-x' })
  assert.ok(result !== null, '快照还没到时也必须画出图标（否则 fetch 失败＝图标永久消失）')
  const flat = JSON.stringify(result)
  assert.ok(!flat.includes('?'), '首帧不应先画问号（先按 ready 画皇冠，拿到快照再切）')
})

check('sessionId 缺失时用 session 对象兜底（否则 fetch 会 400 → 图标不出现）', () => {
  const { component, fetchCalls } = loadComponent({ state: { state: 'off', phase: 'ready', hasCommander: true, labels: {} } })
  component({ session: { id: 'session-from-prop' } })
  const urls = fetchCalls.map((call) => String(call.url))
  if (urls.length > 0) assert.ok(urls.every((url) => !url.includes('undefined')), `fetch 不能带 undefined：${urls[0]}`)
})

check('有快照（phase=none）时渲染问号，且点击会打初始化请求', async () => {
  const snapshot = { state: 'off', phase: 'none', hasCommander: false, labels: { off: '无指挥' } }
  const { component, fetchCalls } = loadComponent({ state: snapshot })
  const tree = component({ sessionId: 'session-x' })
  assert.ok(tree !== null, '有快照时应渲染出按钮')
  const flat = JSON.stringify(tree)
  assert.ok(flat.includes('?'), 'phase=none 必须画问号')
  assert.ok(!fetchCalls.some((call) => call.options?.body?.includes('init')), '渲染阶段不应主动初始化')
})

check('两次渲染的 hooks 数量必须一致：子会话早退不能插在 hooks 之前', () => {
  const first = loadComponent({ state: null })
  first.component({ sessionId: 'session-child' })
  const firstHooks = first.counter.hooks
  const second = loadComponent({
    state: { state: 'off', phase: 'ready', hasCommander: true, canControl: false, labels: {} },
  })
  const out = second.component({ sessionId: 'session-child' })
  const secondHooks = second.counter.hooks
  assert.equal(out, null, '子会话不显示按钮')
  assert.ok(firstHooks > 0, '第一次渲染必须真的调用 hooks（否则这个用例没有意义）')
  assert.equal(
    secondHooks,
    firstHooks,
    `hooks 数量不一致（${firstHooks} → ${secondHooks}）：React 会报 Rendered fewer hooks than expected，整槽崩`,
  )
})

check('canControl 缺省（服务端没给 / 取不到会话）必须照常显示按钮（fail-open）', () => {
  const { component } = loadComponent({
    state: { state: 'off', phase: 'ready', hasCommander: true, labels: {} },
  })
  assert.ok(component({ sessionId: 'session-x' }) !== null, 'canControl 缺失时不能隐藏按钮')
})

// 2.9.58：子会话的图标必须**首帧**就没有，不能等快照、也不能靠 fetch 失败兜底。
// 判据照抄宿主 TeamModeToggle：useSession(s => s.subagent != null) / useSessions(s => s.byId[id].origin === 'subagent')。
const slotProps = (overrides) => ({ sessionId: 'session-x', ...overrides })

check('子会话（useSession 报 subagent）：快照还没到手也不渲染图标', () => {
  const { component, counter } = loadComponent({ state: null })
  const out = component(
    slotProps({
      useSession: (select) => select({ subagent: { id: 'child-1' } }),
      useSessions: (select) => select({ byId: {} }),
    }),
  )
  assert.equal(out, null, '子会话首帧就必须不渲染')
  assert.equal(counter.hooks, 0, '子会话应当在跑任何业务 hooks 之前就退出')
})

check('子会话（useSessions 报 origin=subagent）：fetch 永远失败也不出现图标', () => {
  const { component } = loadComponent({ state: null })
  const out = component(
    slotProps({
      sessionId: 'child-2',
      useSession: (select) => select({ subagent: null }),
      useSessions: (select) => select({ byId: { 'child-2': { origin: 'subagent' } } }),
    }),
  )
  assert.equal(out, null, '列出表里 origin=subagent 也判定为子会话')
})

check('主会话（两个判据都为否）：照常渲染图标，不被子会话判据误伤', () => {
  const { component } = loadComponent({ state: null })
  const out = component(
    slotProps({
      sessionId: 'root-1',
      useSession: (select) => select({ subagent: null }),
      useSessions: (select) => select({ byId: { 'root-1': { origin: 'input' } } }),
    }),
  )
  assert.ok(out !== null, '主会话必须显示图标')
})

check('phase=failed 时标题提示重试，点击走初始化重试而不是打开挡位菜单', async () => {
  const snapshot = { state: 'off', phase: 'failed', hasCommander: false, labels: {} }
  // 按 useState 顺序：snapshot / open / anchor / busy / failed —— 只有 snapshot 是数据，其余保持初始值。
  const { component, fetchCalls } = loadComponent({ states: [snapshot, false, null, false, false] })
  const tree = component({ sessionId: 'session-x' })
  assert.ok(tree !== null, 'failed 也要画出红问号')
  assert.ok(JSON.stringify(tree).includes('重试'), 'failed 的 title 必须提示重试')
  const button = (tree.props.children ?? []).find((child) => child?.props && typeof child.props.onClick === 'function')
  await button.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fetchCalls.some((call) => String(call.options?.body ?? '').includes('init')), '点击必须发初始化请求')
})

// 2.9.62：就绪信号 + 代价必须写在 tooltip 里（初始化不会在主会话留任何痕迹）
check('预热完成时 tooltip 带上代价（秒/步/工具/token），且图标仍是皇冠', () => {
  const preheat = { state: 'done', ms: 5_100, steps: 2, tools: 5, tokens: { input: 9_000, output: 1_200, total: 10_200 } }
  const { component } = loadComponent({
    states: [{ state: 'observe', phase: 'ready', hasCommander: true, labels: {}, preheat }, false, null, false, false],
  })
  const tree = component({ sessionId: 'session-x' })
  const flat = JSON.stringify(tree)
  assert.ok(flat.includes('指挥员已就绪'), '要明确告诉用户"就绪"')
  assert.ok(flat.includes('5s') && flat.includes('2 步') && flat.includes('5 次工具'), '要给出用时/步数/工具数')
  assert.ok(flat.includes('10.2k token'), '要给出 token 代价')
  assert.ok(flat.includes('零打扰'), '要说明它没有打扰本会话')
  assert.ok(!flat.includes('?'), '就绪后不该再画问号')
})

check('预热进行中画旋转圈（不是皇冠），tooltip 写"预热中"', () => {
  const preheat = { state: 'running', ms: 3_000, steps: 1, tools: 2, tokens: { input: 1_000, output: 100, total: 1_100 } }
  const { component } = loadComponent({
    states: [{ state: 'observe', phase: 'ready', hasCommander: true, labels: {}, preheat }, false, null, false, false],
  })
  const flat = JSON.stringify(component({ sessionId: 'session-x' }))
  assert.ok(flat.includes('指挥员预热中'), '进行中必须有明确文案')
  assert.ok(flat.includes('cmdr-spin'), '进行中要转圈')
})

check('还没初始化时 tooltip 也要先说清代价（会创建指挥员并预热）', () => {
  const { component } = loadComponent({ states: [{ state: 'off', phase: 'none', hasCommander: false, labels: {} }, false, null, false, false] })
  const flat = JSON.stringify(component({ sessionId: 'session-x' }))
  assert.ok(flat.includes('会创建本会话的指挥员并预热'), '点之前就要知道会发生什么')
  assert.ok(flat.includes('不会让主会话自动开工'), '点之前就要知道边界')
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
console.log(`\nCLIENT RENDER CHECKS PASSED (${checks.length})`)