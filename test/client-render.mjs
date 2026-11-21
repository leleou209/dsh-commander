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
  const counter = { hooks: 0, sets: [] }
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
      const slot = index
      index += 1
      // 记下 setter 调用：有些 bug 只能从"有没有被叫"看出来
      // （例如菜单滚动时被误关 = setOpen(false) 被调了）。
      return [value, (next) => { counter.sets.push({ slot, value: next }) }]
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

function loadComponent({ states = null, snapshot = null, models = null, menuNode = null, postError = null } = {}) {
  const React = makeReact(states)
  const ReactDOM = { createPortal: (node) => node }
  // 记下监听器，测试才能模拟"菜单内滚动 / 菜单外滚动"。
  const listeners = { doc: new Map(), win: new Map() }
  const on = (bag) => (type, fn) => {
    const list = bag.get(type) ?? []
    list.push(fn)
    bag.set(type, list)
  }
  const off = (bag) => (type, fn) => {
    const list = bag.get(type) ?? []
    bag.set(type, list.filter((entry) => entry !== fn))
  }
  const document = {
    querySelector: (selector) => (selector === '[data-commander-menu]' ? menuNode : null),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: on(listeners.doc),
    removeEventListener: off(listeners.doc),
  }
  const fetchCalls = []
  const fetch = async (url, options) => {
    fetchCalls.push({ url, options })
    // 模拟 POST 失败（换模型失败），用来验证"失败要留在原地并说清原因"。
    if (postError !== null && options?.method === 'POST') {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'recreate-failed', message: postError }),
      }
    }
    // 模型清单走单独端点：不这么分流的话，模型面板会拿到状态快照当清单用。
    if (String(url).includes('/models')) {
      return { ok: true, status: 200, json: async () => models ?? { current: null, hasCommander: false, groups: [] } }
    }
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
    addEventListener: on(listeners.win),
    removeEventListener: off(listeners.win),
    innerWidth: 1280,
    innerHeight: 800,
  }
  new Function('window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', source)(
    window, document, fetch, () => 0, () => 0, () => {},
  )
  /** 触发某个监听器（模拟真实事件）。 */
  const fire = (bag, type, event) => {
    for (const fn of listeners[bag].get(type) ?? []) fn(event)
  }
  return {
    component: registered,
    fetchCalls,
    counter: React.counter,
    fireScroll: (event) => fire('win', 'scroll', event),
    fireMouseDown: (event) => fire('doc', 'mousedown', event),
  }
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

check('快照还没回来时不能被当成"已就绪"（默认值曾经是 ready，新会话凭空有指挥员）', () => {
  // 不给 states，模拟路由还没响应
  const { component } = loadComponent({ states: null })
  const flat = JSON.stringify(component(slot()))
  // 不能出现"接管 / 已就绪"这类措辞
  assert.ok(!flat.includes('指挥员接管'), `没读到状态就宣称有指挥员：${flat.slice(0, 240)}`)
  assert.ok(flat.includes('正在读取指挥员状态'), '要如实说还在读')
})

