/**
 * Read-only magpie gateway lookups for the real upstream route.
 * Pure JavaScript with no DSH imports, so it can also be exercised by Node directly.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:3425'
const DEFAULT_AGENT = 'dsh'
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const TIMEOUT_MS = 4000

export function normalizeBaseURL(baseURL) {
  const value = typeof baseURL === 'string' && baseURL.trim() ? baseURL.trim() : DEFAULT_BASE_URL
  return value.replace(/\/+$/u, '')
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`magpie gateway timed out after ${timeoutMs}ms`)), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

async function getJson(url, signal) {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json()
}

function timeOf(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length >= 19 ? text.slice(11, 19) : (text || '--:--:--')
}

function ruleOf(route) {
  const use = route?.rule?.use
  return typeof use === 'string' && use ? use : ''
}

/**
 * Read the real upstream route from the local magpie gateway.
 * With `session`, query /v1/magpie/route; otherwise read /v1/magpie/trace.
 */
export async function collectRoutes(options = {}) {
  const { baseURL, agent = DEFAULT_AGENT, session, signal, timeoutMs = TIMEOUT_MS } = options
  const base = normalizeBaseURL(baseURL)
  const rawLimit = Number(options.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_LIMIT
  const timeout = withTimeout(signal, Math.max(500, Number(timeoutMs) || TIMEOUT_MS))
  try {
    if (session) {
      const url = `${base}/v1/magpie/route?session=${encodeURIComponent(session)}`
      const data = await getJson(url, timeout.signal)
      const route = data?.route
      if (!route || typeof route !== 'object') {
        return { kind: 'session-empty', source: url, session, routes: [] }
      }
      return {
        kind: 'session',
        source: url,
        session,
        pending: route.done === false ? 1 : 0,
        routes: [{
          time: timeOf(route.time),
          asked: typeof route.asked === 'string' ? route.asked : '',
          real: typeof route.model === 'string' ? route.model : '(unknown)',
          rule: ruleOf(route),
          pending: route.done === false,
        }],
      }
    }
    const url = `${base}/v1/magpie/trace`
    const data = await getJson(url, timeout.signal)
    const rows = Array.isArray(data?.routes) ? data.routes : []
    const filtered = rows.filter(row => row && row.agent === agent)
    // A request still in flight has no `usage`, so it cannot name a real upstream yet.
    // Report settled routes only and count the unsettled ones separately.
    const completed = filtered.filter(row => Array.isArray(row.usage) && row.usage.length > 0)
    const recent = completed.slice(-limit).reverse()
    return {
      kind: 'trace',
      source: url,
      agent,
      window: rows.length,
      total: filtered.length,
      pending: filtered.length - completed.length,
      routes: recent.map(row => {
        const usage = row.usage
        const real = usage
          .map(entry => [entry?.provider, entry?.model].filter(Boolean).join('/'))
          .filter(Boolean)
          .join(', ')
        return {
          time: timeOf(row.time),
          asked: typeof row.model === 'string' ? row.model : '',
          real: real || '(unknown)',
          rule: ruleOf(row),
          pending: false,
        }
      }),
    }
  } finally {
    timeout.dispose()
  }
}

/** Render a bounded, human-readable route report. */
export function formatRoutes(result) {
  if (result.kind === 'session-empty') {
    return [
      `该会话在 magpie 里没有 route 记录（session ${result.session}）。`,
      'DSH 目前不发送 X-Magpie-Session，网关无法按会话关联路由；magpie 会话 id 不是 DSH 会话 id。',
      '可从 magpie sessions --json 或 magpie usage --csv 找到 magpie 会话 id。',
      '直接输入 /magpie-route 查看最近请求的真实落点。',
    ].join('\n')
  }
  const lines = []
  if (result.kind === 'session') {
    lines.push(`magpie 真实路由 · 会话 ${result.session}`)
  } else {
    lines.push(`magpie 真实路由 · 最近 ${result.routes.length} 次已完成的 ${result.agent} 请求（网关窗口 ${result.window} 条 / 匹配 ${result.total} 条）`)
  }
  for (const route of result.routes) {
    const rule = route.rule ? `  [${route.rule}]` : ''
    const pending = route.pending ? '  (进行中)' : ''
    // The composer picker shows `magpie/group/daily`; keep the same spelling here.
    const asked = /^(?:group|auto)\//u.test(route.asked) ? `magpie/${route.asked}` : route.asked
    lines.push(`${route.time}  ${asked} → ${route.real}${rule}${pending}`)
  }
  if (result.routes.length === 0) lines.push('(没有已完成的请求)')
  if (result.kind === 'trace' && result.pending > 0) {
    lines.push(`另有 ${result.pending} 条进行中的请求尚未记录 usage，暂无法确认真实落点。`)
  }
  lines.push(`数据源 ${result.source}`)
  lines.push('路由组别名由 magpie 按规则与会话亲和逐轮决定，不是固定模型。')
  return lines.join('\n')
}

export function describeError(error, baseURL) {
  const reason = error instanceof Error ? error.message : String(error)
  return `查询 magpie 网关失败：${reason}\n当前使用的网关地址是 ${normalizeBaseURL(baseURL)}（自动取自 DSH 里 llm-pi-ai 的 magpie baseURL）；请确认 magpie 正在运行并监听该地址（/v1/magpie/trace、/v1/magpie/route）。如 DSH 里的地址与实际不符，可在插件 config.baseURL 里覆盖。`
}
