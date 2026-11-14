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
 * Serve the same-origin read route that the client dock polls.
 *
 * The Host half also tags every magpie inference with `X-Magpie-Session`, so
 * the gateway can answer `/v1/magpie/route?session=...` for *this* DSH session
 * (including an in-flight request's already-picked target). The trace endpoint
 * remains the fallback for the first paint and for profiles where no inference
 * has happened yet. The plugin adds no command and no agent tool.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  let lastSession

  // Only a transport header is added; the request body, model, and tool set are untouched.
  ctx.effect(() => ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (request.provider === 'magpie'
      && typeof request.sessionId === 'string'
      && request.sessionId.length > 0) {
      lastSession = request.sessionId
      headers.set('x-magpie-session', request.sessionId)
    }
    return next()
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    resource: async (request) => {
      const url = new URL(request.url)
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== url.origin) {
        return jsonResponse({ error: 'forbidden origin' }, 403)
      }
      try {
        let result
        if (lastSession) {
          result = await collectRoutes({ ...settings, session: lastSession, signal: request.signal })
          if (result.kind === 'session-empty') {
            result = await collectRoutes({ ...settings, limit: 1, signal: request.signal })
          }
        } else {
          result = await collectRoutes({ ...settings, limit: 1, signal: request.signal })
        }
        return jsonResponse(result)
      } catch (error) {
        return jsonResponse({ error: describeError(error, settings.baseURL) }, 502)
      }
    },
  }))
}
