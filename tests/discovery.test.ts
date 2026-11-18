import { expect, test } from 'claude-code/testing'
import type { EngineInterface, HttpInit, ProcessRunInit } from 'claude-code'
import { loadModels, syncNativePicker } from '../hooks/discovery'
import { CLOUD_CATALOG } from '../hooks/catalog'
import type { Discovery } from '../hooks/ollama'

function fixture(name: string) {
  const base = `http://${name}:11434`
  const values = new Map<string, unknown>([['connection-v1', base]])
  const requests: string[] = []
  const processes: { argv: readonly string[]; init?: ProcessRunInit }[] = []
  let now = 0
  let local = ['old-local']
  let cloud = ['old-remote']
  let offline = false
  let cloudOffline = false
  let failedModel = ''
  let entrypoint = 'cli'
  let exitCode = 0
  const engine = {
    plugin: { root: '/plugin with spaces' },
    clock: { now: async () => now },
    env: { get: async (key: string) => key === 'CLAUDE_CODE_ENTRYPOINT' ? entrypoint : undefined },
    store: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value) } },
    http: { fetch: async (url: string, init?: HttpInit) => {
      requests.push(url)
      if (offline || cloudOffline && url === CLOUD_CATALOG) throw new Error('offline')
      if (url === CLOUD_CATALOG) return { ok: true, text: JSON.stringify({ models: cloud.map(name => ({ name, capabilities: ['tools'] })) }) }
      if (url.endsWith('/api/tags')) return { ok: true, text: JSON.stringify({ models: local.map(name => ({ name })) }) }
      if (JSON.parse(String(init?.body)).model === failedModel) throw new Error('unavailable metadata')
      return { ok: true, text: JSON.stringify({ capabilities: ['tools'] }) }
    } },
    process: { run: async (argv: readonly string[], init?: ProcessRunInit) => {
      processes.push({ argv, init })
      return { exitCode, stdout: '', stderr: exitCode === 1 ? 'Existing modelPicker is malformed; left unchanged.' : exitCode === 75 ? 'Another picker setup is running (or its lock remains); settings left unchanged.' : '' }
    } },
  } as unknown as EngineInterface
  return {
    engine, values, requests, processes, connection: { base, key: '' },
    advance: (ms: number) => { now += ms },
    models: (names: string[], cloudNames = cloud) => { local = names; cloud = cloudNames },
    offline: (value: boolean) => { offline = value },
    cloudOffline: (value: boolean) => { cloudOffline = value },
    failModel: (name: string) => { failedModel = name },
    desktop: () => { entrypoint = 'claude-desktop' },
    exit: (code: number) => { exitCode = code },
  }
}

test('model discovery shares pending requests, caches for five minutes, and finds newly released models', async () => {
  const f = fixture('cached-discovery')
  const [first, concurrent] = await Promise.all([loadModels(f.engine, f.connection), loadModels(f.engine, f.connection)])
  expect(concurrent).toEqual(first)
  expect(f.requests.filter(url => url === CLOUD_CATALOG)).toHaveLength(1)
  const count = f.requests.length
  f.models(['new-local'], ['new-remote'])
  f.advance(299999)
  expect(await loadModels(f.engine, f.connection)).toEqual(first)
  expect(f.requests).toHaveLength(count)
  f.advance(1)
  const refreshed = await loadModels(f.engine, f.connection)
  expect(refreshed.models.map(model => model.name)).toEqual(['new-local', 'new-remote:cloud'])
  expect(refreshed.complete).toBe(true)
  f.models(['forced-local'], [])
  expect((await loadModels(f.engine, f.connection, true)).models.map(model => model.name)).toEqual(['forced-local'])
})

test('partial catalogs and failed metadata keep cached rows until a successful refresh', async () => {
  const f = fixture('partial-discovery')
  await loadModels(f.engine, f.connection)
  f.models(['new-local', 'old-local'])
  f.cloudOffline(true)
  f.failModel('old-local')
  const partial = await loadModels(f.engine, f.connection, true)
  expect(partial.complete).toBe(false)
  expect(partial.connected).toBe(true)
  expect(partial.models.map(model => model.name)).toEqual(['new-local', 'old-local', 'old-remote:cloud'])
  const requests = f.requests.length
  expect(await loadModels(f.engine, f.connection)).toEqual(partial)
  expect(f.requests).toHaveLength(requests)
  f.advance(30000)
  f.offline(true)
  const offline = await loadModels(f.engine, f.connection)
  expect(offline.models).toEqual(partial.models)
  expect(offline.connected).toBe(false)
  f.offline(false)
  f.cloudOffline(false)
  f.models(['new-local'], [])
  f.advance(30000)
  expect((await loadModels(f.engine, f.connection)).models.map(model => model.name)).toEqual(['new-local'])
})

test('an offline startup recovers saved discovery without borrowing another endpoint catalog', async () => {
  const f = fixture('saved-discovery')
  const saved = [{ name: 'saved-local', isCloud: false, isDecision: false, contextLength: 8192, efforts: [] }]
  f.values.set(`model-discovery-v1:${encodeURIComponent(f.connection.base)}`, saved)
  f.offline(true)
  expect((await loadModels(f.engine, f.connection)).models).toEqual(saved)
  const other = fixture('different-discovery')
  other.offline(true)
  expect((await loadModels(other.engine, other.connection)).models).toEqual([])
})

test('native sync passes the shared catalog over stdin and retries a busy installer quietly', async () => {
  const f = fixture('native-sync')
  const discovery = await loadModels(f.engine, f.connection)
  const requests = f.requests.length
  f.exit(75)
  await syncNativePicker(f.engine, f.connection, discovery)
  f.exit(0)
  await syncNativePicker(f.engine, f.connection, discovery)
  await syncNativePicker(f.engine, f.connection, discovery)
  expect(f.processes).toHaveLength(2)
  expect(f.processes[0]?.argv).toEqual(['node', '/plugin with spaces/scripts/model-picker.mjs', 'install', '--catalog-stdin'])
  expect(JSON.parse(f.processes[0]!.init!.stdin!)).toEqual({ models: discovery.models, complete: true })
  expect(f.requests).toHaveLength(requests)
  f.exit(1)
  let error = ''
  try { await syncNativePicker(f.engine, f.connection, { ...discovery, complete: false }) }
  catch (reason) { error = String(reason) }
  expect(error).toContain('modelPicker is malformed')
})

test('Desktop and superseded connections never launch the native CLI installer', async () => {
  const discovery: Discovery = { models: [], complete: true, connected: true }
  const desktop = fixture('desktop-sync')
  desktop.desktop()
  await syncNativePicker(desktop.engine, desktop.connection, discovery)
  expect(desktop.processes).toHaveLength(0)
  const stale = fixture('superseded-sync')
  stale.values.set('connection-v1', 'http://new-address:11434')
  await syncNativePicker(stale.engine, stale.connection, discovery)
  expect(stale.processes).toHaveLength(0)
})

test('a persistent installer conflict becomes actionable and can recover', async () => {
  const f = fixture('persistent-conflict')
  const discovery: Discovery = { models: [], complete: true, connected: true }
  f.exit(75)
  await syncNativePicker(f.engine, f.connection, discovery)
  await syncNativePicker(f.engine, f.connection, discovery)
  let error = ''
  try { await syncNativePicker(f.engine, f.connection, discovery) }
  catch (reason) { error = String(reason) }
  expect(error).toContain('lock remains')
  f.exit(0)
  await syncNativePicker(f.engine, f.connection, discovery)
  expect(f.processes).toHaveLength(4)
})
