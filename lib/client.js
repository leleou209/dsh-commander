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
  id: '@local/dsh-commander',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const ENDPOINT = '/commander/takeover'
    const POLL_MS = 8000
    const FAST_MS = 1000
    const MENU_WIDTH = 208
    const MENU_HEIGHT = 186
    const ORDER = ['off', 'observe', 'partial', 'full']

    const PALETTE = {
      off: { ring: 'rgba(127,127,127,0.45)', fill: 'rgba(127,127,127,0.25)', dim: 0.55 },
      observe: { ring: 'rgba(160,160,160,0.85)', fill: 'rgba(160,160,160,0.35)', dim: 1 },
      partial: { ring: '#3b82f6', fill: '#3b82f6', dim: 1 },
      full: { ring: '#f59e0b', fill: '#f59e0b', dim: 1 },
    }

    async function readState(sessionId) {
      const response = await fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function post(sessionId, body) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

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

    function badgeTitle({ phase, label, mode, preheat }) {
      if (phase === 'none') return '启用指挥员：会创建本会话的指挥员并预热（读 doc 四件套，一次模型调用）；完成后它只待命，不会让主会话自动开工'
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
      // phase/fast 必须在 useEffect 之前求值（依赖数组会立即读它们）。
      const phase = snapshot?.phase ?? 'ready'
      const fast = phase === 'provisioning' || snapshot?.preheat?.state === 'running'

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          readState(sessionId)
            .then((next) => {
              if (alive) setSnapshot(next)
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

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const menu = document.querySelector('[data-commander-menu]')
          if (menu?.contains(event.target)) return
          if (buttonRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const close = () => setOpen(false)
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
        }
      }, [open])

      const mode = snapshot?.mode ?? 'off'
      const labels = snapshot?.labels ?? {}
      const preheat = snapshot?.preheat
      const palette = PALETTE[mode] ?? PALETTE.observe
      const title = badgeTitle({ phase, label: labels[mode] ?? mode, mode, preheat })

      const run = (body) => {
        if (busy) return
        setBusy(true)
        setOpen(false)
        post(sessionId, body)
          .then((next) => setSnapshot(next))
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

      // 子会话的第二道兜底（首帧已由 TakeoverSlot 拦掉）。放在所有 hooks 之后。
      if (snapshot !== null && snapshot.canControl === false) return null

      const menu = open && anchor
        ? h('div', {
          'data-commander-menu': '1',
          style: {
            position: 'fixed', left: anchor.left, top: anchor.top,
            transform: anchor.openUp ? 'translateY(-100%)' : 'none',
            zIndex: 2147483000, width: MENU_WIDTH, boxSizing: 'border-box', padding: 4,
            borderRadius: 10, border: '1px solid rgba(127,127,127,0.35)',
            background: 'var(--dsh-surface-raised, #1f1f22)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)', fontSize: 12,
          },
        }, ORDER.map((option) => h('button', {
          key: option,
          type: 'button',
          onClick: () => run({ mode: option }),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px',
            border: 'none', borderRadius: 7, textAlign: 'left', fontSize: 12, cursor: 'pointer',
            background: option === mode ? 'rgba(127,127,127,0.16)' : 'transparent', color: 'inherit',
          },
        },
        h(Crown, { mode: option, size: 14 }),
        h('span', { style: { flex: 1 } }, labels[option] ?? option),
        option === mode ? h('span', { style: { opacity: 0.6 } }, '当前') : null,
        )))
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
          onClick: phase === 'none' || phase === 'failed' ? () => run({ init: true }) : toggleMenu,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, padding: 0, borderRadius: 8,
            border: `1px solid ${failed ? '#ef4444' : open ? palette.ring : 'transparent'}`,
            background: open ? 'rgba(127,127,127,0.14)' : 'transparent',
            color: 'inherit', cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : palette.dim,
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
