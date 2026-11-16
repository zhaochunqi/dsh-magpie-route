import { collectRoutes, describeError } from './route-query.js'

/** Stable Loader identity. */
export const name = 'magpie-route'

/** Only the same-origin route remains: the plugin has no command and no agent tool. */
export const inject = ['webServer', 'connection']

/** Last resort only. The real endpoint comes from the DSH profile's magpie provider. */
const FALLBACK_BASE_URL = 'http://127.0.0.1:3425'
const DEFAULT_AGENT = 'dsh'

/** Same-origin endpoint for the composer dock; browsers cannot call the gateway directly (no CORS). */
const CLIENT_ROUTE = '/plugins/magpie-route/route'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Both the OpenAI-compatible and Anthropic routes go through the same magpie gateway. */
function isMagpieProvider(provider) {
  return typeof provider === 'string' && /^magpie(?:-|$)/u.test(provider)
}

/**
 * Reduce a pi-ai provider endpoint to the magpie gateway root, where the
 * `/v1/magpie/*` read endpoints live.
 *
 * `http://127.0.0.1:3425/v1` -> `http://127.0.0.1:3425`
 * `https://host/prefix/v1`    -> `https://host/prefix`
 * `http://127.0.0.1:3425`     -> `http://127.0.0.1:3425`
 */
function gatewayOriginOf(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) return undefined
  try {
    const url = new URL(baseURL.trim())
    const path = url.pathname.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '')
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

/** Pull `providers.magpie.baseURL` out of a raw `llm-pi-ai` config object. */
function magpieBaseURLFromConfig(config) {
  if (!config || typeof config !== 'object') return undefined
  const providers = config.providers && typeof config.providers === 'object' ? config.providers : undefined
  if (providers === undefined) return undefined
  const route = providers.magpie ?? providers['magpie-anthropic']
  return route && typeof route === 'object' && typeof route.baseURL === 'string'
    ? route.baseURL
    : undefined
}

/**
 * Read the endpoint from the live Loader entry without touching the profile
 * patch file. `fiber.effectiveConfig` is the config DSH actually activated.
 */
function readFromLoader(ctx) {
  try {
    const loader = ctx.get('loader')
    if (loader === undefined || typeof loader.entries !== 'function') return undefined
    for (const entry of loader.entries()) {
      if (entry?.options?.id !== 'llm-pi-ai') continue
      const effective = entry.fiber?.effectiveConfig
      if (!effective) continue
      // `providers` is a volatile reference on the resolved Config.
      const providers = effective.providers
      const raw = providers && typeof providers.get === 'function' ? providers.get() : providers
      const found = magpieBaseURLFromConfig({ providers: raw })
      if (found !== undefined) return found
    }
  } catch {
    /* fall through to configEditor */
  }
  return undefined
}

/**
 * Compose the profile the same way the config editor does and read the
 * `llm-pi-ai` row. Used for the first paint, before any inference has run.
 */
function readFromConfigEditor(ctx) {
  try {
    const editor = ctx.get('configEditor')
    if (editor === undefined || typeof editor.configuration !== 'function') return undefined
    const row = editor.configuration().find(candidate => candidate?.entry?.options?.id === 'llm-pi-ai')
    if (row === undefined) return undefined
    return magpieBaseURLFromConfig(row.override) ?? magpieBaseURLFromConfig(row.inherited)
  } catch {
    return undefined
  }
}

/**
 * Serve the same-origin read route that the client dock polls.
 *
 * The gateway address is discovered from DSH instead of being configured here:
 * every magpie inference reports its resolved endpoint through the
 * `llm-pi-ai/request-headers` waterfall, and before the first inference the
 * plugin reads the `llm-pi-ai` row's `providers.magpie.baseURL`. An explicit
 * `config.baseURL` still wins, and `http://127.0.0.1:3425` is the last resort.
 *
 * The Host half also tags every magpie inference with `X-Magpie-Session`, so
 * the gateway can answer `/v1/magpie/route?session=...` for *this* DSH session
 * (including an in-flight request's already-picked target). The trace endpoint
 * remains the fallback for the first paint and for profiles where no inference
 * has happened yet. The plugin adds no command and no agent tool.
 */
export function apply(ctx, config = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  const configuredBaseURL = typeof raw.baseURL === 'string' && raw.baseURL.trim().length > 0
    ? (gatewayOriginOf(raw.baseURL) ?? raw.baseURL.trim())
    : undefined
  const settings = {
    agent: typeof raw.agent === 'string' && raw.agent.trim().length > 0 ? raw.agent.trim() : DEFAULT_AGENT,
    limit: raw.limit,
  }

  const connection = ctx.connection
  let lastSession
  let eventBaseURL
  let storedBaseURL

  /** First-paint lookup from DSH config; cached once a value is found. */
  const profileBaseURL = () => {
    if (storedBaseURL !== undefined) return storedBaseURL
    const found = readFromLoader(ctx) ?? readFromConfigEditor(ctx)
    storedBaseURL = gatewayOriginOf(found)
    return storedBaseURL
  }

  const currentBaseURL = () => configuredBaseURL ?? eventBaseURL ?? profileBaseURL() ?? FALLBACK_BASE_URL

  // Only a transport header is added; the request body, model, and tool set are untouched.
  ctx.effect(() => ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (isMagpieProvider(request.provider)) {
      const gateway = gatewayOriginOf(request.baseURL)
      if (gateway !== undefined) eventBaseURL = gateway
      if (typeof request.sessionId === 'string' && request.sessionId.length > 0) {
        lastSession = request.sessionId
        headers.set('x-magpie-session', request.sessionId)
      }
    }
    return next()
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    resource: async (request) => {
      const rejection = connection.requestRejection(request)
      if (rejection !== undefined) return new Response(null, { status: rejection })

      const url = new URL(request.url)
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== url.origin) {
        return jsonResponse({ error: 'forbidden origin' }, 403)
      }
      const baseURL = currentBaseURL()
      try {
        let result
        if (lastSession) {
          result = await collectRoutes({ ...settings, baseURL, session: lastSession, signal: request.signal })
          if (result.kind === 'session-empty') {
            result = await collectRoutes({ ...settings, baseURL, limit: 1, signal: request.signal })
          }
        } else {
          result = await collectRoutes({ ...settings, baseURL, limit: 1, signal: request.signal })
        }
        return jsonResponse({ ...result, baseURL })
      } catch (error) {
        return jsonResponse({ error: describeError(error, baseURL), baseURL }, 502)
      }
    },
  }))
}
