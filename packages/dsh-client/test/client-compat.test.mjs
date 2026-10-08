/** Exercise the shipped browser factory against the DSH 0.2 Client services. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../package.json', import.meta.url))
const React = require('react')
const jsx = require('react/jsx-runtime')
const { renderToStaticMarkup } = require('react-dom/server')
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(value) {
      snapshot = value
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

function clientHarness({ navigationError, coreBaseUrl = '', nativeBaseUrl = '', refuseMirror = false } = {}) {
  let plugin
  let dictionaries
  let configuration = { configured: false, baseUrl: coreBaseUrl, hasToken: true }
  let credentialConfigured = true
  const registrations = []
  const effects = []
  const formRequests = []
  const credentialWrites = []
  const configurationWrites = []
  const formWrites = []
  const formClears = []
  const opened = []
  const timers = new Map()
  const catalog = createSnapshotStore({ byId: {} })
  const form = createSnapshotStore({ status: 'ready', writable: true, value: { baseUrl: nativeBaseUrl } })
  Object.assign(form, {
    async set(field, value) {
      formWrites.push([field, value])
      if (refuseMirror) return false
      form.setSnapshot({ ...form.getSnapshot(), value: { ...form.getSnapshot().value, [field]: value } })
      return true
    },
    async unset(field) {
      formClears.push(field)
      if (refuseMirror) return false
      const value = { ...form.getSnapshot().value }
      delete value[field]
      form.setSnapshot({ ...form.getSnapshot(), value })
      return true
    },
    setSnapshot: form.set,
  })
  const allowedSlots = new Set([
    'plugins.bundle.config', 'shell.overlay', 'sidebar.footer.action', 'conversation.session.header.utilities',
  ])
  const ctx = {
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    locale: {
      register(namespace, value) {
        assert.equal(namespace, 'jira-workbench')
        dictionaries = value
        return () => {}
      },
    },
    configForms: {
      get(namespace) {
        formRequests.push(namespace)
        return form
      },
    },
    sessions: { list: catalog },
    uiWorkspace: {
      openSession(id) {
        if (navigationError) throw navigationError
        opened.push(id)
      },
    },
    remote: {
      credentials: {
        async describe(refs) {
          assert.deepEqual(Array.from(refs), ['JIRA_WORKBENCH_TOKEN'])
          return { ok: true, value: { JIRA_WORKBENCH_TOKEN: { configured: credentialConfigured, writable: true } } }
        },
        async set(ref, value) {
          credentialWrites.push([ref, value])
          credentialConfigured = true
          return { ok: true, value: undefined }
        },
      },
    },
    slots: {
      inject(name, install) {
        assert.ok(allowedSlots.has(name), `DSH no longer declares ${name}`)
        return install()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  const primitives = Object.fromEntries([
    'IconChevronDownOutlineMedium', 'IconChecklistOutlineMedium', 'IconCloseOutlineMedium', 'IconEllipsisOutlineMedium', 'StateDot',
  ].map(name => [name, props => React.createElement('span', { ...props, 'data-icon': name })]))
  const modules = new Map([
    ['react', React], ['react/jsx-runtime', jsx],
    ['@deepseek-ai/dsh-client-store', { createSnapshotStore }],
    ['@deepseek-ai/dsh-client-ui-primitives', primitives],
  ])
  runInNewContext(bundle, {
    console, URL, URLSearchParams,
    fetch: async (url, options) => {
      assert.equal(url, '/jira-workbench/config')
      if (options?.method === 'PUT') {
        const input = JSON.parse(options.body)
        configurationWrites.push(input)
        configuration = { ...configuration, ...input }
      }
      return { ok: true, json: async () => ({ ok: true, configuration }) }
    },
    window: {
      setTimeout(callback, delay) {
        const id = Symbol('timeout')
        timers.set(id, { callback, delay })
        return id
      },
      clearTimeout(id) { timers.delete(id) },
      __ModuleLoader__: {
        load(registration) {
          assert.equal(registration.id, '@jira-workbench/dsh-client')
          plugin = registration.factory(specifier => {
            assert.ok(modules.has(specifier), `Unknown Client external: ${specifier}`)
            return modules.get(specifier)
          })
        },
      },
    },
  })
  for (const dependency of plugin.inject) {
    assert.ok(dependency.split('.').reduce((value, key) => value?.[key], ctx), `Missing Client service: ${dependency}`)
  }
  plugin.apply(ctx)
  const settings = registrations.find(({ options }) => options.name === 'plugins.bundle.config')
  const surface = registrations.find(({ options }) => options.name === 'shell.overlay')
  const face = settings.options.inject()
  const t = key => dictionaries.zh[key] ?? key
  const ready = new Promise(resolve => {
    if (!face.hooks.jiraConfigCard.getSnapshot().loading) return resolve()
    const unsubscribe = face.hooks.jiraConfigCard.subscribe(() => {
      if (face.hooks.jiraConfigCard.getSnapshot().loading) return
      unsubscribe()
      resolve()
    })
  })
  return {
    registrations, settings, face, formRequests, formWrites, formClears, credentialWrites, configurationWrites,
    catalog, opened, timers, ready,
    openSession: surface.options.inject().openSession,
    acceptNativeUrl(baseUrl) {
      form.setSnapshot({ ...form.getSnapshot(), value: { baseUrl } })
    },
    nativeSnapshot: () => form.getSnapshot(),
    render(view) {
      return renderToStaticMarkup(React.createElement(settings.component, {
        ...face, view, t,
        useJiraConfigCard: selector => selector(face.hooks.jiraConfigCard.getSnapshot()),
      }))
    },
    dispose() {
      for (const dispose of effects.reverse()) dispose?.()
      assert.equal(form.listeners.size, 0)
    },
  }
}

test('DSH 0.2 bundle registers its configuration and Session summary with current services', async () => {
  const harness = clientHarness()
  await harness.ready
  assert.deepEqual(harness.formRequests, ['jira-workbench'])
  assert.equal(harness.settings.options.key, '@jira-workbench/dsh')
  assert.equal(harness.registrations.length, 4)
  assert.equal(harness.face.hooks.jiraConfigCard.getSnapshot().tokenConfigured, true)
  harness.dispose()
})

test('Plugin summary contains only the description while page shows connection inputs immediately', async () => {
  const harness = clientHarness()
  await harness.ready
  const summary = harness.render('summary')
  const page = harness.render('page')
  assert.match(summary, /配置 Jira 连接/)
  assert.doesNotMatch(summary, /<input|<button/)
  assert.match(page, /id="jira-config-base-url"/)
  assert.match(page, /id="jira-config-token"/)
  assert.doesNotMatch(page, /Collapse:|Expand:/)
  harness.dispose()
})

test('Connection save writes credentials through Remote and mirrors accepted URL through ConfigForm', async () => {
  const harness = clientHarness()
  await harness.ready
  harness.face.edit('baseUrl', 'https://jira.example.test')
  harness.face.edit('token', 'test-only-token')
  const saved = new Promise(resolve => {
    const off = harness.face.hooks.jiraConfigCard.subscribe(() => {
      const state = harness.face.hooks.jiraConfigCard.getSnapshot()
      if (state.saving || state.dirty) return
      off()
      resolve()
    })
  })
  harness.face.save()
  await saved
  assert.deepEqual(harness.credentialWrites, [['JIRA_WORKBENCH_TOKEN', 'test-only-token']])
  assert.equal(harness.configurationWrites[0].baseUrl, 'https://jira.example.test')
  assert.deepEqual(harness.formWrites, [['baseUrl', 'https://jira.example.test']])
  harness.dispose()
})

test('Startup Core reads never rewrite an existing native connection value', async () => {
  for (const values of [
    { coreBaseUrl: '', nativeBaseUrl: 'https://native.example.test' },
    { coreBaseUrl: 'https://core.example.test', nativeBaseUrl: '' },
  ]) {
    const harness = clientHarness(values)
    await harness.ready
    assert.equal(harness.nativeSnapshot().value.baseUrl, values.nativeBaseUrl)
    assert.deepEqual(harness.formWrites, [])
    assert.deepEqual(harness.formClears, [])
    harness.dispose()
  }
})

test('Accepted native URL edits and clears are displayed without writing cached Core values back', async () => {
  const harness = clientHarness({ coreBaseUrl: 'https://cached.example.test' })
  await harness.ready
  harness.acceptNativeUrl('https://native.example.test')
  assert.equal(harness.face.hooks.jiraConfigCard.getSnapshot().baseUrlText, 'https://native.example.test')
  harness.acceptNativeUrl('')
  assert.equal(harness.face.hooks.jiraConfigCard.getSnapshot().baseUrlText, '')
  assert.deepEqual(harness.formWrites, [])
  assert.deepEqual(harness.formClears, [])
  harness.dispose()
})

test('A refused native mirror does not undo an accepted Workbench URL save', async () => {
  const harness = clientHarness({
    coreBaseUrl: 'https://old.example.test', nativeBaseUrl: 'https://old.example.test', refuseMirror: true,
  })
  await harness.ready
  harness.face.edit('baseUrl', 'https://saved.example.test')
  harness.face.save()
  await new Promise(resolve => setImmediate(resolve))
  const accepted = harness.face.hooks.jiraConfigCard.getSnapshot()
  assert.equal(accepted.baseUrlText, 'https://saved.example.test')
  assert.equal(accepted.failed, false)
  assert.equal(accepted.dirty, false)
  assert.equal(harness.nativeSnapshot().value.baseUrl, 'https://old.example.test')
  // A form refresh with the same old URL is not a new native edit.
  harness.acceptNativeUrl('https://old.example.test')
  assert.equal(harness.face.hooks.jiraConfigCard.getSnapshot().baseUrlText, 'https://saved.example.test')
  harness.face.editImageProcessing({ localOcrEnabled: false })
  harness.face.save()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.configurationWrites[1].baseUrl, 'https://saved.example.test')
  harness.dispose()
})

test('Saving other Workbench preferences keeps a URL accepted from native settings', async () => {
  const harness = clientHarness({ coreBaseUrl: 'https://cached.example.test' })
  await harness.ready
  harness.acceptNativeUrl('https://native.example.test')
  harness.face.editImageProcessing({ localOcrEnabled: false })
  harness.face.save()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.configurationWrites[0].baseUrl, 'https://native.example.test')
  assert.equal(harness.face.hooks.jiraConfigCard.getSnapshot().baseUrlText, 'https://native.example.test')
  harness.dispose()
})

test('Session navigation waits for catalog synchronization and releases its wait afterwards', async () => {
  const harness = clientHarness()
  const navigation = harness.openSession('new-session')
  assert.deepEqual(harness.opened, [])
  assert.equal(harness.catalog.listeners.size, 1)
  harness.catalog.set({ byId: { 'new-session': { id: 'new-session' } } })
  await navigation
  assert.deepEqual(harness.opened, ['new-session'])
  assert.equal(harness.catalog.listeners.size, 0)
  assert.equal(harness.timers.size, 0)
  await harness.openSession('new-session')
  assert.deepEqual(harness.opened, ['new-session', 'new-session'])
  harness.dispose()
})

test('A missing catalog row times out instead of leaving the panel waiting indefinitely', async () => {
  const harness = clientHarness()
  const navigation = harness.openSession('missing-session')
  const failed = assert.rejects(navigation, /会话列表尚未同步/)
  const timer = [...harness.timers.values()][0]
  assert.equal(timer.delay, 5_000)
  timer.callback()
  await failed
  assert.equal(harness.catalog.listeners.size, 0)
  assert.deepEqual(harness.opened, [])
  harness.dispose()
})

test('Workspace navigation errors reject the pending open and release its catalog subscription', async () => {
  const harness = clientHarness({ navigationError: new Error('Session navigation refused') })
  const navigation = harness.openSession('new-session')
  const failed = assert.rejects(navigation, /Session navigation refused/)
  harness.catalog.set({ byId: { 'new-session': { id: 'new-session' } } })
  await failed
  assert.equal(harness.catalog.listeners.size, 0)
  assert.equal(harness.timers.size, 0)
  await assert.rejects(harness.openSession('new-session'), /Session navigation refused/)
  harness.dispose()
})
