/**
 * Client dock: one ambient line below the composer that shows the real upstream
 * model behind the configured magpie routing group. It polls the package's
 * Host half over a same-origin route (the gateway itself sends no CORS headers).
 * Clicking the line refreshes immediately; the row also refreshes every 15s.
 *
 * The label follows the DSH UI language (Chinese / English). Only the `react`
 * module is required; all styling is inline so the factory does not depend on
 * any other client builtin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-magpie-route',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/plugins/magpie-route/route'
    const REFRESH_MS = 15000
    const NS = 'magpieRoute'

    const DICT = {
      zh: {
        label: 'magpie 真实路由',
        loading: '读取中…',
        unreachable: '网关不可用（点击重试）',
        none: '暂无已完成的请求',
        inFlightPrefix: '另有 ',
        inFlightSuffix: ' 条进行中',
        clickRefresh: '点击刷新',
        sourcePrefix: '数据源 ',
        sourceSuffix: ' · 点击刷新',
        aria: 'magpie 真实路由，点击刷新',
      },
      en: {
        label: 'magpie real route',
        loading: 'loading…',
        unreachable: 'gateway unreachable (click to retry)',
        none: 'no settled request yet',
        inFlightPrefix: '',
        inFlightSuffix: ' in flight',
        clickRefresh: 'click to refresh',
        sourcePrefix: 'source ',
        sourceSuffix: ' · click to refresh',
        aria: 'magpie real route, click to refresh',
      },
    }

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

    function currentLang(ctx) {
      try {
        const snapshot = ctx.locale.getLocale()
        return String((snapshot && snapshot.id) || 'zh').slice(0, 2) === 'en' ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    function MagpieRouteDock(props) {
      const ctx = props.ctx
      const [state, setState] = React.useState({ phase: 'loading' })
      const [nonce, setNonce] = React.useState(0)
      const [lang, setLang] = React.useState(() => currentLang(ctx))

      React.useEffect(() => {
        let unsubscribe = null
        try {
          unsubscribe = ctx.locale.subscribe(() => setLang(currentLang(ctx)))
        } catch {
          /* locale is optional for rendering */
        }
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [ctx])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const run = async () => {
          try {
            const response = await fetch(`${ROUTE}?limit=1`, { headers: { accept: 'application/json' } })
            const body = await response.json()
            if (!alive) return
            if (!response.ok || body.error) {
              setState({ phase: 'error', message: body.error || 'magpie gateway unavailable' })
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

      const t = DICT[lang] || DICT.zh
      let dot = 'var(--dsw-alias-state-idle-primary)'
      let text = `${t.label} · ${t.loading}`
      let title = t.clickRefresh
      if (state.phase === 'error') {
        dot = 'var(--dsw-alias-state-error-primary)'
        text = `${t.label} · ${t.unreachable}`
        title = state.message || text
      } else if (state.phase === 'ok') {
        const route = state.route
        if (!route) {
          text = `${t.label} · ${t.none}`
        } else {
          dot = 'var(--dsw-alias-state-success-primary)'
          const asked = route.asked ? `${route.asked} → ` : ''
          const rule = route.rule ? ` [${route.rule}]` : ''
          const pending = state.pending > 0 ? ` · ${t.inFlightPrefix}${state.pending}${t.inFlightSuffix}` : ''
          text = `${t.label} · ${timeOf(route.time)} ${asked}${route.real}${rule}${pending}`
          title = `${t.sourcePrefix}${ROUTE}${t.sourceSuffix}`
        }
      }

      return h('button', {
        type: 'button',
        style: baseStyle,
        title,
        'aria-label': t.aria,
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
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          for (const locale of Object.keys(DICT)) {
            try {
              disposers.push(ctx.locale.register(NS, locale, DICT[locale]))
            } catch {
              /* locale registration is best-effort */
            }
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* ignore */
              }
            }
          }
        }, 'dsh-magpie-route: dictionaries')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'magpie-route-dock',
          order: 40,
        }, props => h(MagpieRouteDock, { ...props, ctx })))
      },
    }
  },
})
