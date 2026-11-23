import { collectRoutes, describeError } from './route-query.js'

/** Stable Loader identity. */
export const name = 'magpie-route'

/** Only the same-origin route remains: the plugin has no command and no agent tool. */
export const inject = ['webServer']

/** Last resort only. The real endpoint comes from the DSH profile's magpie provider. */
const FALLBACK_BASE_URL = 'http://127.0.0.1:3425'
const DEFAULT_AGENT = 'dsh'

/** Same-origin endpoint for the composer dock; browsers cannot call the gateway directly (no CORS). */
const CLIENT_ROUTE = '/plugins/magpie-route/route'

/**
 * How long an idle dock query is held open waiting for the next magpie request.
 * The dock sends an already-seen `since` and the Host answers the moment a
 * request starts, so the line updates within a second instead of on the next
 * fixed poll tick. Bounded well below any browser or proxy idle timeout.
 */
const IDLE_HOLD_MS = 8000

/**
 * Slack after a wake before the gateway is read.
 *
 * DSH reports the request through the header hook just before magpie receives
 * it, so the record lands a few milliseconds later. Reading at once would show
 * the previous request and wait for the client's one-second tick; this settles
 * the first read on the request that caused the wake.
 */
const WAKE_SETTLE_MS = 180

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
 * The Host half tags each magpie inference with `X-Magpie-Session`. The client
 * must supply its session ID when reading the corresponding route; there is no
 * global trace fallback, to avoid leaking another session's route.
 *
 * Refresh is event-driven rather than on a fixed tick: a query that is caught
 * up (`since` equals the last request this Host saw) is held open until the
 * next request starts, and the client asks again every second while a request
 * is being routed. `lastRequestAt` lets the client tell those two modes apart.
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

  let eventBaseURL
  let storedBaseURL

  /** Wall clock of the last magpie inference DSH started, or 0 before the first one. */
  let lastRequestAt = 0
  /** Idle dock queries parked on `wait=1`, woken as soon as a request starts. */
  const requestWaiters = new Set()

  function noteRequestStart() {
    // Strictly increasing, so a second request inside the same millisecond still
    // counts as newer than the value the dock already saw.
    lastRequestAt = Math.max(Date.now(), lastRequestAt + 1)
    const waiters = [...requestWaiters]
    requestWaiters.clear()
    for (const wake of waiters) wake()
  }

  /** Resolve on the next magpie request start, on `timeoutMs`, or when the client goes away. */
  function waitForRequestStart(signal, timeoutMs) {
    if (signal?.aborted === true) return Promise.resolve()
    return new Promise(resolve => {
      let timer
      const done = () => {
        clearTimeout(timer)
        requestWaiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      timer = setTimeout(done, timeoutMs)
      requestWaiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Resolve after `ms`, or when the client goes away. */
  function delay(ms, signal) {
    if (signal?.aborted === true) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

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
        headers.set('x-magpie-session', request.sessionId)
      }
      noteRequestStart()
    }
    return next()
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    // The web server admits this route as `required` before dispatching it
    // (405 for non-GET/HEAD, 401/403/503 for refused credentials), so the
    // resource only reads the URL. It must not call a Connection method here:
    // 0.2.3 dropped `connection.requestRejection`, and the resulting TypeError
    // surfaced as an empty 400 that left the dock stuck on "gateway unreachable".
    resource: async (request) => {
      const url = new URL(request.url)
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== url.origin) {
        return jsonResponse({ error: 'forbidden origin' }, 403)
      }
      const baseURL = currentBaseURL()
      try {
        const session = url.searchParams.get('session') || undefined
        const rawSince = url.searchParams.get('since')
        const since = rawSince === null ? undefined : Number(rawSince)
        // Idle dock: the client is caught up with `lastRequestAt` (0 included, so
        // a session with no traffic yet parks too), so hold the response open
        // until a new magpie request starts (bounded by IDLE_HOLD_MS).
        const caughtUp = Number.isFinite(since) && since >= lastRequestAt
        if (caughtUp && url.searchParams.get('wait') === '1') {
          const before = lastRequestAt
          await waitForRequestStart(request.signal, IDLE_HOLD_MS)
          // Woken by a request rather than by the hold expiring: let the gateway
          // record it first, so this read already names the new route.
          if (lastRequestAt > before) await delay(WAKE_SETTLE_MS, request.signal)
        }
        const result = session
          ? await collectRoutes({ ...settings, baseURL, session, signal: request.signal })
          : { kind: 'session-empty', session: '', routes: [] }
        return jsonResponse({ ...result, baseURL, lastRequestAt })
      } catch (error) {
        return jsonResponse({ error: describeError(error, baseURL), baseURL, lastRequestAt }, 502)
      }
    },
  }))
}
