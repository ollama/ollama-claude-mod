import { expect, test } from 'claude-code/testing'
import type { ClassicHookInputs, EngineInterface, Settings } from 'claude-code'
import { isOllamaModel, modelSwitched, refreshModelCatalog, rememberNativeModel, resolveNativeModel } from '../hooks/models'
import { DEFAULT_PREFERENCES, loadPreferences, savePreference } from '../hooks/settings'
import type { OllamaModel, Preferences } from '../types'

const models: OllamaModel[] = [{ name: 'local-model', isCloud: false, isDecision: false, contextLength: 8192, efforts: [] }]
const rows = [{ model: 'local-model', label: 'Ollama · local-model', description: 'Local Ollama' }]
function config(catalog = rows): Settings {
  return { pluginConfigs: { 'ollama': { options: { modelCatalog: JSON.stringify(catalog) } } } }
}
function fixture(preferences: Preferences = { ...DEFAULT_PREFERENCES, full: 'local-model' }) {
  let id = 'model-chat'
  let current = 'claude-opus-4-8'
  let user = config()
  const values = new Map<string, unknown>([['preferences:model-chat', { version: 1, value: preferences }]])
  const configs: unknown[] = []
  const engine = {
    session: { id: async () => id, model: async () => current },
    env: { get: async () => undefined },
    store: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value) } },
    state: { get: async () => ({ value: { shape: 'view-v1', value: { models } }, version: 0 }) },
    settings: { read: async (args?: { source?: string }) => !args?.source || args.source === 'user' ? user : {} },
    config: { set: async (args: { key: string; value: string }) => { configs.push(args); user = config(JSON.parse(args.value)); return { value: args.value } } },
  } as unknown as EngineInterface
  return { engine, values, configs, select: (model: string) => { current = model }, move: (next: string) => { id = next }, user: (settings: Settings) => { user = settings } }
}
async function apply(f: ReturnType<typeof fixture>, e: ClassicHookInputs['PostModelSwitch']) {
  f.select(e.to_model)
  return modelSwitched(f.engine, e)
}
function switched(from: string, to: string, source: ClassicHookInputs['PostModelSwitch']['source'] = 'picker') {
  return { session_id: 'model-chat', from_model: from, to_model: to, requested_model: to, source } as ClassicHookInputs['PostModelSwitch']
}

test('discovery updates only the internal catalog and skips identical writes', async () => {
  const f = fixture()
  f.user({})
  await refreshModelCatalog(f.engine, [...models, { ...models[0]!, name: 'decider', isDecision: true }])
  expect(f.configs).toEqual([{ key: 'ollama.modelCatalog', value: JSON.stringify(rows) }])
  await refreshModelCatalog(f.engine, models)
  expect(f.configs.length).toBe(1)
})

test('partial discovery retains model identity until a complete catalog replaces it', async () => {
  const f = fixture()
  const incoming = [{ ...models[0]!, name: 'new-model' }]
  await refreshModelCatalog(f.engine, incoming, false)
  expect(await isOllamaModel(f.engine, 'new-model')).toBe(true)
  expect(f.configs).toEqual([{ key: 'ollama.modelCatalog', value: JSON.stringify([...rows, { ...rows[0]!, model: 'new-model', label: 'Ollama · new-model' }]) }])
  await refreshModelCatalog(f.engine, incoming, true)
  expect(f.configs.at(-1)).toEqual({ key: 'ollama.modelCatalog', value: JSON.stringify([{ ...rows[0]!, model: 'new-model', label: 'Ollama · new-model' }]) })
})

test('native picker selection enables Full; Claude preserves active Subagents and publishes it', async () => {
  const f = fixture()
  expect(await apply(f, switched('claude-opus-4-8', 'local-model'))).toMatchObject({ enabled: true, mode: 'full', full: 'local-model' })
  expect(await resolveNativeModel(f.engine, 'local-model')).toBe('claude-opus-4-8')
  await savePreference(f.engine, 'model-chat', 'mode', 'subagent')
  expect(await apply(f, switched('local-model', 'claude-sonnet-4-6'))).toMatchObject({ enabled: true, mode: 'subagent' })
  expect(f.values.get('preference-defaults-v1')).toMatchObject({ value: { enabled: true, mode: 'subagent' } })
  await savePreference(f.engine, 'model-chat', 'mode', 'full')
  expect(await apply(f, switched('local-model', 'claude-sonnet-4-6'))).toMatchObject({ enabled: false, mode: 'full' })
})

