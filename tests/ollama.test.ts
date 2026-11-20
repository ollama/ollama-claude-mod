import { expect, test } from 'claude-code/testing'
import type { EngineInterface, HttpInit } from 'claude-code'
import { discoverModels, getConnection, prepareRequest } from '../hooks/ollama'
import { CLOUD_CATALOG, cloudModels } from '../hooks/catalog'

type Sent = { url: string; init?: HttpInit }
function fixture(options: { host?: string; key?: string; capabilities?: string[]; efforts?: (string | boolean)[]; defaultEffort?: string | boolean } = {}) {
  const requests: Sent[] = []
  const engine = {
    store: { get: async () => options.host },
    env: { get: async (name: string) => name === 'OLLAMA_API_KEY' ? options.key : undefined },
    http: { fetch: async (url: string, init?: HttpInit) => {
      requests.push({ url, init })
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ capabilities: options.capabilities ?? ['tools'], thinking: { values: options.efforts ?? [], default: options.defaultEffort } }) }
    } },
  } as unknown as EngineInterface
  return { engine, requests }
}
const body = { model: 'claude-native', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'custom', input_schema: {} }] }

test('only the exact HTTPS Ollama cloud origin receives the configured API key', async () => {
  const cloud = fixture({ host: 'https://ollama.com:443', key: 'cloud-key' })
  expect(await getConnection(cloud.engine)).toEqual({ base: 'https://ollama.com', key: 'cloud-key' })
  for (const host of ['http://127.0.0.1:11434', 'https://ollama.com.example.org', 'http://ollama.com', 'https://ollama.com:444']) {
    const local = fixture({ host, key: 'cloud-key' })
    expect((await getConnection(local.engine)).key).toBe('')
  }
})

