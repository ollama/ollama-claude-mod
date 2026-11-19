import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Hook, TurnUsage } from 'claude-code'
import type { Preferences } from '../hooks/settings'
import { executionComplete, executionFetch, executionSpawn, executionStep } from '../hooks/execution'
import { readActivity, resetActivity } from '../hooks/activity'

// Direct hook fixtures exercise the local routing decisions. They do not claim
// to simulate native transport, permissions or the host's streaming reader.
type FetchInput = Parameters<Hook<'http.fetch'>>[1]
type FetchNext = Parameters<Hook<'http.fetch'>>[2]
const ok = { value: { status: 200, ok: true, headers: {}, text: '{}' } }
let sequence = 0
function fixture(mode: Preferences['mode'] = 'full', reporting = false) {
  const id = `execution-${++sequence}`
  let sessionId = id
  const preferences: Preferences = { enabled: true, mode, full: 'full-model', subagent: 'worker-model' }
  const stored = new Map<string, unknown>([[`preferences:${id}`, { version: 1, value: preferences }]])
  const states = new Map<string, { value: unknown; version: number }>()
  const engine = {
    session: { id: async () => sessionId, messages: async () => [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'previous reply' }] }] },
    store: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value) }, keys: async () => [...stored.keys()], delete: async (key: string) => { stored.delete(key) } },
    env: { get: async () => undefined },
    settings: { read: async () => ({}) },
    state: {
      get: async (ref: { key: string }) => states.get(ref.key) ?? { value: ref.key === 'view' ? { shape: 'view-v1', value: { preferences, models: [], connected: true, endpoint: '', settingsOpen: false, notice: '' } } : undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown) => {
        if (!reporting) throw new Error('Optional UI unavailable')
        const version = (states.get(ref.key)?.version ?? 0) + 1
        states.set(ref.key, { value, version })
        return { isSet: true, version }
      },
    },
    http: { fetch: async () => ({ status: 200, ok: true, text: JSON.stringify({ capabilities: ['tools'] }), headers: {} }) },
  } as unknown as EngineInterface
  const controller = new AbortController()
  const sent: FetchInput[] = []
  const transport = Object.assign(async (input: FetchInput) => { sent.push(input); return ok }, {
    signal: controller.signal, origin: { plugin: 'engine', tier: 'core' },
  }) as unknown as FetchNext
  const request = (model: string, agentId?: string): FetchInput => ({
    url: 'https://api.anthropic.com/v1/messages',
    init: { method: 'POST', headers: { authorization: 'native-secret', 'x-api-key': 'native-key', ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}) }, body: JSON.stringify({ model, system: [{ type: 'text', text: 'x-anthropic-billing-header: test' }], messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'custom', name: 'Read', input_schema: {} }] }) },
  })
  async function step(turnId: string, nativeModel: string, action: (model: string) => Promise<void>, agentId?: string, index = 0, usage?: TurnUsage) {
    const downstream = async function* (e: { model: string }) {
      await action(e.model)
      return { turnId, index, answer: 'done', toolUses: [], stopReason: 'end_turn' as const, usage }
    }
    const stream = executionStep(engine, { turnId, index, model: nativeModel, messageCount: 1, ...(agentId ? { agentId } : {}) }, downstream as unknown as Parameters<Hook<'turn.step'>>[2])
    for await (const _chunk of stream) { /* drain */ }
  }
  return { id, engine, preferences, stored, controller, sent, transport, request, step, setSessionId: (value: string) => { sessionId = value } }
}

test('Ollama totals combine completed main and subagent requests, include cached input, and exclude native fallback', async () => {
  const f = fixture('full', true)
  const usage = { model: 'full-model', input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 9 }
  await f.step(f.id, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) }, undefined, 0, usage)
  await f.step(f.id, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) }, undefined, 1,
    { ...usage, input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect((await readActivity(f.engine)).ollama).toEqual({ requests: 2, inputTokens: 215, outputTokens: 18 })

  f.preferences.mode = 'subagent'
  const agentId = `${f.id}-worker`
  await executionSpawn(f.engine, { parentModel: 'claude-native', prompt: 'Work', description: 'Work', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1],
    (async () => ({ agentId, model: 'claude-native' })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  await f.step(`${f.id}-child`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model, agentId), f.transport) }, agentId, 0,
    { ...usage, model: 'worker-model', input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 })
  await f.step(`${f.id}-native`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) }, undefined, 0, usage)

  f.preferences.mode = 'full'
  const fallback = Object.assign(async (e: FetchInput) => e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } },
    { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(`${f.id}-fallback`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), fallback) }, undefined, 0, usage)
  expect((await readActivity(f.engine)).ollama).toEqual({ requests: 3, inputTokens: 245, outputTokens: 27 })
  await resetActivity(f.engine, f.id)
  expect((await readActivity(f.engine)).ollama).toBeUndefined()
})