check('别的会话的快照不能被复用（切会话时皇冠不能挂到新会话上）', () => {
  // 注入一份"已就绪"的快照，但标记属于另一个会话；slot() 的 sessionId 是 session-x
  const { component } = loadComponent({
    states: [
      { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-other', labels: {} },
      false, null, false, false,
    ],
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(!flat.includes('指挥员接管'), `别的会话的快照被复用了：${flat.slice(0, 240)}`)
  assert.ok(flat.includes('正在读取指挥员状态'), '应当退回"还没读到"')
})

check('同一会话的快照照常使用（别把保护做成什么都不显示）', () => {
  const { component } = loadComponent({
    states: [
      { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-x', labels: {} },
      false, null, false, false,
    ],
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('指挥员接管'), `同会话的快照应当正常渲染：${flat.slice(0, 240)}`)
})

check('空会话（canInit=false）不能假装能初始化：点击不做事、tooltip 说清原因', () => {
  const { component } = loadComponent({
    states: [
      { mode: 'off', phase: 'none', hasCommander: false, canControl: true, canInit: false, __sid: 'session-x', labels: {} },
      false, null, false, false,
    ],
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('本会话还没开始'), `要说明为什么不能初始化：${flat.slice(0, 260)}`)
  assert.ok(flat.includes('先发一条消息'), '要给出可执行动作')
})

check('已建立时菜单里没有换模型入口：模型是只读信息', () => {
  const ready = { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-x', labels: {}, route: { provider: 'qwen', model: 'qwen4-max-preview' } }
  const { component } = loadComponent({
    states: [ready, true, { left: 8, top: 8, openUp: false }, false, false],
    snapshot: ready,
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(!flat.includes('指挥员模型'), `不该再有换模型入口：${flat.slice(0, 300)}`)
  assert.ok(flat.includes('模型（建立时固定）'), '要保留只读的模型信息')
  assert.ok(flat.includes('qwen/qwen4-max-preview'), '要显示它实际用的模型')
})

check('未建立时点开是「选模型并建立」，并提醒选了就固定', () => {
  const none = { mode: 'off', phase: 'none', hasCommander: false, canControl: true, __sid: 'session-x', labels: {} }
  const { component } = loadComponent({
    states: [none, true, { left: 8, top: 8, openUp: false }, false, false],
    snapshot: none,
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('选模型并建立'), `未建立时要直接进选模型面板：${flat.slice(0, 300)}`)
  assert.ok(flat.includes('选定后建立指挥员'), '要提醒选了就固定')
})

check('模型面板按 provider 分组列出全部模型，并标出当前那个', () => {
  const ready = { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-x', labels: {} }
  const { component } = loadComponent({
    states: [
      ready, true, { left: 8, top: 8, openUp: false }, false, false,
      'models', // panel
      {
        current: { provider: 'qwen', model: 'qwen4-max-preview' },
        hasCommander: true,
        groups: [
          { provider: 'qwen', models: ['qwen4-max-preview', 'qwen3.8-flash'] },
          { provider: 'opencode-go', models: ['deepseek-v4.1-flash'] },
        ],
      },
      '',
    ],
    snapshot: ready,
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('qwen4-max-preview'), '要列出当前模型')
  assert.ok(flat.includes('qwen3.8-flash'), '要列出同 provider 的其他模型')
  assert.ok(flat.includes('deepseek-v4.1-flash'), '要跨 provider 列出')
  assert.ok(flat.includes('opencode-go'), '要显示 provider 分组')
  assert.ok(flat.includes('当前'), '当前那个要标出来')
  // 说清代价：换模型是原地切换，上下文保留——这里以前写的是"会重建"，改了实现没改文案。
  assert.ok(flat.includes('原地切换'), '要说清代价：选了是原地换，不是重建')
})

check('模型清单为空时如实说明，不画一个空面板', () => {
  const ready = { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-x', labels: {} }
  const { component } = loadComponent({
    states: [
      ready, true, { left: 8, top: 8, openUp: false }, false, false,
      'models',
      { current: null, hasCommander: true, groups: [] },
      '',
    ],
    snapshot: ready,
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('没有可用的模型'), `空清单要说清楚：${flat.slice(0, 300)}`)
})

check('模型列表内部滚动不能关掉菜单（否则一滚就没了，等于选不了）', () => {
  const ready = { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-x', labels: {} }
  // 菜单根节点，模型列表是它的后代
  const listNode = { nodeType: 1 }
  const menuNode = { nodeType: 1, contains: (node) => node === listNode || node === menuNode }
  const { component, fireScroll, counter } = loadComponent({
    states: [
      ready, true, { left: 8, top: 8, openUp: false }, false, false,
      'models',
      { current: null, hasCommander: true, groups: [{ provider: 'qwen', models: ['a', 'b', 'c'] }] },
      '',
    ],
    snapshot: ready,
    menuNode,
  })
  component(slot())
  counter.sets.length = 0

  // 菜单内部滚动：绝不能关闭
  fireScroll({ target: listNode })
  assert.equal(counter.sets.filter((s) => s.slot === 1).length, 0, '菜单内滚动不该 setOpen(false)')

  // 菜单自身滚动（maxHeight 兜底时会发生）：同样不能关
  fireScroll({ target: menuNode })
  assert.equal(counter.sets.filter((s) => s.slot === 1).length, 0, '菜单自身滚动也不该关')

  // 外部滚动：要关（锚点失效）
  fireScroll({ target: { nodeType: 1 } })
  const closed = counter.sets.filter((s) => s.slot === 1)
  assert.equal(closed.length, 1, '外部滚动应当关闭菜单')
  assert.equal(closed[0].value, false)
})

check('点击菜单内部不关闭，点击外部才关闭', () => {
  const ready = { mode: 'observe', phase: 'ready', hasCommander: true, canControl: true, __sid: 'session-x', labels: {} }
  const inside = { nodeType: 1 }
  const menuNode = { nodeType: 1, contains: (node) => node === inside }
  const { component, fireMouseDown, counter } = loadComponent({
    states: [ready, true, { left: 8, top: 8, openUp: false }, false, false],
    snapshot: ready,
    menuNode,
  })
  component(slot())
  counter.sets.length = 0
  fireMouseDown({ target: inside })
  assert.equal(counter.sets.filter((s) => s.slot === 1).length, 0, '点菜单内部不该关闭')
  fireMouseDown({ target: { nodeType: 1 } })
  assert.equal(counter.sets.filter((s) => s.slot === 1).length, 1, '点外部应当关闭')
})

check('未建立时面板停在选模型界面（不会悄悄收起）', () => {
  const none = { mode: 'off', phase: 'none', hasCommander: false, canControl: true, __sid: 'session-x', labels: {} }
  const { component } = loadComponent({
    states: [none, true, { left: 8, top: 8, openUp: false }, false, false],
    snapshot: none,
  })
  const flat = JSON.stringify(component(slot()))
  assert.ok(flat.includes('选模型并建立'), `要停在选模型界面：${flat.slice(0, 300)}`)
  assert.ok(flat.includes('读取中') || flat.includes('没有可选的模型'), '清单没好时要如实说明，而不是空白')
})

check('phase=failed 提示重试；点击进「选模型」而不是直接开建', async () => {
  const { component, fetchCalls } = loadComponent({ states: [{ mode: 'off', phase: 'failed', hasCommander: false, labels: {} }, false, null, false, false] })
  const tree = component(slot())
  assert.ok(JSON.stringify(tree).includes('重试'))
  const button = (tree.props.children ?? []).find((child) => child?.props && typeof child.props.onClick === 'function')
  await button.props.onClick()
  await new Promise((done) => setImmediate(done))
  // 模型必须先选：点按钮不该直接建立指挥员。
  assert.equal(
    fetchCalls.some((call) => String(call.options?.body ?? '').includes('"init"')),
    false,
    '还没选模型就不许发 init',
  )
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