test('request preparation builds fresh headers and never copies native credentials', async () => {
  const f = fixture({ key: 'cloud-key' })
  const prepared = await prepareRequest(f.engine, body, 'model:cloud', undefined, { base: 'https://ollama.com', key: 'cloud-key' })
  expect(prepared.init.headers).toEqual({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer cloud-key' })
  expect(prepared.init.headers?.['x-api-key']).toBe(undefined)
  expect(prepared.init.auth).toBe(undefined)
  expect(JSON.parse(String(prepared.init.body)).model).toBe('model')
  expect(f.requests[0]?.init?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer cloud-key' })
  const custom = await prepareRequest(f.engine, body, 'model:cloud', undefined, { base: 'https://custom.example.org', key: 'must-not-send' })
  expect(custom.init.headers?.authorization).toBe(undefined)
  expect(custom.init.headers?.['x-api-key']).toBe(undefined)
})

test('non-tool and decision models are rejected before an inference request is prepared', async () => {
  for (const capabilities of [['completion'], ['tools', 'decision']]) {
    const f = fixture({ capabilities })
    let rejected = false
    try { await prepareRequest(f.engine, body, 'unsupported-model', undefined, { base: 'http://localhost:11434', key: '' }) }
    catch { rejected = true }
    expect(rejected).toBe(true)
    expect(f.requests.length).toBe(1)
    expect(f.requests[0]?.url).toBe('http://localhost:11434/api/show')
  }
})

for (const choice of [
  { selection: 'medium', inherited: 'enabled', thinking: undefined, effort: 'medium' },
  { selection: 'medium', inherited: 'disabled', thinking: undefined, effort: 'medium' },
  { selection: undefined, inherited: 'enabled', thinking: undefined, effort: undefined },
  { selection: 'max', inherited: 'disabled', thinking: undefined, effort: undefined },
  { selection: 'on', inherited: 'disabled', thinking: 'enabled', effort: undefined },
  { selection: 'off', inherited: 'enabled', thinking: 'disabled', effort: undefined },
] as const) {
  test(`Ollama ${choice.selection ?? 'Default'} replaces inherited thinking ${choice.inherited}`, async () => {
    const f = fixture({ efforts: ['low', 'medium', true, false] })
    const native = { ...body, thinking: { type: choice.inherited, budget_tokens: 4096 }, output_config: { effort: 'high' } }
    const original = structuredClone(native)
    const prepared = await prepareRequest(f.engine, native, 'model', choice.selection, { base: 'http://localhost:11434', key: '' })
    const sent = JSON.parse(String(prepared.init.body))
    expect(sent.thinking).toEqual(choice.thinking ? { type: choice.thinking } : undefined)
    expect(sent.output_config).toEqual(choice.effort ? { effort: choice.effort } : undefined)
    expect(native).toEqual(original)
  })
}

test('Ollama owns the implicit thinking default and only supported overrides go on the wire', async () => {
  const connection = { base: 'http://localhost:11434', key: '' }
  for (const [reported, expected] of [['high', 'high'], [false, 'off'], [true, 'on'], ['max', undefined], [undefined, undefined]] as const) {
    const f = fixture({ efforts: [false, true, 'high'], defaultEffort: reported })
    const request = await prepareRequest(f.engine, body, 'model', 'xhigh', connection)
    expect(request.effectiveEffort).toBe(expected)
    const sent = JSON.parse(String(request.init.body))
    expect(sent.thinking).toBeUndefined()
    expect(sent.output_config).toBeUndefined()
    const explicit = await prepareRequest(f.engine, body, 'model', 'off', connection)
    expect(explicit.effectiveEffort).toBe('off')
    expect(JSON.parse(String(explicit.init.body)).thinking).toEqual({ type: 'disabled' })
  }
})

test('discovery merges cloud models with local models and preserves catalog entries when metadata is unavailable', async () => {
  const requests: Sent[] = []
  const engine = { http: { fetch: async (url: string, init?: HttpInit) => {
    requests.push({ url, init })
    if (url === CLOUD_CATALOG) return { ok: true, text: JSON.stringify({ models: [
      { name: 'glm', capabilities: ['tools'] },
      { name: 'gemma:31b', capabilities: ['tools'] },
      { name: 'embed', capabilities: ['embedding'] },
      { name: 'decision', capabilities: ['tools', 'decision'] },
    ] }) }
    if (url.endsWith('/api/tags')) return { ok: true, text: JSON.stringify({ models: [{ name: 'local' }, { name: 'glm:cloud' }, { name: 'local-decision' }] }) }
    const model = JSON.parse(String(init?.body)).model
    if (model === 'gemma:31b-cloud') return { ok: false, text: '' }
    if (model === 'local-decision') return { ok: true, text: JSON.stringify({ capabilities: ['tools', 'decision'] }) }
    return { ok: true, text: JSON.stringify({ capabilities: ['tools'], thinking: { values: ['high'] }, model_info: { 'test.context_length': 32768 } }) }
  } } } as unknown as EngineInterface
  const { models, complete, connected } = await discoverModels(engine, { base: 'http://localhost:11434', key: '' })
  expect(complete).toBe(true)
  expect(connected).toBe(true)
  expect(models.map(model => model.name)).toEqual(['gemma:31b-cloud', 'glm:cloud', 'local'])
  expect(models[1]?.efforts).toEqual(['high'])
  expect(models[0]?.isCloud).toBe(true)
  expect(requests.find(request => request.url === CLOUD_CATALOG)?.init).toBeUndefined()
  expect(requests.filter(request => request.init?.body === JSON.stringify({ model: 'glm:cloud' })).length).toBe(1)
})

test('an unavailable cloud catalog leaves local discovery usable', async () => {
  const engine = { http: { fetch: async (url: string) => {
    if (url === CLOUD_CATALOG) throw new Error('offline')
    return { ok: true, text: JSON.stringify(url.endsWith('/api/tags') ? { models: [{ name: 'local' }] } : { capabilities: ['tools'] }) }
  } } } as unknown as EngineInterface
  const discovery = await discoverModels(engine, { base: 'http://localhost:11434', key: '' })
  expect(discovery.models.map(model => model.name)).toEqual(['local'])
  expect(discovery.complete).toBe(false)
  expect(discovery.connected).toBe(true)
  expect(cloudModels(JSON.stringify({ models: [{ name: 'gemma:31b-cloud', capabilities: ['tools'] }] }))[0]?.name).toBe('gemma:31b-cloud')
})