test('interrupted responses do not count as completed requests and missing usage never becomes a zero-token total', async () => {
  const f = fixture('full', true)
  const error = new Error('Interrupted stream')
  let caught: unknown
  try {
    await f.step(f.id, 'claude-native', async model => {
      await executionFetch(f.engine, f.request(model), f.transport)
      throw error
    })
  } catch (failure) { caught = failure }
  expect(caught).toBe(error)
  expect((await readActivity(f.engine)).ollama).toBeUndefined()
  await f.step(`${f.id}-missing`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  expect((await readActivity(f.engine)).ollama).toEqual({ requests: 1, inputTokens: undefined, outputTokens: undefined })
})

test('transport failure falls back once and remains native for the turn', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  const thinking = { type: 'enabled', budget_tokens: 4096 }
  const output_config = { effort: 'high' }
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init,
      body: JSON.stringify({ ...JSON.parse(String(request.init?.body)), thinking, output_config }),
    } }, next)
  })
  await f.step(f.id, 'claude-original', async model => { expect(model).toBe('claude-original') }, undefined, 1)
  await f.step(f.id, 'claude-native-fallback', async model => { expect(model).toBe('claude-native-fallback') }, undefined, 2)
  expect(f.sent.length).toBe(2)
  expect(JSON.parse(String(f.sent[1]?.init?.body)).model).toBe('claude-original')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).thinking).toBeUndefined()
  expect(JSON.parse(String(f.sent[0]?.init?.body)).output_config).toBeUndefined()
  expect(JSON.parse(String(f.sent[1]?.init?.body)).thinking).toEqual(thinking)
  expect(JSON.parse(String(f.sent[1]?.init?.body)).output_config).toEqual(output_config)
  expect(f.sent[0]?.init?.headers?.authorization).toBe(undefined)
  expect(f.sent[0]?.init?.headers?.['x-api-key']).toBe(undefined)
})

test('aborted transport never starts a native fallback', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); f.controller.abort(); throw new Error('aborted') }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  let failed = false
  try { await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), next) }) } catch { failed = true }
  expect(failed).toBe(true)
  expect(f.sent.length).toBe(1)
})

test('an accepted stream is returned once even when optional reporting fails', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); return { value: { ...ok.value, isStreaming: true as const } } }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), next) })
  expect(f.sent.length).toBe(1)
})

