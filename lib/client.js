/**
 * 接管挡位图标（客户端半）。位置：composer 工具行 conversation.input.right。
 *
 * 三条硬约束（都是踩过的坑）：
 *   1. **子会话首帧就不渲染** —— 用宿主 slot 的 useSession/useSessions 同步判定，
 *      不能靠 fetch 回来的 canControl 兜底（那样会先闪一下，fetch 失败还会一直留着）；
 *   2. **hooks 顺序必须稳定** —— 早退只能发生在组件外壳，不能插在 hooks 之间；
 *   3. **不能依赖 fetch 成功才渲染** —— 读不到状态时保持上一份快照，图标不消失。
 *
 * 预热可见性：预热中继续转圈；完成后 tooltip 明码标出代价（秒/步/工具/token）。
 * 因为初始化不会在主会话留任何痕迹，不写清楚用户会以为"点了但什么都没发生"。
 */
window.__ModuleLoader__.load({
  id: '@leleou209/dsh-commander',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const ENDPOINT = '/commander/takeover'
    const POLL_MS = 8000
    const FAST_MS = 1000
    const MENU_WIDTH = 208
    const MENU_HEIGHT = 186
    // 模型面板要装下 provider/模型名，比挡位面板宽一些。
    const MODELS_WIDTH = 300
    const MODELS_MAX_HEIGHT = 340
    const ORDER = ['off', 'observe', 'partial', 'full']

    /** 菜单行的公共底子；各面板只覆盖 gap / padding / 选中底色。 */
    const ROW = {
      display: 'flex', alignItems: 'center', width: '100%', border: 'none',
      textAlign: 'left', fontSize: 12, cursor: 'pointer', color: 'inherit',
    }
    const rowBackground = (selected) => (selected ? 'rgba(127,127,127,0.16)' : 'transparent')

    const PALETTE = {
      off: { ring: 'rgba(127,127,127,0.45)', fill: 'rgba(127,127,127,0.25)', dim: 0.55 },
      observe: { ring: 'rgba(160,160,160,0.85)', fill: 'rgba(160,160,160,0.35)', dim: 1 },
      partial: { ring: '#3b82f6', fill: '#3b82f6', dim: 1 },
      full: { ring: '#f59e0b', fill: '#f59e0b', dim: 1 },
    }

    /**
     * 所有请求走同一个出口：失败时把服务端给的原因带出来。
     * 只抛 "HTTP 500" 的话，界面上只能显示一句废话。
     */
    async function request(url, init) {
      const response = await fetch(url, init)
      if (!response.ok) {
        let detail = ''
        try {
          const parsed = await response.json()
          detail = String(parsed?.message ?? parsed?.error ?? '')
        } catch {
          // 非 JSON 响应，退回状态码
        }
        throw new Error(detail.length > 0 ? detail : `HTTP ${response.status}`)
      }
      return response.json()
    }

    const readState = (sessionId) =>
      request(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })

    /** 可选模型清单。单独取：几十条路由不该进 8 秒一次的轮询。 */
    const readModels = (sessionId) =>
      request(`${ENDPOINT}/models?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })

    const post = (sessionId, body) => request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...body }),
    })

    function Crown({ mode, size }) {
      const palette = PALETTE[mode] ?? PALETTE.observe
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 17h16l-1.2-8-3.9 3.2L12 6l-2.9 6.2L5.2 9z',
          fill: palette.fill, stroke: palette.ring, strokeWidth: 1.4, strokeLinejoin: 'round',
        }),
        h('rect', { x: 4.4, y: 17.6, width: 15.2, height: 1.8, rx: 0.9, fill: palette.ring }),
      )
    }

    function PhaseIcon({ phase, mode, preheat }) {
      if (phase === 'loading') {
        // 还没读到状态：中性空心圆，不动（转动代表 provisioning，别混）。
        return h('span', {
          style: {
            width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box',
            border: '2px solid rgba(148,163,184,0.4)',
          },
        })
      }
      if (phase === 'none' || phase === 'failed') {
        const color = phase === 'failed' ? '#ef4444' : '#3b82f6'
        return h('span', { style: { fontSize: 14, fontWeight: 700, color, lineHeight: 1 } }, '?')
      }
      if (phase === 'provisioning' || preheat?.state === 'running') {
        return h('span', {
          style: {
            width: 14, height: 14, borderRadius: '50%', boxSizing: 'border-box',
            border: '2px solid rgba(59,130,246,0.25)', borderTopColor: '#3b82f6',
            animation: 'cmdr-core-spin 900ms linear infinite',
          },
        })
      }
      return h(Crown, { mode, size: 16 })
    }

    /** 预热代价的人类可读串；缓存命中单列，不算进"花掉"。 */
    function preheatCost(preheat) {
      const seconds = Math.max(1, Math.round(Number(preheat?.ms ?? 0) / 1000))
      const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
      const parts = [`${seconds}s`, `${Number(preheat?.steps ?? 0)} 步`, `${Number(preheat?.tools ?? 0)} 次工具`]
      const total = Number(preheat?.tokens?.total ?? 0)
      if (total > 0) parts.push(`${compact(total)} token`)
      const cacheRead = Number(preheat?.tokens?.cacheRead ?? 0)
      if (cacheRead > 0) parts.push(`缓存命中 ${compact(cacheRead)}`)
      return parts.join(' / ')
    }

    function badgeTitle({ phase, label, mode, preheat, canInit }) {
      if (phase === 'loading') return '正在读取指挥员状态…（若一直停在这里，通常是插件没加载好）'
      if (phase === 'none') {
        if (canInit === false) return '本会话还没开始：先发一条消息，之后就能初始化指挥员（建立子会话需要一个已激活的会话）'
        return '启用指挥员：会创建本会话的指挥员并预热（读 doc 四件套，一次模型调用）；完成后它只待命，不会让主会话自动开工'
      }
      if (phase === 'provisioning') return '指挥员建立中…'
      if (phase === 'failed') return '指挥员建立失败，点击重试'
      if (preheat?.state === 'running') return `指挥员预热中…（已 ${preheatCost(preheat)}）— 只读文档，不会打扰本会话`
      if (preheat?.state === 'failed') return `指挥员预热失败（${preheatCost(preheat)}）— 点击选择挡位或重试`
      if (preheat?.state === 'done') return `指挥员已就绪（预热 ${preheatCost(preheat)}，本会话零打扰）— 点击选择接管挡位`
      // 读不到代价时也要把"为什么慢"说清楚：子会话是**冷前缀**，
      // 首次请求要预填充整份工具表（实测 269,237 token），冷启动约 60–90 秒，之后走缓存。
      if (phase === 'ready') return `指挥员接管：${label}（${mode}）— 点击选择。首次调用要预填充整份工具表，通常 60–90 秒；之后走缓存`
      return `指挥员接管：${label}（${mode}）— 点击选择`
    }

    /** 子会话判定：照抄宿主 TeamModeToggle 的两条判据，首帧同步可得。 */
    function sessionIsChild(props) {
      const addressed = typeof props.useSession === 'function'
        ? props.useSession((snapshot) => snapshot?.subagent != null) : false
      const listed = typeof props.useSessions === 'function'
        ? props.useSessions((state) => state?.byId?.[props.sessionId]?.origin === 'subagent') : false
      return addressed === true || listed === true
    }

    function TakeoverSlot(props) {
      if (sessionIsChild(props)) return null
      return h(Badge, props)
    }

    function Badge(props) {
      const sessionId = props.sessionId ?? props.session?.id ?? props.session?.header?.id
      const [snapshot, setSnapshot] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const buttonRef = React.useRef(null)
      // 菜单内的视图：挡位 / 模型。模型只在"还没有指挥员"时可选，
      // 建立之后就固定了（宿主没有改子会话模型的合法表示）。
      const [panel, setPanel] = React.useState('modes')
      const [models, setModels] = React.useState(null)
      const [modelError, setModelError] = React.useState('')
      // 快照要**绑定会话身份**。
      //
      // 之前只存 next，切换会话时不重置：上一个会话（可能是已就绪的那个）的快照会一直
      // 挂在别的会话上，看起来就是"全新会话凭空有指挥员"，而新请求万一失败则永远不会纠正。
      // 现在只认属于当前 sessionId 的那一份，其余一律当"还没读到"。
      // `__sid` 缺失时放行，只为兼容测试注入的裸快照；生产里每一处 setSnapshot 都会打标记
      // （invariants 里有断言钉着）。
      const belongs = snapshot !== null && (snapshot.__sid === undefined || snapshot.__sid === sessionId)
      const view = belongs ? snapshot : null
      // phase/fast 必须在 useEffect 之前求值（依赖数组会立即读它们）。
      //
      // 默认值**绝不能是 'ready'**：新会话刚打开时快照还没回来，那样会把"不知道"
      // 显示成"指挥员已就绪"，于是看起来新会话凭空有了指挥员、还点不出初始化。
      // 'loading' 是"还没读到"，与"确实没有"（'none'）必须分开。
      const phase = view?.phase ?? 'loading'
      const fast = phase === 'provisioning' || view?.preheat?.state === 'running'

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          readState(sessionId)
            .then((next) => {
              if (alive) setSnapshot({ ...next, __sid: sessionId })
            })
            .catch(() => {
              // 读不到就保持上一份快照：图标不消失，也不刷屏。
            })
        }
        tick()
        const timer = setInterval(tick, fast ? FAST_MS : POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId, fast])

      // 进模型面板时才拉清单（几十条路由，没必要跟着轮询走）。
      React.useEffect(() => {
        if (panel !== 'models' || models !== null) return undefined
        let alive = true
        setModelError('')
        readModels(sessionId)
          .then((next) => {
            if (alive) setModels(next)
          })
          .catch((error) => {
            if (alive) setModelError(String(error?.message ?? error))
          })
        return () => {
          alive = false
        }
      }, [panel, models, sessionId])

      React.useEffect(() => {
        if (!open) return undefined
        // 判断某个事件目标是不是菜单内部。
        //
        // 不用 `instanceof Node`：测试环境没有 Node 全局，会直接抛。
        // 用鸭子类型判 nodeType 足够，而且不会因为跨 iframe 的原型差异误判。
        const isNode = (target) => target !== null && typeof target === 'object' && typeof target.nodeType === 'number'
        const insideMenu = (target) => {
          const menu = document.querySelector('[data-commander-menu]')
          if (menu === null || menu === undefined) return false
          if (menu === target) return true
          if (!isNode(target)) return false
          return typeof menu.contains === 'function' ? menu.contains(target) : false
        }
        const onDown = (event) => {
          if (insideMenu(event.target)) return
          if (buttonRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        // **外部**滚动才关（锚点失效）。菜单自己的滚动容器必须豁免：
        // 模型列表有几十条、要滚才能看到，一滚就关等于根本选不了。
        const onScroll = (event) => {
          if (insideMenu(event.target)) return
          setOpen(false)
        }
        const close = () => setOpen(false)
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', close)
        }
      }, [open])

      const mode = view?.mode ?? 'off'
      const labels = view?.labels ?? {}
      const preheat = view?.preheat
      const palette = PALETTE[mode] ?? PALETTE.observe
      const canInit = view?.canInit !== false
      const title = badgeTitle({ phase, label: labels[mode] ?? mode, mode, preheat, canInit })

      /** 还没有指挥员 → 模型必须现在选，且建立后不可改。 */
      const pinned = !(view?.hasCommander === true || phase === 'ready')

      /** 菜单里那行"当前指挥员模型"的短标签。 */
      const currentRoute = models?.current ?? view?.route ?? null
      const routeSummary = currentRoute === null
        ? '跟随主会话'
        : `${currentRoute.provider}/${currentRoute.model}`

      /**
       * 模型面板。**未建立时=选模型（建立即定型）；已建立时=只读展示。**
       * 宿主没有"改子会话模型"的合法表示，早先那套 append model/selection 的
       * 绕法会把会话写坏，最后连话都说不上——所以这里不再提供"换"。
       */
      const renderModels = () => {
        const rows = []
        rows.push(h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 4px 6px' },
        },
        h('button', {
          type: 'button',
          onClick: () => setPanel('modes'),
          style: {
            border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
            fontSize: 13, padding: '2px 4px', borderRadius: 6, lineHeight: 1,
          },
        }, '←'),
        h('span', { style: { flex: 1, opacity: 0.85 } }, pinned ? '选模型并建立' : '指挥员模型'),
        h('span', { style: { opacity: 0.5, fontSize: 11 } }, routeSummary),
        ))
        // 未建立时这是"一次性决策"：必须说清选了就不能改，否则用户会以为以后还能换。
        if (pinned) {
          rows.push(h('div', {
            style: {
              padding: '0 6px 6px', fontSize: 11, lineHeight: 1.5,
              color: 'var(--dsh-text-secondary, #8b8b93)',
            },
          }, '选定后建立指挥员；模型之后就固定了，不能更换。'))
        }
        // 错误条永远置顶（既涵盖"读清单失败"也涵盖"换模型失败"），
        // 有列表时列表照常显示——失败不该让用户失去已经加载好的选项。
        if (modelError.length > 0) {
          rows.push(h('div', { style: { padding: '6px 8px', color: '#ef4444', fontSize: 11, lineHeight: 1.5 } },
            modelError))
          if (models === null) return rows
        }
        if (models === null) {
          rows.push(h('div', { style: { padding: '10px 8px', opacity: 0.6 } }, '读取中…'))
          return rows
        }
        if (!Array.isArray(models.groups) || models.groups.length === 0) {
          rows.push(h('div', { style: { padding: '10px 8px', opacity: 0.6 } },
            '没有可用的模型（宿主的 llm 服务没列出任何路由）'))
          return rows
        }
        rows.push(h('div', { style: { padding: '0 8px 6px', opacity: 0.5, fontSize: 11, lineHeight: 1.5 } },
          '选中就换（原地切换，上下文保留）'))
        rows.push(h('div', {
          style: { maxHeight: MODELS_MAX_HEIGHT, overflowY: 'auto', overflowX: 'hidden' },
        }, models.groups.map((group) => h('div', { key: `g-${group.provider}` },
          h('div', {
            style: { padding: '4px 8px 2px', opacity: 0.5, fontSize: 11, position: 'sticky', top: 0 },
          }, group.provider),
          (group.models ?? []).map((id) => {
            const selected = currentRoute !== null
              && currentRoute.provider === group.provider && currentRoute.model === id
            return h('button', {
              key: `m-${group.provider}-${id}`,
              type: 'button',
              onClick: () => pickModel(group.provider, id),
              style: {
                ...ROW, gap: 6, padding: '4px 8px 4px 14px', borderRadius: 6,
                background: rowBackground(selected),
              },
            },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
            selected ? h('span', { style: { opacity: 0.6, fontSize: 11 } }, '当前') : null,
            )
          }),
        ))))
        return rows
      }

      const run = (body) => {
        if (busy) return
        setBusy(true)
        setOpen(false)
        post(sessionId, body)
          .then((next) => setSnapshot({ ...next, __sid: sessionId }))
          .catch(() => {
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
        // 还没建立 → 先选模型（建立即定型）；已建立 → 只有四个挡位。
        setPanel(pinned ? 'models' : 'modes')
        const rect = buttonRef.current?.getBoundingClientRect?.()
        if (rect) {
          const vw = window.innerWidth || 1280
          const vh = window.innerHeight || 800
          const left = Math.min(Math.max(8, rect.left - 8), Math.max(8, vw - MENU_WIDTH - 8))
          const openUp = rect.top > MENU_HEIGHT + 16
          setAnchor({ left, top: openUp ? rect.top - 8 : rect.bottom + 8, openUp })
        }
        setOpen(true)
      }

      /** 选中一个模型 = 带着它建立指挥员。建立之后没有"换"这回事。 */
      const pickModel = (provider, model) => {
        if (busy) return
        setModelError('')
        run({ init: true, route: { provider, model } })
      }


      // 子会话一律不画（第二道保险；第一道在 `sessionIsChild`）。
      if (view !== null && view.canControl === false) return null

      const menu = open && anchor
        ? h('div', {
          'data-commander-menu': '1',
          style: {
            position: 'fixed', left: anchor.left, top: anchor.top,
            transform: anchor.openUp ? 'translateY(-100%)' : 'none',
            zIndex: 2147483000, width: panel === 'models' ? MODELS_WIDTH : MENU_WIDTH,
            boxSizing: 'border-box', padding: 4,
            borderRadius: 10, border: '1px solid rgba(127,127,127,0.35)',
            background: 'var(--dsh-surface-raised, #1f1f22)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)', fontSize: 12,
            // 兜底：模型面板比挡位面板高得多，别让它顶出屏幕。
            // 菜单自身滚动也走鼠标滚轮，因为豁免逻辑认得"在菜单内"。
            maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', overflowX: 'hidden',
          },
        // 还没建立时只可能是"选模型"：那时候四个挡位没有意义。
        }, pinned || panel === 'models' ? renderModels() : [
          ...ORDER.map((option) => h('button', {
            key: option,
            type: 'button',
            onClick: () => run({ mode: option }),
            style: {
              ...ROW, gap: 8, padding: '6px 8px', borderRadius: 7,
              background: rowBackground(option === mode),
            },
          },
          h(Crown, { mode: option, size: 14 }),
          h('span', { style: { flex: 1 } }, labels[option] ?? option),
          option === mode ? h('span', { style: { opacity: 0.6 } }, '当前') : null,
          )),
          h('div', { style: { height: 1, margin: '4px 2px', background: 'rgba(127,127,127,0.25)' } }),
          // 只读：模型在建立时定死，这里只让人知道它跑在哪个模型上。
          h('div', {
            style: { ...ROW, gap: 8, padding: '4px 8px', fontSize: 11, opacity: 0.6 },
          },
          h('span', { style: { width: 14, textAlign: 'center' } }, '⇄'),
          h('span', { style: { flex: 1 } }, '模型（建立时固定）'),
          h('span', { style: { maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            routeSummary),
          ),
        ])
        : null

      const portalMenu = menu && typeof ReactDOM?.createPortal === 'function'
        ? ReactDOM.createPortal(menu, document.body) : menu

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('button', {
          ref: buttonRef,
          type: 'button',
          title,
          'aria-label': title,
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          disabled: busy,
          // loading 时按钮不做事：还没读到状态就点，只会得到"点了没反应"或误建。
          // 空会话（canInit=false）同理：宿主没有 Agent，点了只会拿到 409。
          onClick: phase === 'loading' || (phase === 'none' && !canInit)
            ? () => {}
            : toggleMenu,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, padding: 0, borderRadius: 8,
            border: `1px solid ${failed ? '#ef4444' : open ? palette.ring : 'transparent'}`,
            background: open ? 'rgba(127,127,127,0.14)' : 'transparent',
            color: 'inherit',
            cursor: busy ? 'progress' : phase === 'loading' ? 'default' : 'pointer',
            opacity: busy ? 0.6 : phase === 'loading' ? 0.5 : palette.dim,
          },
        }, h(PhaseIcon, { phase, mode, preheat })),
        portalMenu,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (document.querySelector('style[data-commander-spin]') === null) {
            const style = document.createElement('style')
            style.dataset.commanderSpin = '1'
            style.textContent = '@keyframes cmdr-core-spin { to { transform: rotate(360deg) } }'
            document.head.appendChild(style)
          }
        } catch {
          // 无 document 环境（测试/SSR）时跳过
        }
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'commander-takeover', order: 10 }, TakeoverSlot),
        )
      },
    }
  },
})
