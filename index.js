import { collectRoutes, describeError } from './route-query.js'

/** Stable Loader identity. */
export const name = 'magpie-route'

/** Only the same-origin route remains: the plugin has no command and no agent tool. */
export const inject = ['webServer']

const DEFAULTS = {
  baseURL: 'http://127.0.0.1:3425',
  agent: 'dsh',
  limit: 5,
}

/** Same-origin endpoint for the composer dock; browsers cannot call the gateway directly (no CORS). */
const CLIENT_ROUTE = '/plugins/magpie-route/route'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Serve the same-origin read route that the client dock polls. The client half
 * renders the composer-dock line; this plugin intentionally adds no command and
 * no agent tool.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    resource: async (request) => {
      const url = new URL(request.url)
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== url.origin) {
        return jsonResponse({ error: 'forbidden origin' }, 403)
      }
      const rawLimit = Number(url.searchParams.get('limit'))
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 1
      try {
        const result = await collectRoutes({ ...settings, limit, signal: request.signal })
        return jsonResponse(result)
      } catch (error) {
        return jsonResponse({ error: describeError(error, settings.baseURL) }, 502)
      }
    },
  }))
}
