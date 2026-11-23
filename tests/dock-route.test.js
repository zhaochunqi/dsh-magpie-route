import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

const ROUTE_URL = 'http://127.0.0.1:52404/plugins/magpie-route/route'

/** Load the Host half against a minimal DSH context and expose its two hooks. */
function host() {
  const hooks = []
  let handler
  // Deliberately no `connection` member: 0.2.3 removed
  // `connection.requestRejection`, and the Host half must not call it.
  const ctx = {
    effect(fn) {
      return fn()
    },
    on(name, callback) {
      hooks.push({ name, callback })
      return () => {}
    },
    webServer: {
      register(entry) {
        handler = entry.resource
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  apply(ctx, { baseURL: 'http://127.0.0.1:3425' })
  assert.equal(typeof handler, 'function', 'register the same-origin dock route')
  return {
    /** Simulate DSH starting a magpie inference and return the headers it added. */
    startRequest(provider = 'magpie') {
      const headers = new Map()
      hooks
        .find(entry => entry.name === 'llm-pi-ai/request-headers')
        .callback({ provider, baseURL: 'http://127.0.0.1:3425/v1', sessionId: 'session-A' }, headers, () => undefined)
      return headers
    },
    get(query = '') {
      return handler(new Request(`${ROUTE_URL}${query}`))
    },
  }
}

function stubGateway(t) {
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: true,
    status: 200,
    async json() {
      assert.match(String(url), /\/v1\/magpie\/route\?session=session-A$/u)
      return {
        route: { time: '2026-11-21T09:30:00.000Z', asked: 'group/daily', model: 'provider/model', done: false },
      }
    },
  }))
}

const settled = (promise, timeoutMs = 300) => Promise.race([
  promise.then(() => 'settled'),
  new Promise(resolve => setTimeout(() => resolve('waiting'), timeoutMs)),
])

test('serves the dock route without any Connection API', async t => {
  stubGateway(t)
  const api = host()
  const response = await api.get('?session=session-A')
  assert.equal(response.status, 200, 'a missing connection service must not break the route')
})

test('reports the last request start and tags the inference with the session', async t => {
  stubGateway(t)
  const api = host()

  const headers = api.startRequest()
  assert.equal(headers.get('x-magpie-session'), 'session-A')

  const response = await api.get('?session=session-A&wait=1')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.kind, 'session')
  assert.equal(body.pending, 1)
  assert.equal(typeof body.lastRequestAt, 'number')
  assert.ok(body.lastRequestAt > 0, 'expose the request start for the client')
})

test('a caught-up query is held until the next request starts', async t => {
  stubGateway(t)
  const api = host()

  api.startRequest()
  const first = await (await api.get('?session=session-A')).json()

  const held = api.get(`?session=session-A&since=${first.lastRequestAt}&wait=1`)
  assert.equal(await settled(held), 'waiting', 'park an idle query instead of answering at once')

  const firedAt = Date.now()
  api.startRequest()
  assert.equal(await settled(held), 'settled', 'wake as soon as a request starts')
  const wakeMs = Date.now() - firedAt
  // A short settle lets the gateway record the request before the first read.
  assert.ok(wakeMs >= 150 && wakeMs < 500, `wake should settle quickly, took ${wakeMs}ms`)
  const body = await (await held).json()
  assert.ok(body.lastRequestAt >= first.lastRequestAt)
})

test('a session with no traffic yet parks until the first request', async t => {
  stubGateway(t)
  const api = host()

  const held = api.get('?session=session-A&since=0&wait=1')
  assert.equal(await settled(held), 'waiting', 'no request has happened yet, so nothing to draw')

  api.startRequest()
  assert.equal(await settled(held), 'settled')
  const body = await (await held).json()
  assert.ok(body.lastRequestAt > 0)
})

test('a query behind the last request answers without waiting', async t => {
  stubGateway(t)
  const api = host()

  api.startRequest()
  const first = await (await api.get('?session=session-A')).json()
  api.startRequest()

  assert.equal(await settled(api.get(`?session=session-A&since=${first.lastRequestAt}&wait=1`)), 'settled')
})

test('other providers neither park the dock nor add the session header', async t => {
  stubGateway(t)
  const api = host()

  const headers = api.startRequest('deepseek')
  assert.equal(headers.get('x-magpie-session'), undefined)

  const body = await (await api.get('?session=session-A&wait=1')).json()
  assert.equal(body.lastRequestAt, 0, 'only magpie inferences count as routing activity')
})