test('Subagents keeps main native and a worker snapshot survives parent completion', async () => {
  const f = fixture('subagent')
  await f.step(f.id, 'claude-main', async model => { expect(model).toBe('claude-main') })
  const spawn = { model: 'claude-worker', agentId: `${f.id}-worker` }
  await executionSpawn(f.engine, { model: 'claude-worker', parentModel: 'claude-main', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: 'tool', provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async () => spawn) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await executionComplete(f.engine, { turnId: f.id } as Parameters<Hook<'turn.complete'>>[1], (async () => ({})) as unknown as Parameters<Hook<'turn.complete'>>[2])
  await f.step(`${f.id}-child`, 'claude-worker', async model => { expect(model).toBe('worker-model') }, spawn.agentId)
})

for (const mode of ['full', 'subagent'] as const) {
  test(`${mode}: a completed Agent resumes on Ollama without rewriting its spawn`, async () => {
    const f = fixture(mode)
    const agentId = `${f.id}-resumed`
    const spawn = { parentModel: 'claude-native', prompt: 'Work', description: 'Work', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1]
    const start = (async () => ({ agentId, model: 'claude-native' })) as unknown as Parameters<Hook<'agent.spawn'>>[2]
    await executionSpawn(f.engine, spawn, start)
    await f.step(`${f.id}-first`, 'claude-native', async model => {
      expect(model).toBe('worker-model')
      await executionFetch(f.engine, f.request(model, agentId), f.transport)
    }, agentId)
    await executionComplete(f.engine, { agentId, turnId: `${f.id}-first`, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' },
      (async () => ({ text: 'done' })) as unknown as Parameters<Hook<'turn.complete'>>[2])
    const resume = { ...spawn, prompt: 'Continue', resume: { agentId } }
    let resumed: typeof spawn | undefined
    await executionSpawn(f.engine, resume, (async (e: typeof spawn) => {
      resumed = e
      return { agentId, model: 'claude-native' }
    }) as unknown as Parameters<Hook<'agent.spawn'>>[2])
    expect(resumed).toEqual(resume)
    await f.step(`${f.id}-resumed-turn`, 'claude-native', async model => {
      expect(model).toBe('worker-model')
      await executionFetch(f.engine, f.request(model, agentId), f.transport)
    }, agentId)
    expect(f.sent[1]?.url).toBe('http://127.0.0.1:11434/v1/messages')
  })
}

test('resuming an active worker retains its captured settings until completion', async () => {
  const f = fixture('subagent')
  const agentId = `${f.id}-active`
  const spawn = { parentModel: 'claude-native', prompt: 'Work', description: 'Work', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1]
  const start = (async () => ({ agentId, model: 'claude-native' })) as unknown as Parameters<Hook<'agent.spawn'>>[2]
  await executionSpawn(f.engine, spawn, start)
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await executionSpawn(f.engine, { ...spawn, resume: { agentId } }, start)
  await f.step(`${f.id}-active-turn`, 'claude-native', async model => { expect(model).toBe('worker-model') }, agentId)
  await executionComplete(f.engine, { agentId, turnId: `${f.id}-active-turn`, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' },
    (async () => ({ text: 'done' })) as unknown as Parameters<Hook<'turn.complete'>>[2])
  await executionSpawn(f.engine, { ...spawn, resume: { agentId } }, start)
  await f.step(`${f.id}-next-turn`, 'claude-native', async model => { expect(model).toBe('claude-native') }, agentId)
})

test('Off and Subagents Only preserve native model changes within the main turn', async () => {
  for (const enabled of [false, true]) {
    const f = fixture('subagent')
    f.preferences.enabled = enabled
    for (const [index, nativeModel] of ['claude-original', 'claude-native-fallback'].entries()) {
      await f.step(f.id, nativeModel, async model => {
        expect(model).toBe(nativeModel)
        await executionFetch(f.engine, f.request(model), f.transport)
      }, undefined, index)
      expect(f.sent[index]?.url).toBe('https://api.anthropic.com/v1/messages')
      expect(JSON.parse(String(f.sent[index]?.init?.body)).model).toBe(nativeModel)
    }
  }
})

test('classifier and internal helper requests remain native', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' } } }, f.transport)
  })
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('claude-original')
})

test('native web search omits empty domain lists and preserves real restrictions', async () => {
  for (const { domains, expected } of [
    { domains: { allowed_domains: [], blocked_domains: [] }, expected: {} },
    { domains: { allowed_domains: ['ollama.com'], blocked_domains: [] }, expected: { allowed_domains: ['ollama.com'] } },
    { domains: { allowed_domains: [], blocked_domains: ['example.com'] }, expected: { blocked_domains: ['example.com'] } },
  ]) {
    const f = fixture()
    const tool = { type: 'web_search_20250305', name: 'web_search', ...domains }
    const body = { model: 'claude-haiku', tools: [tool], messages: [{ role: 'user', content: 'search' }] }
    const request = f.request(body.model)
    // WebSearch's own request can run after the model step has ended.
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
    const sent = JSON.parse(String(f.sent[0]?.init?.body))
    expect(f.sent[0]?.url).toBe(request.url)
    expect(f.sent[0]?.init?.headers).toEqual(request.init?.headers)
    expect(sent.model).toBe(body.model)
    expect(sent.messages).toEqual(body.messages)
    expect(sent.tools).toEqual([{ type: tool.type, name: tool.name, ...expected }])
  }
})

test('preferences are captured for the turn and a new native model is captured next turn', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-original', async model => { expect(model).toBe('full-model') })
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, full: 'different-model' } })
  await f.step(f.id, 'claude-original', async model => { expect(model).toBe('full-model') }, undefined, 1)
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(`${f.id}-new`, 'claude-new-selection', async model => { await executionFetch(f.engine, f.request(model), next) })
  expect(JSON.parse(String(f.sent[1]?.init?.body)).model).toBe('claude-new-selection')
})