test('worker resolution and startup of an older chat cannot replace the main fallback', async () => {
  const f = fixture()
  await rememberNativeModel(f.engine, 'claude-opus-4-8')
  expect(await resolveNativeModel(f.engine, 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
  expect(await resolveNativeModel(f.engine, 'local-model')).toBe('claude-opus-4-8')
  f.move('older-chat')
  await loadPreferences(f.engine, 'older-chat', { ...DEFAULT_PREFERENCES, full: 'local-model' })
  await rememberNativeModel(f.engine, 'claude-sonnet-4-6')
  f.move('new-chat')
  await loadPreferences(f.engine, 'new-chat', { ...DEFAULT_PREFERENCES, full: 'local-model' })
  expect(await resolveNativeModel(f.engine, 'local-model')).toBe('claude-opus-4-8')
  expect(await isOllamaModel(f.engine, 'local-model')).toBe(true)
})

test('automatic and resume switches leave preference defaults unchanged', async () => {
  const f = fixture({ ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent', subagent: 'local-model' })
  const before = await loadPreferences(f.engine, 'model-chat')
  expect(await apply(f, switched('claude-opus-4-8', 'local-model', 'auto'))).toBeUndefined()
  expect(await apply(f, switched('local-model', 'claude-sonnet-4-6', 'resume'))).toBeUndefined()
  expect(await apply(f, { ...switched('claude-opus-4-8', 'local-model'), agent_id: 'worker' })).toBeUndefined()
  expect(await loadPreferences(f.engine, 'model-chat')).toEqual(before)
  expect(f.values.has('preference-defaults-v1')).toBe(false)
})

test('a delayed model switch cannot publish into a newly resumed chat', async () => {
  const f = fixture()
  const originalRead = f.engine.settings.read
  let release!: () => void
  let waiting!: () => void
  const reached = new Promise<void>(resolve => { waiting = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  let first = true
  f.engine.settings.read = (async (args?: { source?: 'user' | 'flag' | 'policy' | 'project' | 'local' }) => {
    if (first) { first = false; waiting(); await paused }
    return originalRead(args)
  }) as typeof originalRead
  const changing = apply(f, switched('claude-opus-4-8', 'local-model'))
  await reached
  f.move('resumed-chat')
  const resumed = { ...DEFAULT_PREFERENCES, enabled: false, full: 'different-model' }
  await loadPreferences(f.engine, 'resumed-chat', resumed)
  release()
  expect(await changing).toBeUndefined()
  expect(await loadPreferences(f.engine, 'resumed-chat')).toEqual(resumed)
  expect(f.values.has('native-model-v1:resumed-chat')).toBe(false)
  expect(f.values.has('native-model-v1:last')).toBe(false)
  expect(f.values.has('preference-defaults-v1')).toBe(false)
})

test('a delayed main event cannot replace a newer native choice', async () => {
  const f = fixture()
  f.select('claude-sonnet-4-6')
  expect(await modelSwitched(f.engine, switched('claude-opus-4-8', 'local-model'))).toBeUndefined()
  expect((await loadPreferences(f.engine, 'model-chat')).enabled).toBe(DEFAULT_PREFERENCES.enabled)
  expect(f.values.has('preference-defaults-v1')).toBe(false)
})

test('a missing optional host config row retains durable identity across reloads', async () => {
  const f = fixture()
  f.user({})
  f.engine.config.set = async () => { throw new Error('$.config.set: no /config row with key ollama.modelCatalog') }
  const remote = { ...models[0]!, name: 'new-cloud:cloud', isCloud: true }
  await refreshModelCatalog(f.engine, [remote])
  expect(await isOllamaModel(f.engine, remote.name)).toBe(true)
  expect(f.values.get('model-catalog-v1')).toMatchObject([{ model: remote.name }])
  await refreshModelCatalog(f.engine, [{ ...remote, name: 'second:cloud' }], false)
  expect(await isOllamaModel(f.engine, remote.name)).toBe(true)
})

test('catalog registration failures remain visible and discovery cache identifies native picker rows', async () => {
  const f = fixture()
  f.user({})
  f.engine.config.set = async () => { throw new Error('Configuration is read-only') }
  let failure = ''
  try { await refreshModelCatalog(f.engine, [{ ...models[0]!, name: 'new-cloud:cloud' }]) }
  catch (error) { failure = String(error) }
  expect(failure).toContain('Configuration is read-only')
  f.values.set(`model-discovery-v1:${encodeURIComponent('http://127.0.0.1:11434')}`, [{ ...models[0]!, name: 'cached:cloud', isCloud: true }])
  expect(await isOllamaModel(f.engine, 'cached:cloud')).toBe(true)
})

test('catalog identity aggregates multiple marketplace install IDs', async () => {
  const f = fixture()
  f.user({ pluginConfigs: {
    'ollama@first': { options: { modelCatalog: '[]' } },
    'ollama@second': { options: { modelCatalog: JSON.stringify([{ ...rows[0]!, model: 'second-catalog:cloud' }]) } },
  } })
  expect(await isOllamaModel(f.engine, 'second-catalog:cloud')).toBe(true)
})

test('a missing host row is not ignored without equivalent durable identity', async () => {
  const f = fixture()
  f.user({})
  f.engine.store.set = async () => undefined
  f.engine.config.set = async () => { throw new Error('$.config.set: no /config row with key ollama.modelCatalog') }
  let failure = ''
  try { await refreshModelCatalog(f.engine, [{ ...models[0]!, name: 'not-saved:cloud' }]) }
  catch (error) { failure = String(error) }
  expect(failure).toContain('no /config row')
  expect(await isOllamaModel(f.engine, 'not-saved:cloud')).toBe(false)
})
