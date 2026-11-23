import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// Exercise the actual client bundle's registration boundary. DSH's session
// renderer calls entry.inject(binding.key), then merges that face with the
// owner props (which are {} for composer.dock). No DOM or React rendering here.
async function registration(React, globals = {}) {
  let factory
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { factory = module.factory } } },
    fetch: (...args) => globalThis.fetch(...args),
    setTimeout,
    clearTimeout,
    setImmediate,
    ...globals,
  })
  const plugin = factory(name => {
    assert.equal(name, 'react')
    return React
  })
  let entry
  const ctx = {
    effect() {},
    slots: {
      inject(name, install) { install() },
      register(options, component) { entry = { options, component } },
    },
  }
  plugin.apply(ctx)
  return entry
}

function renderlessReact(cleanups) {
  return {
    createElement: (type, props) => ({ type, props }),
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('dock polls only the session bound by its scoped registration', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    return {
      ok: true,
      async json() {
        return { kind: 'session', routes: [{ asked: 'group/test', real: 'provider/model' }] }
      },
    }
  })
  const cleanups = []
  const { options, component } = await registration(renderlessReact(cleanups))
  assert.equal(typeof options.inject, 'function', 'bind session ID through DSH session-scoped entry injection')

  const renderScopedDock = async sessionId => {
    const dockElement = component(options.inject(sessionId))
    const rendered = dockElement.type(dockElement.props)
    await flush()
    cleanups.forEach(cleanup => cleanup())
    assert.equal(rendered.type, 'button')
  }

  await renderScopedDock('session-A')
  await renderScopedDock('session-B')
  assert.deepEqual(requests, [
    '/plugins/magpie-route/route?session=session-A',
    '/plugins/magpie-route/route?session=session-B',
  ])
})

test('a new route shortens the next poll to one second', async t => {
  const requests = []
  const bodies = [
    { kind: 'session-empty', routes: [], lastRequestAt: 0 },
    { kind: 'session', routes: [{ asked: 'group/test', real: 'provider/model' }], lastRequestAt: 111, pending: 0 },
    { kind: 'session', routes: [{ asked: 'group/test', real: 'provider/model' }], lastRequestAt: 111, pending: 1 },
  ]
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    const body = bodies[Math.min(requests.length - 1, bodies.length - 1)]
    return { ok: true, async json() { return body } }
  })
  const timers = []
  const cleanups = []
  const { options, component } = await registration(renderlessReact(cleanups), {
    setTimeout(fn, delay) {
      timers.push({ fn, delay })
      return timers.length
    },
    clearTimeout() {},
  })

  const dock = component(options.inject('session-A'))
  dock.type(dock.props)
  await flush()

  // The first paint answers at once; the next query parks on the Host.
  assert.equal(requests[0], '/plugins/magpie-route/route?session=session-A')
  assert.equal(timers.at(-1).delay, 1000)

  timers.shift().fn()
  await flush()
  assert.equal(requests[1], '/plugins/magpie-route/route?session=session-A&since=0&wait=1')

  // The Host reports a request the dock has not seen: poll fast from now on.
  assert.equal(timers.at(-1).delay, 1000)
  timers.shift().fn()
  await flush()
  assert.equal(requests[2], '/plugins/magpie-route/route?session=session-A&since=111')
  assert.equal(timers.at(-1).delay, 1000)

  cleanups.forEach(cleanup => cleanup())
})

test('an unreadable error body keeps the retry loop alive', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    return {
      ok: false,
      status: 400,
      // The web server answers refusals with an empty body, so `json()`
      // throws the opaque "Unexpected end of JSON input".
      async json() {
        throw new SyntaxError('Unexpected end of JSON input')
      },
    }
  })
  const timers = []
  const cleanups = []
  const { options, component } = await registration(renderlessReact(cleanups), {
    setTimeout(fn, delay) {
      timers.push({ fn, delay })
      return timers.length
    },
    clearTimeout() {},
  })

  const dock = component(options.inject('session-A'))
  assert.doesNotThrow(() => dock.type(dock.props))
  await flush()

  assert.equal(requests.length, 1)
  assert.equal(timers.at(-1).delay, 5000, 'retry instead of stopping on an unparseable body')

  timers.shift().fn()
  await flush()
  assert.equal(requests.length, 2, 'the loop keeps polling until the gateway answers')

  cleanups.forEach(cleanup => cleanup())
})