test('thread continuation without a saved beginning quietly falls back', async () => {
  const f = fixture()
  const agentId = `${f.id}-history-worker`
  await executionSpawn(f.engine, { model: 'claude-original', parentModel: 'claude-main', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: 'tool', provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async () => ({ model: 'claude-original', agentId })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model, agentId)
    const body = JSON.parse(String(request.init?.body))
    delete body.system
    body.thread = { type: 'continue' }
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
  }, agentId)
  expect(f.sent.length).toBe(1)
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('claude-original')
})

test('continued requests include the prior prompt and native assistant tool reply', async () => {
  const f = fixture()
  // A prior test may leave main history, so create begins a fresh history here.
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, f.transport)
  }, undefined, 1)
  expect(JSON.parse(String(f.sent[1]?.init?.body)).messages.length).toBe(3)
})

test('switching off cleans unsigned Ollama thinking in the native conversation', async () => {
  const f = fixture()
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    const body = JSON.parse(String(request.init?.body))
    body.messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'answer' }] })
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
  })
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).messages[1].content).toEqual([{ type: 'text', text: 'answer' }])
})

test('failed continuation falls back with the whole conversation and no Ollama thread', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, next)
  }, undefined, 1)
  const native = JSON.parse(String(f.sent[2]?.init?.body))
  expect(native.thread).toBe(undefined)
  expect(native.messages.length).toBe(3)
  expect(native.system.length).toBe(1)
})

test('a new chat never reuses another chat main-loop system and tools', async () => {
  const first = fixture()
  await first.step(first.id, 'claude-first', async model => { await executionFetch(first.engine, first.request(model), first.transport) })
  const second = fixture()
  await second.step(second.id, 'claude-second', async model => {
    const request = second.request(model)
    await executionFetch(second.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'new chat delta' }] }) } }, second.transport)
  })
  expect(second.sent.length).toBe(1)
  expect(second.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  const fallback = JSON.parse(String(second.sent[0]?.init?.body))
  expect(fallback.model).toBe('claude-second')
  expect(fallback.system).toBe(undefined)
  expect(fallback.tools).toBe(undefined)
  expect(fallback.messages).toEqual([{ role: 'user', content: 'new chat delta' }])
})


test('a prior chat background worker does not report into the newly selected chat', async () => {
  const f = fixture('subagent')
  const agentId = `${f.id}-background`
  await executionSpawn(f.engine, { model: 'claude-worker', parentModel: 'claude-main', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: 'tool', provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async () => ({ model: 'claude-worker', agentId })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  let reportAttempts = 0
  Object.defineProperty(f.engine, 'state', { get: () => { reportAttempts++; throw new Error('Optional UI unavailable') } })
  await f.step(`${f.id}-worker`, 'claude-worker', async () => {}, agentId)
  expect(reportAttempts > 0).toBe(true)
  reportAttempts = 0
  f.setSessionId(`${f.id}-new-chat`)
  await f.step(`${f.id}-worker`, 'claude-worker', async model => { expect(model).toBe('worker-model') }, agentId, 1)
  expect(reportAttempts).toBe(0)
})


test('a saved exact template restores Ollama after a reload loses memory history', async () => {
  const f = fixture()
  const system = [{ type: 'text', text: 'original system' }]
  const tools = [{ type: 'custom', name: 'Read', input_schema: {} }]
  f.stored.set(`request-template-v1:${JSON.stringify([f.id, 'main'])}`, { version: 1, system, tools })
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, f.transport)
  })
  expect(f.sent.length).toBe(1)
  expect(f.sent[0]?.url).toBe('http://127.0.0.1:11434/v1/messages')
  const sent = JSON.parse(String(f.sent[0]?.init?.body))
  expect(sent.system).toEqual(system)
  expect(sent.tools).toEqual(tools)
  expect(sent.messages.length).toBe(3)
  expect(sent.thread).toBe(undefined)
})

