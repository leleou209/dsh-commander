/**
 * 指挥员接管状态图标（客户端半）。
 *
 * 位置：composer 工具行 `conversation.input.right`（模型选择器与发送键之间）。
 * 交互：
 *   - 平时只显示皇冠 logo（按状态着色，off 时压暗但仍可点，避免"关掉就找不回来"）；
 *   - 鼠标停靠显示当前状态（原生 tooltip + 悬停高亮）；
 *   - 点击弹出菜单，直接选 4 个状态之一；
 *   - 选的是"运行职责"的状态而指挥员还没起来 → 这次点击顺手把它启动起来，
 *     指挥员就以你选的状态进场；
 *   - 切换后**只改颜色**，不回显文字：文字按钮落在 composer 里很容易被误点。
 *
 * 数据：Host 半的 `/commander/takeover` 路由（GET 读、POST 写）。
 * 客户端是普通浏览器模块，可以直接 fetch；菜单用 position:fixed 锚定按钮，
 * 因为 composer 会裁切普通浮层。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-commander',
  factory(require) {
    const React = require('react')
    // 菜单必须挂到 document.body：composer 里有 transform 祖先时，fixed 会相对它定位，
    // 之前就是因此飘到了视口右下角。
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const ENDPOINT = '/commander/takeover'
    const POLL_MS = 8000
    /** 菜单尺寸用于视口夹取（宽度固定，高度按 4 行 + 可能的一行提示估算）。 */
    const MENU_WIDTH = 208
    const MENU_HEIGHT = 186

    const PALETTE = {
      off: { ring: 'rgba(127,127,127,0.45)', fill: 'rgba(127,127,127,0.25)', dim: 0.55 },
      observe: { ring: 'rgba(160,160,160,0.85)', fill: 'rgba(160,160,160,0.35)', dim: 1 },
      partial: { ring: '#3b82f6', fill: '#3b82f6', dim: 1 },
      full: { ring: '#f59e0b', fill: '#f59e0b', dim: 1 },
    }

    const MENU_ORDER = ['off', 'observe', 'partial', 'full']

    /**
     * 自证探针（2.9.56）：只报事件名与 sessionId 是否拿到，**不报任何会话内容**。
     * 宿主侧落 ~/.dsh/commander/client-probe.jsonl；失败完全静默（探针不能反过来影响图标）。
     * ready 每个会话只报一次：8 秒轮询会把 200 行环刷满，冲掉 load / fetch-error 证据。
     */
    const reportedReady = new Set()
    function reportProbe(event, extra) {
      try {
        if (event === 'ready') {
          const key = String(extra?.sessionId ?? '')
          if (reportedReady.has(key)) return
          reportedReady.add(key)
        }
        fetch(`${ENDPOINT}/client-probe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, ...extra }),
        }).catch(() => undefined)
      } catch {
        // 无 fetch 环境（测试 stub 之外）时忽略
      }
    }
    reportProbe('load')

    async function readState(sessionId) {
      const response = await fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }


    /** 问号入口：只建立并绑定指挥员（不带草稿；模式与任务由用户随后决定）。 */
    async function initCommander(sessionId) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, init: true }), // 初始化不带草稿：模式与任务由用户随后决定
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }
    async function writeState(sessionId, state) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, state }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** 皇冠 logo。 */
    function Crown({ state, size }) {
      const palette = PALETTE[state] ?? PALETTE.observe
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 17h16l-1.2-8-3.9 3.2L12 6l-2.9 6.2L5.2 9z',
          fill: palette.fill,
          stroke: palette.ring,
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('rect', { x: 4.4, y: 17.6, width: 15.2, height: 1.8, rx: 0.9, fill: palette.ring }),
      )
    }

    /** 菜单底部的提示：指挥员不在时，选「运行职责」会顺手启动它。 */
    function NoCommanderHint() {
      const style = {
        margin: '4px 6px 2px',
        paddingTop: 6,
        borderTop: '1px solid rgba(127,127,127,0.25)',
        opacity: 0.7,
        lineHeight: 1.5,
      }
      return h('div', { style }, '选「不接管」及以上会启动指挥员')
    }
    /** 三态图标：none=问号、provisioning（或预热中）=蓝色旋转圈、ready=皇冠。 */
    function PhaseIcon({ phase, state, preheat }) {
      if (phase === 'none' || phase === 'failed') {
        const color = phase === 'failed' ? '#ef4444' : '#3b82f6'
        return h('span', { style: { fontSize: 14, fontWeight: 700, color, lineHeight: 1 } }, '?')
      }
      if (phase === 'provisioning' || preheat?.state === 'running') {
        const style = {
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid rgba(59,130,246,0.25)',
          borderTopColor: '#3b82f6',
          boxSizing: 'border-box',
          animation: 'cmdr-spin 900ms linear infinite',
        }
        return h('span', { style })
      }
      return h(Crown, { state, size: 16 })
    }

    /** 预热代价的人类可读串（秒 / 步 / 工具 / 新 token，缓存命中单独标）。 */
    function preheatCost(preheat) {
      const seconds = Math.max(1, Math.round(Number(preheat?.ms ?? 0) / 1000))
      const parts = [`${seconds}s`, `${Number(preheat?.steps ?? 0)} 步`, `${Number(preheat?.tools ?? 0)} 次工具`]
      const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
      const total = Number(preheat?.tokens?.total ?? 0)
      if (total > 0) parts.push(`${compact(total)} token`)
      const cacheRead = Number(preheat?.tokens?.cacheRead ?? 0)
      if (cacheRead > 0) parts.push(`缓存命中 ${compact(cacheRead)}`)
      return parts.join(' / ')
    }
    /**
     * 标题随三态变化（问号/初始化中/挡位说明），并**明码标出代价**（2.9.62）。
     *
     * 为什么要在 tooltip 里写代价：初始化会真花一次模型调用（读 doc 四件套），
     * 而 2.9.58 之后它干完**不会**在主会话里留任何痕迹 —— 不写清楚，用户就会以为
     * "点了但什么都没发生"。
     */
    function badgeTitle({ phase, label, state, preheat }) {
      if (phase === 'none') {
        return '启用指挥员模式：会创建本会话的指挥员并预热（读 doc 四件套，一次模型调用）；完成后它只待命，不会让主会话自动开工'
      }
      if (phase === 'provisioning') return '指挥员初始化中…'
      if (phase === 'failed') return '指挥员初始化失败，点击重试'
      if (preheat?.state === 'running') return `指挥员预热中…（已 ${preheatCost(preheat)}）— 只读文档，不会打扰本会话`
      if (preheat?.state === 'failed') return `指挥员预热失败（${preheatCost(preheat)}）— 点击选择挡位或重试`
      if (preheat?.state === 'done') return `指挥员已就绪（预热 ${preheatCost(preheat)}，本会话零打扰）— 点击选择接管挡位`
      return `指挥员接管：${label}（${state}）— 点击选择`
    }
    /** 问号入口的初始化动作（失败只红一下边框，不弹文字）。 */
    function startInitFlow({ sessionId, busy, setBusy, setFailed, setSnapshot }) {
      if (busy) return
      setBusy(true)
      initCommander(sessionId)
        .then(() => readState(sessionId))
        .then((next) => setSnapshot(next))
        .catch((error) => {
          console.warn('[dsh-commander] 初始化指挥员失败：', error && error.message ? error.message : error)
          setFailed(true)
          setTimeout(() => setFailed(false), 2000)
        })
        .finally(() => setBusy(false))
    }
    /**
     * 子会话一律不挂图标（2.9.58）。
     *
     * 必须在**首帧**就判出来：宿主给 session 作用域槽位的标准 props 里有 `useSession`
     * 与 `useSessions`，同步就能读出「这是不是一个子会话」。判据照抄宿主自己的
     * TeamModeToggle（dsh-client-ui-agent-team）：`useSession(s => s.subagent != null)`
     * 或 `useSessions(s => s.byId[sessionId].origin === 'subagent')`。
     * 之前靠 `/commander/takeover` 的 canControl 兜底，有两个窟窿：首帧还没拿到快照时
     * 先画皇冠（闪一下），以及 fetch 失败时永远拿不到 canControl（一直留着）。
     */
    function sessionIsChild(props) {
      const readOne = props.useSession
      const readAll = props.useSessions
      const addressed = typeof readOne === 'function' ? readOne((snapshot) => snapshot?.subagent != null) : false
      const listed =
        typeof readAll === 'function' ? readAll((state) => state?.byId?.[props.sessionId]?.origin === 'subagent') : false
      return addressed === true || listed === true
    }

    function TakeoverSlot(props) {
      if (sessionIsChild(props)) return null
      return h(TakeoverBadge, props)
    }

    function TakeoverBadge(props) {
      // 槽位有的版本给 sessionId，有的给 session 对象——都兜住，否则 fetch 会 400 且图标不出现。
      const sessionId = props.sessionId ?? props.session?.id ?? props.session?.header?.id
      const [snapshot, setSnapshot] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const buttonRef = React.useRef(null)
      // phase/fast 必须在 useEffect 之前：依赖数组会立即求值，放后面就是 TDZ，组件直接渲染失败。
      // 关键：**不要**用『还没拿到快照』来决定是否渲染——那样一旦 fetch 失败，图标就永远不出现。
      // 首帧按 ready 画皇冠（与 2.9.47 之前一致），拿到快照后再切问号/旋转圈。
      const phase = snapshot?.phase ?? 'ready'
      const fast = phase === 'provisioning'

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          readState(sessionId)
            .then((next) => {
              if (alive) setSnapshot(next)
              if (alive) reportProbe('ready', { sessionId, sessionSource: props.sessionId ? 'p' : 's', hasSession: !!sessionId })
            })
            .catch((error) => {
              // 读不到状态时保持静默（不刷屏），但留一条可查的日志：图标不出现时先看这里。
              console.warn('[dsh-commander] 读取接管状态失败：', error && error.message ? error.message : error)
              reportProbe('fetch-error', { error: (error && error.message) || 'unknown' })
            })
        }
        tick()
        const timer = setInterval(tick, fast ? 1000 : POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId, fast])

      // 点菜单外面就收起
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const menu = document.querySelector('[data-commander-takeover-menu]')
          if (menu && menu.contains(event.target)) return
          if (buttonRef.current && buttonRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const state = snapshot?.state ?? 'off'
      const labels = snapshot?.labels ?? {}
      const hasCommander = snapshot?.hasCommander === true
      const startInit = () => startInitFlow({ sessionId, busy, setBusy, setFailed, setSnapshot })

      const label = labels[state] ?? state
      const palette = PALETTE[state] ?? PALETTE.observe
      const title = badgeTitle({ phase, label, state, preheat: snapshot?.preheat })

      const choose = (next) => {
        if (busy) return
        setBusy(true)
        setOpen(false)
        writeState(sessionId, next)
          .then((result) => {
            setSnapshot(result)
          })
          .catch((error) => {
            // 失败不弹文字（会挡住 composer），用边框红一下；启动指挥员失败也走这里。
            console.warn('[dsh-commander] 切换挡位失败：', error && error.message ? error.message : error)
            setFailed(true)
            setTimeout(() => setFailed(false), 2000)
          })
          .finally(() => setBusy(false))
      }
      const toggleMenu = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = buttonRef.current?.getBoundingClientRect?.()
        if (rect) {
          // 菜单固定宽度，位置夹在视口内；上方放不下就朝下展开。
          const viewportWidth = window.innerWidth || 1280
          const viewportHeight = window.innerHeight || 800
          const left = Math.min(Math.max(8, rect.left - 8), Math.max(8, viewportWidth - MENU_WIDTH - 8))
          const openUp = rect.top > MENU_HEIGHT + 16
          const top = openUp ? rect.top - 8 : rect.bottom + 8
          setAnchor({ left, top, openUp })
        }
        setOpen(true)
      }

      // 滚动/缩放会让 fixed 坐标失效：直接收起，避免菜单飘到别处。
      React.useEffect(() => {
        if (!open) return undefined
        const close = () => setOpen(false)
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        return () => {
          window.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
        }
      }, [open])

      // 子会话不显示按钮：必须放在所有 hooks 之后，否则第二次渲染少调用 hooks 会整槽崩。
      if (snapshot !== null && snapshot.canControl === false) return null

      const menu =
        open && anchor
          ? h(
              'div',
              {
                'data-commander-takeover-menu': '1',
                style: {
                  position: 'fixed',
                  left: anchor.left,
                  top: anchor.top,
                  transform: anchor.openUp ? 'translateY(-100%)' : 'none',
                  zIndex: 2147483000,
                  width: MENU_WIDTH,
                  boxSizing: 'border-box',
                  padding: 4,
                  borderRadius: 10,
                  border: '1px solid rgba(127,127,127,0.35)',
                  background: 'var(--dsh-surface-raised, #1f1f22)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                  fontSize: 12,
                },
              },
              MENU_ORDER.map((option) =>
                h(
                  'button',
                  {
                    key: option,
                    type: 'button',
                    onClick: () => choose(option),
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 8px',
                      border: 'none',
                      borderRadius: 7,
                      background: option === state ? 'rgba(127,127,127,0.16)' : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 12,
                    },
                  },
                  h(Crown, { state: option, size: 14 }),
                  h('span', { style: { flex: 1 } }, labels[option] ?? option),
                  option === state ? h('span', { style: { opacity: 0.6 } }, '当前') : null,
                ),
              ),
              hasCommander ? null : h(NoCommanderHint),
            )
          : null

      // 挂到 body：视口坐标才是真视口坐标，也不会被 composer 裁切。
      const portalMenu = menu && typeof ReactDOM?.createPortal === 'function' ? ReactDOM.createPortal(menu, document.body) : menu

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            title,
            'aria-label': title,
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            disabled: busy,
            onClick: phase === 'none' || phase === 'failed' ? startInit : toggleMenu,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              borderRadius: 8,
              border: `1px solid ${failed ? '#ef4444' : open ? palette.ring : 'transparent'}`,
              background: open ? 'rgba(127,127,127,0.14)' : 'transparent',
              color: 'inherit',
              cursor: busy ? 'progress' : 'pointer',
              opacity: busy ? 0.6 : palette.dim,
              transition: 'opacity 120ms ease, background 120ms ease',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.opacity = '1'
              event.currentTarget.style.background = 'rgba(127,127,127,0.12)'
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.opacity = String(palette.dim)
              if (!open) event.currentTarget.style.background = 'transparent'
            },
          },
          h(PhaseIcon, { phase, state, preheat: snapshot?.preheat }),

        ),
        portalMenu,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 旋转圈需要一个 keyframes；注入失败只是没有动画，不影响功能。
        try {
          if (document.querySelector('style[data-commander-spin]') === null) {
            const style = document.createElement('style')
            style.dataset.commanderSpin = '1'
            style.textContent = '@keyframes cmdr-spin { to { transform: rotate(360deg) } }'
            document.head.appendChild(style)
          }
        } catch {
          // 无 document 环境（测试/SSR）时跳过
        }
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'commander-takeover', order: 10 },
            TakeoverSlot,
          ),
        )
      },
    }
  },
})
