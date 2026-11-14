/**
 * Client dock: one ambient line below the composer that shows the real upstream
 * model behind the configured magpie routing group. It polls the package's
 * Host half over a same-origin route (the gateway itself sends no CORS headers).
 * Clicking the line refreshes immediately; the row also refreshes every 15s.
 *
 * Only the `react` module is required here; all styling is inline so the factory
 * does not depend on any other client builtin.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-magpie-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/plugins/magpie-route/route'
    const REFRESH_MS = 15000

    const baseStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      minWidth: 0,
      margin: 0,
      padding: '2px 4px',
      border: 0,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1.4,
      textAlign: 'left',
      cursor: 'pointer',
      borderRadius: 6,
    }
    const textStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    function timeOf(value) {
      const text = typeof value === 'string' ? value : ''
      return text.length >= 19 ? text.slice(11, 16) : ''
    }

    function MagpieRouteDock() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        let timer = null
        const run = async () => {
          try {
            const response = await fetch(`${ROUTE}?limit=1`, { headers: { accept: 'application/json' } })
            const body = await response.json()
            if (!alive) return
            if (!response.ok || body.error) {
              setState({ phase: 'error', message: body.error || 'magpie 网关不可用' })
            } else {
              setState({ phase: 'ok', route: (body.routes || [])[0] || null, pending: body.pending || 0 })
            }
          } catch (error) {
            if (alive) setState({ phase: 'error', message: String((error && error.message) || error) })
          }
          if (alive) timer = setTimeout(run, REFRESH_MS)
        }
        void run()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [nonce])

      let dot = 'var(--dsw-alias-state-idle-primary)'
      let text = 'magpie 真实路由 · 读取中…'
      let title = '点击刷新'
      if (state.phase === 'error') {
        dot = 'var(--dsw-alias-state-error-primary)'
        text = 'magpie 真实路由 · 网关不可用（点击重试）'
        title = state.message || text
      } else if (state.phase === 'ok') {
        const route = state.route
        if (!route) {
          text = 'magpie 真实路由 · 暂无已完成的请求'
          title = '点击刷新'
        } else {
          dot = 'var(--dsw-alias-state-success-primary)'
          const asked = route.asked ? `${route.asked} → ` : ''
          const rule = route.rule ? ` [${route.rule}]` : ''
          const pending = state.pending > 0 ? ` · 另有 ${state.pending} 条进行中` : ''
          text = `magpie 真实路由 · ${timeOf(route.time)} ${asked}${route.real}${rule}${pending}`
          title = `数据源 ${ROUTE} · 点击刷新`
        }
      }

      return h('button', {
        type: 'button',
        style: baseStyle,
        title,
        'aria-label': 'magpie 真实路由，点击刷新',
        onClick: () => setNonce(value => value + 1),
      },
      h('span', {
        style: {
          flex: '0 0 auto',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dot,
        },
      }),
      h('span', { style: textStyle }, text))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'magpie-route-dock',
          order: 40,
        }, MagpieRouteDock))
      },
    }
  },
})