test('tool search updates the forwarded and cached tool definitions during continuation', async () => {
  for (const reloaded of [false, true]) {
    const f = fixture()
    const system = [{ type: 'text', text: 'original system' }]
    const tools = [{ name: 'ToolSearch', input_schema: { type: 'object' } }]
    const loaded = [...tools, { name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, defer_loading: true }]
    const reply = { role: 'assistant', content: [{ type: 'tool_use', id: 'search-1', name: 'ToolSearch', input: { query: 'select:WebSearch' } }] }
    const delta = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search-1', content: [{ type: 'tool_reference', tool_name: 'WebSearch' }] }] }]
    const key = `request-template-v1:${JSON.stringify([f.id, 'main'])}`
    if (reloaded) f.stored.set(key, { version: 1, system, tools })
    else await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, system: [{ type: 'text', text: 'x-anthropic-billing-header: test' }, ...system], tools, messages: [{ role: 'user', content: 'search' }] }) } }, f.transport)
    })
    f.engine.session.messages = (async () => [{ role: 'user', content: 'search' }, reply, ...delta]) as unknown as typeof f.engine.session.messages
    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, tools: loaded, messages: delta }) } }, f.transport)
    }, undefined, 1)
    const sent = JSON.parse(String(f.sent.at(-1)?.init?.body))
    expect(f.sent.at(-1)?.url).toBe('http://127.0.0.1:11434/v1/messages')
    expect(sent.tools).toEqual(loaded)
    expect(sent.messages.at(-1)).toEqual(delta[0])
    expect((f.stored.get(key) as { tools: unknown }).tools).toEqual(loaded)

    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'continue' }] }) } }, f.transport)
    }, undefined, 2)
    expect(JSON.parse(String(f.sent.at(-1)?.init?.body)).tools).toEqual(loaded)
  }
})

test('native full requests seed only system and tools for a later Ollama run', async () => {
  const f = fixture('subagent')
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    const body = JSON.parse(String(request.init?.body))
    body.thread = { type: 'create' }
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
  })
  const saved = f.stored.get(`request-template-v1:${JSON.stringify([f.id, 'main'])}`) as Record<string, unknown>
  expect(Object.keys(saved).sort()).toEqual(['system', 'tools', 'version'])
  expect(saved.messages).toBe(undefined)
  expect(saved.headers).toBe(undefined)
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, mode: 'full' } })
  await f.step(`${f.id}-full`, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, f.transport)
  })
  expect(f.sent[1]?.url).toBe('http://127.0.0.1:11434/v1/messages')
})

test('malformed or unavailable template storage falls back once without inventing history', async () => {
  for (const broken of ['malformed', 'unavailable']) {
    const f = fixture()
    const key = `request-template-v1:${JSON.stringify([f.id, 'main'])}`
    f.stored.set(key, { version: 1, system: [], tools: [], messages: [{ role: 'user', content: 'must not load' }] })
    if (broken === 'unavailable') {
      const get = f.engine.store.get
      f.engine.store.get = async key => { if (key.startsWith('request-template-v1:')) throw new Error('storage unavailable'); return get(key) }
    }
    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, f.transport)
    })
    expect(f.sent.length).toBe(1)
    expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(f.sent[0]?.init?.body)).system).toBe(undefined)
  }
})

test('a failed Ollama request seeds its exact template after native fallback succeeds', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), next) })
  const saved = f.stored.get(`request-template-v1:${JSON.stringify([f.id, 'main'])}`) as Record<string, unknown>
  expect(Object.keys(saved).sort()).toEqual(['system', 'tools', 'version'])
})


test('reload cache accepts realistic Desktop templates and bounds their UTF-8 bytes', async () => {
  for (const entry of [{ text: 's'.repeat(161_875), expectedHost: 'http://127.0.0.1:11434/v1/messages' }, { text: '€'.repeat(90_000), expectedHost: 'https://api.anthropic.com/v1/messages' }]) {
    const f = fixture()
    f.stored.set(`request-template-v1:${JSON.stringify([f.id, 'main'])}`, { version: 1, system: [{ type: 'text', text: entry.text }], tools: [] })
    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, f.transport)
    })
    expect(f.sent.length).toBe(1)
    expect(f.sent[0]?.url).toBe(entry.expectedHost)
  }
})


