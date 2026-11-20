import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// Exercise the actual client bundle's registration boundary. DSH's session
// renderer calls entry.inject(binding.key), then merges that face with the
// owner props (which are {} for composer.dock). No DOM or React rendering here.
async function registration(React) {
  let factory
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { factory = module.factory } } },
    fetch: (...args) => globalThis.fetch(...args),
    setTimeout,
    clearTimeout,
    setImmediate,
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
  const React = {
    createElement: (type, props) => ({ type, props }),
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  const { options, component } = await registration(React)
  assert.equal(typeof options.inject, 'function', 'bind session ID through DSH session-scoped entry injection')

  const renderScopedDock = async sessionId => {
    const dockElement = component(options.inject(sessionId))
    const rendered = dockElement.type(dockElement.props)
    await new Promise(resolve => setImmediate(resolve))
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
