/**
 * 指挥员接管状态图标（客户端半）。
 *
 * 位置：composer 工具行 `conversation.input.right`（模型选择器与发送键之间）。
 * 数据：Host 半注册的 `/commander/takeover` 路由；客户端是普通浏览器模块，
 *       可以直接 fetch，不需要动态插件那套 host.call。
 *
 * 四态：off 不显示 / observe 灰描边 / partial 蓝实心 / full 琥珀实心 + 呼吸。
 * 点击循环切换，Host 侧会把选择写进 state.json 的 takeover 表。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-commander',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/commander/takeover'
    const POLL_MS = 8000

    const STYLE = {
      off: { ring: 'rgba(127,127,127,0.45)', fill: 'transparent', glow: 'none' },
      observe: { ring: 'rgba(127,127,127,0.75)', fill: 'transparent', glow: 'none' },
      partial: { ring: '#3b82f6', fill: '#3b82f6', glow: 'none' },
      full: { ring: '#f59e0b', fill: '#f59e0b', glow: '0 0 0 3px rgba(245,158,11,0.22)' },
    }

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

    /** 一顶小皇冠：接管 = 指挥员在位。 */
    function Crown({ state }) {
      const palette = STYLE[state] ?? STYLE.observe
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          'aria-hidden': true,
          style: { display: 'block' },
        },
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
      const [busy, setBusy] = React.useState(false)

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

      if (!snapshot || snapshot.state === 'off') return null

      const state = snapshot.state
      const palette = STYLE[state] ?? STYLE.observe
      const label = snapshot.label ?? state
      const title = `接管状态：${label}（${state}）— 点击切换`

      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          disabled: busy,
          onClick: () => {
            if (busy) return
            setBusy(true)
            writeState(sessionId, 'next')
              .then((next) => setSnapshot(next))
              .catch(() => {})
              .finally(() => setBusy(false))
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            height: 24,
            minWidth: 24,
            padding: '0 6px',
            borderRadius: 999,
            border: `1px solid ${palette.ring}`,
            background: state === 'observe' ? 'transparent' : 'rgba(127,127,127,0.10)',
            boxShadow: palette.glow,
            color: 'inherit',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
            fontSize: 11,
            lineHeight: 1,
          },
        },
        h(Crown, { state }),
        h('span', { style: { opacity: 0.85 } }, state === 'full' ? '全' : state === 'partial' ? '管' : '观'),
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
