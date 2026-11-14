import { collectRoutes, describeError, formatRoutes } from './route-query.js'

/** Stable Loader identity. */
export const name = 'magpie-route'

/** Services used by the tool, the command, and the client's same-origin route. */
export const inject = ['commands', 'tools', 'webServer']

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
 * Add a read-only query tool, a slash command, and the same-origin route behind
 * the composer dock. Nothing here changes routing or sends model requests.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const query = options => collectRoutes({ ...settings, ...options })

  ctx.effect(() => ctx.tools.register({
    name: 'magpie_route',
    description: 'Show the real upstream models magpie routed recent requests to, instead of the routing-group alias shown in the model picker.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: {
          type: 'string',
          description: 'Exact magpie session id to read one current route. Omit to read recent requests from the gateway trace.',
        },
        limit: {
          type: 'integer',
          description: 'Number of recent requests to show, 1-20. Defaults to 5.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        const input = args && typeof args === 'object' ? args : {}
        const result = await query({
          session: typeof input.session === 'string' && input.session.trim() ? input.session.trim() : undefined,
          limit: input.limit,
          signal: exec.signal,
        })
        return { text: formatRoutes(result) }
      } catch (error) {
        return { text: describeError(error, settings.baseURL) }
      }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'magpie-route',
    description: '查询 magpie 路由组背后的真实上游模型 / Show the real upstream model behind a magpie routing group',
    input: { hint: '[N | magpie-session-id]' },
    handler: async ({ rawInput, signal }) => {
      const argument = (rawInput ?? '').trim()
      const options = { signal }
      if (/^\d+$/u.test(argument)) options.limit = Number(argument)
      else if (argument) options.session = argument
      try {
        const result = await query(options)
        return { kind: 'success', text: formatRoutes(result) }
      } catch (error) {
        return { kind: 'error', text: describeError(error, settings.baseURL) }
      }
    },
  }))

  // The client dock polls this route; it stays same-origin so the browser never
  // needs CORS access to the local magpie gateway.
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
