/**
 * 指挥员接管状态图标（客户端半）。
 *
 * 位置：composer 工具行 `conversation.input.right`（模型选择器与发送键之间）。
 * 交互：
 *   - 平时只显示皇冠 logo（按状态着色，off 时压暗但仍可点，避免"关掉就找不回来"）；
 *   - 鼠标停靠显示当前状态（原生 tooltip + 悬停高亮）；
 *   - 点击弹出菜单，直接选 4 个状态之一或"自动（清除覆盖）"；
 *   - 选完短暂回显一次状态名，再回到纯 logo。
 *
 * 数据：Host 半的 `/commander/takeover` 路由（GET 读、POST 写）。
 * 客户端是普通浏览器模块，可以直接 fetch；菜单用 position:fixed 锚定按钮，
 * 因为 composer 会裁切普通浮层。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-commander',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/commander/takeover'
    const POLL_MS = 8000
    const FLASH_MS = 1600

    const PALETTE = {
      off: { ring: 'rgba(127,127,127,0.45)', fill: 'rgba(127,127,127,0.25)', dim: 0.55 },
      observe: { ring: 'rgba(160,160,160,0.85)', fill: 'rgba(160,160,160,0.35)', dim: 1 },
      partial: { ring: '#3b82f6', fill: '#3b82f6', dim: 1 },
      full: { ring: '#f59e0b', fill: '#f59e0b', dim: 1 },
    }

    const MENU_ORDER = ['off', 'observe', 'partial', 'full']

    async function readState(sessionId) {
      const response = await fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
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

    function TakeoverBadge(props) {
      const sessionId = props.sessionId
      const [snapshot, setSnapshot] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const [flash, setFlash] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const buttonRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          readState(sessionId)
            .then((next) => {
              if (alive) setSnapshot(next)
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      // 选完回显状态名，一会儿再收回
      React.useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(''), FLASH_MS)
        return () => clearTimeout(timer)
      }, [flash])

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
      const label = labels[state] ?? state
      const palette = PALETTE[state] ?? PALETTE.observe
      const title = `指挥员接管：${label}（${state}）— 点击选择`

      const choose = (next) => {
        if (busy) return
        setBusy(true)
        setOpen(false)
        writeState(sessionId, next)
          .then((result) => {
            setSnapshot(result)
            setFlash(result?.labels?.[result.state] ?? result?.state ?? '')
          })
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      const toggleMenu = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = buttonRef.current?.getBoundingClientRect?.()
        if (rect) setAnchor({ left: rect.left, top: rect.top })
        setOpen(true)
      }

      const menu =
        open && anchor
          ? h(
              'div',
              {
                'data-commander-takeover-menu': '1',
                style: {
                  position: 'fixed',
                  left: Math.max(8, anchor.left - 96),
                  top: Math.max(8, anchor.top - 8),
                  transform: 'translateY(-100%)',
                  zIndex: 2147483000,
                  minWidth: 196,
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
              h('div', {
                style: { height: 1, margin: '4px 6px', background: 'rgba(127,127,127,0.25)' },
              }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => choose('auto'),
                  style: {
                    display: 'block',
                    width: '100%',
                    padding: '6px 8px',
                    border: 'none',
                    borderRadius: 7,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 12,
                    opacity: 0.85,
                  },
                },
                '自动（跟随 goal 状态）',
              ),
            )
          : null

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
            onClick: toggleMenu,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              borderRadius: 8,
              border: `1px solid ${open ? palette.ring : 'transparent'}`,
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
          h(Crown, { state, size: 16 }),
        ),
        flash
          ? h(
              'span',
              {
                style: {
                  fontSize: 11,
                  lineHeight: 1,
                  opacity: 0.85,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                },
              },
              flash,
            )
          : null,
        menu,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'commander-takeover', order: 10 },
            TakeoverBadge,
          ),
        )
      },
    }
  },
})