test('continued native user delta replaces a normalized pending tail without duplicating it', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  f.engine.session.messages = (async () => [
    { role: 'user', content: [{ type: 'text', text: 'earlier prompt' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'next prompt' }] },
  ]) as unknown as typeof f.engine.session.messages
  const decorated = { role: 'user', content: [{ type: 'text', text: 'next prompt', cache_control: { type: 'ephemeral' } }] }
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [decorated] }) } }, f.transport)
  }, undefined, 1)
  expect(f.sent[1]?.url).toBe('http://127.0.0.1:11434/v1/messages')
  const sent = JSON.parse(String(f.sent[1]?.init?.body))
  expect(sent.messages.length).toBe(3)
  expect(sent.messages[0]).toEqual({ role: 'user', content: 'hello' })
  expect(sent.messages[1].content[0].text).toBe('earlier reply')
  expect(sent.messages[2]).toEqual(decorated)
})


test('threaded tool results and new user input both survive normalized transcript reconstruction', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  const toolUse = { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/sample' } }
  const toolResult = { type: 'tool_result', tool_use_id: 'read-1', content: 'file contents' }
  const userText = { type: 'text', text: 'continue with that result' }
  f.engine.session.messages = (async () => [
    { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
    { role: 'assistant', content: [toolUse] },
    { role: 'user', content: [toolResult, userText] },
  ]) as unknown as typeof f.engine.session.messages
  const delta = [{ role: 'user', content: [toolResult] }, { role: 'user', content: [{ ...userText, cache_control: { type: 'ephemeral' } }] }]
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: delta }) } }, f.transport)
  }, undefined, 1)
  expect(f.sent[1]?.url).toBe('http://127.0.0.1:11434/v1/messages')
  const messages = JSON.parse(String(f.sent[1]?.init?.body)).messages
  expect(messages.length).toBe(4)
  expect(messages[1].content).toEqual([toolUse])
  expect(messages.slice(2)).toEqual(delta)
})


test('an accepted stream blocks same-step native retries but allows the next tool-loop step', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); return { value: { ...ok.value, isStreaming: true as const } } }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    await executionFetch(f.engine, request, next)
    const replay = await executionFetch(f.engine, request, next)
    expect('deny' in replay).toBe(true)
    const nativeReplay = await executionFetch(f.engine, f.request('claude-original'), next)
    expect('deny' in nativeReplay).toBe(true)
    expect(f.sent.length).toBe(1)
    const classifier = { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' } } }
    await executionFetch(f.engine, classifier, next)
    expect(f.sent.length).toBe(2)
    expect(f.sent[1]?.url).toBe('https://api.anthropic.com/v1/messages')
  })
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), next) }, undefined, 1)
  expect(f.sent.length).toBe(3)
  expect(f.sent[2]?.url).toBe('http://127.0.0.1:11434/v1/messages')
})


test('Off keeps native accepted-response retry behavior unchanged', async () => {
  const f = fixture()
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); return { value: { ...ok.value, isStreaming: true as const } } }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => {
    await executionFetch(f.engine, f.request(model), next)
    const retry = await executionFetch(f.engine, f.request(model), next)
    expect('deny' in retry).toBe(false)
  })
  expect(f.sent.length).toBe(2)
  expect(f.sent.every(request => request.url === 'https://api.anthropic.com/v1/messages')).toBe(true)
})


test('an Ollama native picker selection falls back to the saved native baseline on failure', async () => {
  const f = fixture()
  f.stored.set(`native-model-v1:${f.id}`, 'claude-saved')
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'full-model', async model => { await executionFetch(f.engine, f.request(model), next) })
  expect(f.sent.length).toBe(2)
  expect(JSON.parse(String(f.sent[1]?.init?.body)).model).toBe('claude-saved')
})

