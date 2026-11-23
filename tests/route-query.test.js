import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectRoutes,
  describeError,
  formatRoutes,
  normalizeBaseURL,
} from '../route-query.js'
import { apply } from '../index.js'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

test('normalizeBaseURL uses the gateway default and removes trailing slashes', () => {
  assert.equal(normalizeBaseURL(), 'http://127.0.0.1:3425')
  assert.equal(normalizeBaseURL(' https://gateway.example/prefix/// '), 'https://gateway.example/prefix')
})

test('collectRoutes reads the current session route', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://gateway.example/v1/magpie/route?session=session%2F1')
    assert.equal(options.headers.accept, 'application/json')
    return response({
      route: {
        time: '2026-11-18T02:30:00.000Z',
        asked: 'group/daily',
        model: 'provider/model',
        done: false,
        rule: { use: 'cheap-first' },
      },
    })
  })

  assert.deepEqual(await collectRoutes({
    baseURL: 'https://gateway.example/',
    session: 'session/1',
  }), {
    kind: 'session',
    source: 'https://gateway.example/v1/magpie/route?session=session%2F1',
    session: 'session/1',
    pending: 1,
    routes: [{
      time: '02:30:00',
      asked: 'group/daily',
      real: 'provider/model',
      rule: 'cheap-first',
      pending: true,
    }],
  })
})

test('collectRoutes returns an empty session result when no route exists', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ route: null }))

  assert.deepEqual(await collectRoutes({ session: 'missing' }), {
    kind: 'session-empty',
    source: 'http://127.0.0.1:3425/v1/magpie/route?session=missing',
    session: 'missing',
    routes: [],
  })
})

test('formatRoutes explains when a DSH session has no route yet', () => {
  const text = formatRoutes({ kind: 'session-empty', session: 'session-1' })

  assert.match(text, /该 DSH 会话暂时没有 magpie route 记录/)
  assert.match(text, /发起一次 magpie 请求后/)
  assert.doesNotMatch(text, /magpie-route|DSH 目前不发送 X-Magpie-Session/u)
})

test('collectRoutes filters trace rows by agent and excludes unsettled requests', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://gateway/v1/magpie/trace')
    return response({
      routes: [
        { agent: 'other', time: '2026-11-18T01:00:00Z', model: 'ignored', usage: [{ provider: 'x', model: 'y' }] },
        { agent: 'dsh', time: '2026-11-18T02:00:00Z', model: 'group/old', usage: [{ provider: 'a', model: 'one' }] },
        { agent: 'dsh', time: '2026-11-18T02:10:00Z', model: 'group/pending' },
        { agent: 'dsh', time: '2026-11-18T02:20:00Z', model: 'group/new', usage: [{ provider: 'b', model: 'two' }, { provider: 'c', model: 'three' }] },
      ],
    })
  })

  assert.deepEqual(await collectRoutes({
    baseURL: 'http://gateway/',
    agent: 'dsh',
    limit: 1,
  }), {
    kind: 'trace',
    source: 'http://gateway/v1/magpie/trace',
    agent: 'dsh',
    window: 4,
    total: 3,
    pending: 1,
    routes: [{
      time: '02:20:00',
      asked: 'group/new',
      real: 'b/two, c/three',
      rule: '',
      pending: false,
    }],
  })
})

test('formatRoutes keeps the route label and pending count readable', () => {
  const text = formatRoutes({
    kind: 'trace',
    source: 'http://gateway/v1/magpie/trace',
    agent: 'dsh',
    window: 3,
    total: 2,
    pending: 1,
    routes: [{
      time: '02:20:00',
      asked: 'group/new',
      real: 'provider/model',
      rule: 'cheap-first',
      pending: false,
    }],
  })

  assert.match(text, /magpie 真实路由/)
  assert.match(text, /magpie\/group\/new → provider\/model\s+\[cheap-first\]/)
  assert.match(text, /另有 1 条进行中的请求/)
})

test('host route is session-scoped and never falls back to global trace', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    return response({
      route: {
        time: '2026-11-20T17:00:00.000Z',
        asked: 'group/newapi-strong',
        model: 'new-api/gpt-6-astra',
        done: true,
      },
    })
  })

  let registered
  const ctx = {
    webServer: { register(route) { registered = route } },
    effect(effect) { effect() },
    on() {},
    get() { return undefined },
  }
  apply(ctx, { baseURL: 'https://gateway.example' })

  const requestFor = session => new Request(
    `http://dsh.test/plugins/magpie-route/route${session ? `?session=${encodeURIComponent(session)}` : ''}`,
  )
  const current = await registered.resource(requestFor('current-session'))
  const currentBody = await current.json()
  assert.equal(currentBody.session, 'current-session')
  assert.equal(currentBody.routes[0].real, 'new-api/gpt-6-astra')
  assert.deepEqual(requests, [
    'https://gateway.example/v1/magpie/route?session=current-session',
  ])

  const second = await registered.resource(requestFor('other-session'))
  assert.equal((await second.json()).session, 'other-session')
  const firstAgain = await registered.resource(requestFor('current-session'))
  assert.equal((await firstAgain.json()).session, 'current-session')
  assert.deepEqual(requests.slice(1), [
    'https://gateway.example/v1/magpie/route?session=other-session',
    'https://gateway.example/v1/magpie/route?session=current-session',
  ])

  const missing = await registered.resource(requestFor(''))
  assert.equal((await missing.json()).kind, 'session-empty')
  assert.equal(requests.length, 3, 'missing session must not query the global trace')
})

test('describeError includes the active gateway address', () => {
  assert.match(
    describeError(new Error('connection refused'), 'http://gateway/'),
    /当前使用的网关地址是 http:\/\/gateway/,
  )
})
