/**
 * 客户端渲染冒烟：用最小 React stub 真跑组件。
 *
 * 为什么必须有：client.js 是浏览器模块，node --check 只能证明语法。
 * 老包踩过两次「所有 node 测试全绿但界面直接崩」：TDZ（依赖数组先求值）、
 * hooks 顺序不稳（早退插在 hooks 之间 → Rendered fewer hooks than expected）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const checks = []
const check = (name, fn) => checks.push({ name, fn })

function makeReact(states) {
  const counter = { hooks: 0 }
  let index = 0
  return {
    counter,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length > 0) merged.children = children
      const element = typeof type === 'function' ? type(merged) : { type, props: merged }
      return element
    },
    useState(initial) {
      counter.hooks += 1
      const value = states === null ? initial : (states[index] ?? initial)
      index += 1
      return [value, () => {}]
    },
    useRef(initial) {
      counter.hooks += 1
      return { current: initial ?? null }
    },
    useEffect(fn) {
      counter.hooks += 1
      fn()
      return undefined
    },
  }
}

function loadComponent({ states = null, snapshot = null } = {}) {
  const React = makeReact(states)
  const ReactDOM = { createPortal: (node) => node }
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const fetchCalls = []
  const fetch = async (url, options) => {
    fetchCalls.push({ url, options })
    return { ok: true, status: 200, json: async () => snapshot ?? { mode: 'off', phase: 'none', hasCommander: false, labels: {} } }
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
  new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', source)(
    window, document, fetch, () => 0, () => 0, () => {},
  )
  return { component: registered, fetchCalls, counter: React.counter }
}

const slot = (over = {}) => ({ sessionId: 'session-x', ...over })

check('模块能加载并注册到 composer 槽位', () => {
  assert.equal(typeof loadComponent().component, 'function')
})

check('首帧（无快照）不抛错且仍渲染图标 —— 不能依赖 fetch 成功', () => {
  const { component } = loadComponent({ states: null })
  assert.ok(component(slot()) !== null)
})

check('子会话（useSession 报 subagent）：首帧就不渲染，且不跑业务 hooks', () => {
  const { component, counter } = loadComponent({ states: null })
  const out = component(slot({
    useSession: (select) => select({ subagent: { id: 'c' } }),
    useSessions: (select) => select({ byId: {} }),
  }))
  assert.equal(out, null)
  assert.equal(counter.hooks, 0)
})

check('子会话（useSessions 报 origin=subagent）：fetch 失败也不出现', () => {
  const { component } = loadComponent({ states: null })
  const out = component(slot({
    sessionId: 'child',
    useSession: (select) => select({ subagent: null }),
    useSessions: (select) => select({ byId: { child: { origin: 'subagent' } } }),
  }))
  assert.equal(out, null)
})

check('主会话（两条判据都为否）：照常渲染，不被误伤', () => {
  const { component } = loadComponent({ states: null })
  const out = component(slot({
    sessionId: 'root',
    useSession: (select) => select({ subagent: null }),
    useSessions: (select) => select({ byId: { root: { origin: 'input' } } }),
  }))
  assert.ok(out !== null)
})

check('两次渲染 hooks 数一致（子会话早退只能在外壳）', () => {
  const first = loadComponent({ states: null })
  first.component(slot())
  const second = loadComponent({ states: [{ mode: 'off', phase: 'ready', hasCommander: true, canControl: false, labels: {} }, false, null, false, false] })
  assert.equal(second.component(slot()), null)
  assert.ok(first.counter.hooks > 0)
  assert.equal(second.counter.hooks, first.counter.hooks)
})

check('phase=none 画问号，tooltip 先讲清代价与边界', () => {
  const { component } = loadComponent({ states: [{ mode: 'off', phase: 'none', hasCommander: false, labels: {} }, false, null, false, false] })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('?'))
  assert.ok(flat.includes('会创建本会话的指挥员并预热'))
  assert.ok(flat.includes('不会让主会话自动开工'))
})

check('预热中转圈（不是皇冠），tooltip 写预热中', () => {
  const preheat = { state: 'running', ms: 3_000, steps: 1, tools: 2, tokens: { total: 1_100, cacheRead: 0 } }
  const { component } = loadComponent({ states: [{ mode: 'observe', phase: 'ready', hasCommander: true, labels: {}, preheat }, false, null, false, false] })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('指挥员预热中'))
  assert.ok(flat.includes('cmdr-core-spin'))
})

check('预热完成 tooltip 带实测代价，缓存命中单列', () => {
  const preheat = { state: 'done', ms: 5_100, steps: 2, tools: 5, tokens: { total: 44_189, cacheRead: 271_360 } }
  const { component } = loadComponent({ states: [{ mode: 'observe', phase: 'ready', hasCommander: true, labels: {}, preheat }, false, null, false, false] })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('指挥员已就绪'))
  assert.ok(flat.includes('5s') && flat.includes('2 步') && flat.includes('5 次工具'))
  assert.ok(flat.includes('44.2k token'))
  assert.ok(flat.includes('缓存命中 271.4k'))
  assert.ok(flat.includes('零打扰'))
  assert.ok(!flat.includes('?'))
})

check('phase=failed 提示重试，点击发 init 而不是打开菜单', async () => {
  const { component, fetchCalls } = loadComponent({ states: [{ mode: 'off', phase: 'failed', hasCommander: false, labels: {} }, false, null, false, false] })
  const tree = component(slot())
  assert.ok(JSON.stringify(tree).includes('重试'))
  const button = (tree.props.children ?? []).find((child) => child?.props && typeof child.props.onClick === 'function')
  await button.props.onClick()
  await new Promise((done) => setImmediate(done))
  assert.ok(fetchCalls.some((call) => String(call.options?.body ?? '').includes('init')))
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
console.log(`\nCLIENT RENDER CHECKS PASSED (${checks.length})`)