test('an explicit native worker model does not replace the owner or global native baseline', async () => {
  const f = fixture('subagent')
  f.stored.set(`native-model-v1:${f.id}`, 'claude-main')
  f.stored.set('native-model-v1:last', 'claude-main')
  const agentId = `${f.id}-explicit-worker`
  await executionSpawn(f.engine, { model: 'claude-worker', parentModel: 'claude-main', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: 'tool', provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async () => ({ model: 'claude-worker', agentId })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(`${f.id}-worker`, 'claude-worker', async model => { await executionFetch(f.engine, f.request(model, agentId), next) }, agentId)
  expect(JSON.parse(String(f.sent[1]?.init?.body)).model).toBe('claude-worker')
  expect(f.stored.get(`native-model-v1:${f.id}`)).toBe('claude-main')
  expect(f.stored.get('native-model-v1:last')).toBe('claude-main')
})

test('known auxiliary requests outside an active step restore the saved native model', async () => {
  const f = fixture()
  f.stored.set(`native-model-v1:${f.id}`, 'claude-saved')
  for (const marker of ['auto-mode-classifier-2026', 'claude-code-side-query']) {
    const request = f.request('full-model')
    await executionFetch(f.engine, { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': marker } } }, f.transport)
  }
  expect(f.sent.length).toBe(2)
  expect(f.sent.every(request => request.url === 'https://api.anthropic.com/v1/messages')).toBe(true)
  expect(f.sent.every(request => JSON.parse(String(request.init?.body)).model === 'claude-saved')).toBe(true)
  expect(f.sent[0]?.init?.headers?.authorization).toBe('native-secret')
  const unknown = f.request('full-model')
  await executionFetch(f.engine, unknown, f.transport)
  expect(f.sent[2]).toBe(unknown)
})

test('Off restores a known auxiliary Ollama selection to the native baseline', async () => {
  const f = fixture()
  f.stored.set(`native-model-v1:${f.id}`, 'claude-saved')
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await f.step(f.id, 'full-model', async model => {
    expect(model).toBe('claude-saved')
    const request = f.request('full-model')
    await executionFetch(f.engine, { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' } } }, f.transport)
  })
  expect(f.sent.length).toBe(1)
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('claude-saved')
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
})


test('an unknown native baseline never sends the default alias in HTTP fallback', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); return { value: { ...ok.value, status: 503, ok: false } } }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'full-model', async model => {
    const result = await executionFetch(f.engine, f.request(model), next)
    expect(result.deny?.includes('/model') === true).toBe(true)
  })
  expect(f.sent.length).toBe(1)
  expect(f.sent[0]?.url).toBe('http://127.0.0.1:11434/v1/messages')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('full-model')
  const request = f.request('full-model')
  const auxiliary = await executionFetch(f.engine, { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' } } }, next)
  expect(auxiliary.deny?.includes('/model') === true).toBe(true)
  expect(f.sent.length).toBe(1)
})

test('the first observed native main model is saved without changing native alias resolution', async () => {
  const f = fixture()
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await f.step(f.id, 'default', async model => {
    expect(model).toBe('default')
    await executionFetch(f.engine, f.request('claude-resolved'), f.transport)
  })
  expect(f.sent.length).toBe(1)
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  await f.step(`${f.id}-resolved`, 'claude-resolved', async model => { expect(model).toBe('claude-resolved') })
  expect(f.stored.get(`native-model-v1:${f.id}`)).toBe('claude-resolved')
  expect(f.stored.get('native-model-v1:last')).toBe('claude-resolved')
})


test('Subagents and Off keep native main and worker startup safe after an Ollama picker selection', async () => {
  for (const enabled of [true, false]) {
    const f = fixture('subagent')
    f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled } })
    f.stored.set('native-model-v1:last', 'claude-global')
    await f.step(f.id, 'full-model', async model => {
      expect(model).toBe('claude-global')
      await executionFetch(f.engine, f.request(model), f.transport)
    })
    expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('claude-global')
    const agentId = `${f.id}-worker`
    let startupModel = ''
    await executionSpawn(f.engine, { parentModel: 'full-model', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: 'tool', provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async (e: Parameters<Hook<'agent.spawn'>>[1]) => {
      startupModel = e.model ?? e.parentModel
      return { model: startupModel, agentId }
    }) as Parameters<Hook<'agent.spawn'>>[2])
    expect(startupModel).toBe('claude-global')
    await f.step(`${f.id}-worker`, startupModel, async model => {
      expect(model).toBe(enabled ? 'worker-model' : 'claude-global')
      await executionFetch(f.engine, f.request(model, agentId), f.transport)
    }, agentId)
    expect(f.sent[1]?.url).toBe(enabled ? 'http://127.0.0.1:11434/v1/messages' : 'https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(f.sent[1]?.init?.body)).model).toBe(enabled ? 'worker-model' : 'claude-global')
  }
})

test('returning from Full to a native model keeps prior Ollama history safe for Claude', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-old', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await f.step(`${f.id}-native`, 'claude-selected', async model => {
    expect(model).toBe('claude-selected')
    const request = f.request(model)
    const body = JSON.parse(String(request.init?.body))
    body.messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'unsigned' }, { type: 'text', text: 'prior answer' }] })
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
  })
  expect(f.sent[1]?.url).toBe('https://api.anthropic.com/v1/messages')
  const body = JSON.parse(String(f.sent[1]?.init?.body))
  expect(body.model).toBe('claude-selected')
  expect(body.messages[1].content).toEqual([{ type: 'text', text: 'prior answer' }])
})

test('Always sends the main request to Kimi and parallel native Haiku agents to DeepSeek', async () => {
  const f = fixture()
  const main = 'kimi-k3.1-pro:cloud'
  const worker = 'deepseek-v4.1-flash:cloud'
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, full: main, subagent: worker } })
  await f.step(f.id, 'claude-opus', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  const ids = [`${f.id}-haiku-a`, `${f.id}-haiku-b`]
  const spawned: string[] = []
  await Promise.all(ids.map(async agentId => {
    await executionSpawn(f.engine, { model: 'haiku', parentModel: 'claude-main', prompt: 'task', description: 'task', subagentType: 'general-purpose', tool_use_id: agentId, provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async (e: Parameters<Hook<'agent.spawn'>>[1]) => {
      spawned.push(e.model ?? '')
      return { model: 'claude-haiku-resolved', agentId }
    }) as Parameters<Hook<'agent.spawn'>>[2])
  }))
  expect(spawned).toEqual(['haiku', 'haiku'])
  await Promise.all(ids.map(agentId => f.step(`${agentId}-turn`, 'claude-haiku-resolved', async model => {
    expect(model).toBe(worker)
    await executionFetch(f.engine, f.request(model, agentId), f.transport)
  }, agentId)))
  expect(f.sent.every(request => request.url === 'http://127.0.0.1:11434/v1/messages')).toBe(true)
  expect(f.sent.map(request => JSON.parse(String(request.init?.body)).model)).toEqual([main, worker, worker])
})


test('parallel workers keep their model through tool-result and inline-system continuations', async () => {
  const f = fixture('subagent')
  const ids = [`${f.id}-system-a`, `${f.id}-system-b`]
  const replies = new Map<string, object>()
  f.engine.session.messages = (async (args: { agentId?: string }) => [
    { role: 'user', content: [{ type: 'text', text: 'normalized initial prompt' }] },
    replies.get(args.agentId ?? ''),
    { role: 'user', content: [{ type: 'text', text: 'normalized pending results' }] },
  ]) as unknown as typeof f.engine.session.messages
  await Promise.all(ids.map(async agentId => {
    await executionSpawn(f.engine, { model: 'claude-worker', parentModel: 'claude-main', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: agentId, provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async () => ({ model: 'claude-worker', agentId })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
    const inline = { role: 'system', content: [{ type: 'text', text: `initial context ${agentId}` }] }
    await f.step(`${agentId}-turn`, 'claude-worker', async model => {
      const request = f.request(model, agentId)
      const body = JSON.parse(String(request.init?.body))
      body.messages.push(inline)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
    }, agentId)
    for (let index = 1; index <= 2; index++) {
      const callIds = [`${agentId}-${index}-read-a`, `${agentId}-${index}-read-b`]
      replies.set(agentId, { role: 'assistant', content: callIds.map(id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/sample' } })) })
      const delta = [
        { role: 'user', content: callIds.map(tool_use_id => ({ type: 'tool_result', tool_use_id, content: 'read output' })) },
        { role: 'system', content: [{ type: 'text', text: `native reminder ${index}` }] },
      ]
      await f.step(`${agentId}-turn`, 'claude-worker', async model => {
        expect(model).toBe('worker-model')
        const request = f.request(model, agentId)
        await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: delta }) } }, f.transport)
      }, agentId, index)
      // Ollama requests intentionally have no native headers; inspect the
      // body by the unique initial system context instead.
      const own = f.sent.map(request => JSON.parse(String(request.init?.body))).filter(body => body.messages?.some((message: { role: string; content: unknown }) => JSON.stringify(message) === JSON.stringify(inline))).at(-1)
      expect(own.messages[1]).toEqual(inline)
      expect(own.messages.slice(-2)).toEqual(delta)
      expect(own.messages.filter((message: { role: string }) => message.role === 'assistant').length).toBe(index)
    }
  }))
  expect(f.sent.length).toBe(6)
  expect(f.sent.every(request => request.url === 'http://127.0.0.1:11434/v1/messages')).toBe(true)
  expect(f.sent.every(request => JSON.parse(String(request.init?.body)).model === 'worker-model')).toBe(true)
})
