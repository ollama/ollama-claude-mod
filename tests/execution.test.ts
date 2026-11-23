import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Hook, TurnUsage } from 'claude-code'
import type { Preferences } from '../hooks/settings'
import { executionComplete, executionFetch, executionSpawn, executionStep } from '../hooks/execution'
import { readView, updateView } from '../hooks/runtime'
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
  const preferences: Preferences = { enabled: true, mode, model: 'ollama-model' }
  const stored = new Map<string, unknown>([[`preferences:${id}`, { version: 1, value: preferences }]])
  const states = new Map<string, { value: unknown; version: number }>()
  const logs: { text: string; to: string }[] = []
  const engine = {
    ui: { log: (text: string, options?: { to?: string }) => logs.push({ text, to: options?.to ?? 'transcript' }) },
    session: { id: async () => sessionId, messages: async () => [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'previous reply' }] }] },
    store: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value) }, keys: async () => [...stored.keys()], delete: async (key: string) => { stored.delete(key) } },
    env: { get: async () => undefined },
    settings: { read: async () => ({}) },
    state: {
      get: async (ref: { key: string }) => states.get(ref.key) ?? { value: ref.key === 'view' ? { shape: 'view-v2', value: { preferences, models: [], connected: true, endpoint: '', settingsOpen: false, notice: '' } } : undefined, version: 0 },
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
      yield { kind: 'text', index: 0, text: 'done' }
      return { turnId, index, answer: 'done', toolUses: [], stopReason: 'end_turn' as const, usage }
    }
    const stream = executionStep(engine, { turnId, index, model: nativeModel, messageCount: 1, ...(agentId ? { agentId } : {}) }, downstream as unknown as Parameters<Hook<'turn.step'>>[2])
    for await (const _chunk of stream) { /* drain */ }
  }
  return { id, engine, preferences, stored, controller, sent, transport, request, step, logs, setSessionId: (value: string) => { sessionId = value } }
}

test('Ollama totals combine completed main and subagent requests, include cached input, and exclude native fallback', async () => {
  const f = fixture('full', true)
  const usage = { model: 'ollama-model', input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 9 }
  await f.step(f.id, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) }, undefined, 0, usage)
  await f.step(f.id, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) }, undefined, 1,
    { ...usage, input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect((await readActivity(f.engine)).ollama).toEqual({ requests: 2, inputTokens: 215, outputTokens: 18 })

  f.preferences.mode = 'subagent'
  const agentId = `${f.id}-worker`
  await executionSpawn(f.engine, { parentModel: 'claude-native', prompt: 'Work', description: 'Work', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1],
    (async () => ({ agentId, model: 'claude-native' })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  await f.step(`${f.id}-child`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model, agentId), f.transport) }, agentId, 0,
    { ...usage, model: 'ollama-model', input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 })
  await f.step(`${f.id}-native`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), f.transport) }, undefined, 0, usage)

  f.preferences.mode = 'full'
  const fallback = Object.assign(async (e: FetchInput) => e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } },
    { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(`${f.id}-fallback`, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), fallback) }, undefined, 0, usage)
  expect((await readActivity(f.engine)).ollama).toEqual({ requests: 3, inputTokens: 245, outputTokens: 27 })
  await resetActivity(f.engine, f.id)
  expect((await readActivity(f.engine)).ollama).toBeUndefined()
})

test('routed main activity uses the Ollama model default even when Claude requests a different effort', async () => {
  const f = fixture('full', true)
  f.engine.http.fetch = async () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ capabilities: ['tools'], thinking: { values: ['low', 'max'], default: 'max' } }) })
  const turnId = f.id
  const next = async function* (e: { model: string }) {
    await executionFetch(f.engine, f.request(e.model), f.transport)
    yield { kind: 'text', index: 0, text: 'done' }
    return { turnId, index: 0, answer: 'done', toolUses: [], stopReason: 'end_turn' }
  }
  const stream = executionStep(f.engine, { turnId, index: 0, model: 'claude-native', effort: 'medium', messageCount: 1 }, next as unknown as Parameters<Hook<'turn.step'>>[2])
  for await (const _chunk of stream) { /* drain */ }
  expect((await readActivity(f.engine)).main?.effort).toBe('max')
})

test('a thinking-only Ollama response counts its reported output once in both tok/s and chat totals', async () => {
  const f = fixture('full', true)
  let now = 0
  const engine = { ...f.engine, clock: { ...f.engine.clock, now: async () => now } }
  const turnId = f.id
  const usage: TurnUsage = { model: 'ollama-model', input_tokens: 42, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const next = async function* (e: { model: string }) {
    await executionFetch(engine, f.request(e.model), f.transport)
    now = 10000
    yield { kind: 'engine', ref: 1 }
    yield { kind: 'text', index: 0, text: '' }
    now += 3000
    yield { kind: 'thinking', index: 0, text: 'Working it out' }
    now += 2000
    yield { kind: 'stop', stopReason: 'max_tokens', usage }
    return { turnId, index: 0, answer: '', toolUses: [], stopReason: 'max_tokens', usage }
  }
  const stream = executionStep(engine, { turnId, index: 0, model: 'claude-native', messageCount: 1 }, next as unknown as Parameters<Hook<'turn.step'>>[2])
  for await (const _chunk of stream) { /* drain */ }
  const activity = await readActivity(engine)
  expect(activity.main).toMatchObject({ tokens: 16, tokensPerSecond: 8 })
  expect(activity.ollama).toEqual({ requests: 1, inputTokens: 42, outputTokens: 16 })
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

test('HTTP failures stop routed requests, retain Ollama selection, and never replay on Claude', async () => {
  for (const status of [429, 503]) {
    const f = fixture()
    const next = Object.assign(async (e: FetchInput) => {
      f.sent.push(e)
      return { value: { ...ok.value, status, ok: false, text: 'secret response body' } }
    }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
    await f.step(f.id, 'claude-original', async model => {
      const result = await executionFetch(f.engine, f.request(model), next)
      expect(result.deny?.includes(`HTTP ${status}`)).toBe(true)
      expect(result.deny?.includes('/model')).toBe(true)
      const retry = await executionFetch(f.engine, f.request('claude-original'), next)
      expect(retry).toEqual(result)
    })
    await f.step(f.id, 'claude-original', async model => {
      expect(model).toBe('ollama-model')
      expect((await executionFetch(f.engine, f.request(model), next)).deny?.includes('/model')).toBe(true)
    }, undefined, 1)
    expect(f.sent.length).toBe(1)
    expect(f.sent[0]?.url).toBe('http://127.0.0.1:11434/v1/messages')
    expect(f.sent[0]?.init?.headers?.authorization).toBe(undefined)
    expect(f.sent[0]?.init?.headers?.['x-api-key']).toBe(undefined)
    // A fresh turn captures an explicit model change without inheriting failure.
    f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
    await f.step(`${f.id}-changed`, 'claude-new', async model => {
      expect(model).toBe('claude-new')
      await executionFetch(f.engine, f.request(model), f.transport)
    })
    expect(f.sent[1]?.url).toBe('https://api.anthropic.com/v1/messages')
  }
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
  await f.step(`${f.id}-child`, 'claude-worker', async model => { expect(model).toBe('ollama-model') }, spawn.agentId)
})

for (const mode of ['full', 'subagent'] as const) {
  test(`${mode}: a completed Agent resumes on Ollama without rewriting its spawn`, async () => {
    const f = fixture(mode)
    const agentId = `${f.id}-resumed`
    const spawn = { parentModel: 'claude-native', prompt: 'Work', description: 'Work', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1]
    const start = (async () => ({ agentId, model: 'claude-native' })) as unknown as Parameters<Hook<'agent.spawn'>>[2]
    await executionSpawn(f.engine, spawn, start)
    await f.step(`${f.id}-first`, 'claude-native', async model => {
      expect(model).toBe('ollama-model')
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
      expect(model).toBe('ollama-model')
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
  await f.step(`${f.id}-active-turn`, 'claude-native', async model => { expect(model).toBe('ollama-model') }, agentId)
  await executionComplete(f.engine, { agentId, turnId: `${f.id}-active-turn`, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' },
    (async () => ({ text: 'done' })) as unknown as Parameters<Hook<'turn.complete'>>[2])
  await executionSpawn(f.engine, { ...spawn, resume: { agentId } }, start)
  await f.step(`${f.id}-next-turn`, 'claude-native', async model => { expect(model).toBe('claude-native') }, agentId)
})

test('Off and Subagents preserve native model changes within the main turn', async () => {
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

test('a conversation with a different model stops before either provider receives it', async () => {
  const f = fixture()
  await f.step(f.id, 'claude-original', async model => {
    const mismatch = await executionFetch(f.engine, f.request('claude-original'), f.transport)
    expect(mismatch.deny?.includes('did not match')).toBe(true)
    const retry = await executionFetch(f.engine, f.request(model), f.transport)
    expect(retry.deny).toEqual(mismatch.deny)
  })
  expect(f.sent).toEqual([])
})

test('classifier requests stay native and omit thinking-only Ollama replies', async () => {
  const f = fixture()
  const followUp = { role: 'user', content: 'try again' }
  await f.step(f.id, 'claude-original', async model => {
    for (const requested of [model, 'claude-classifier']) {
      const request = f.request(requested)
      const body = JSON.parse(String(request.init?.body))
      body.messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'unfinished' }] }, followUp)
      const headers = { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' }
      await executionFetch(f.engine, { ...request, init: { ...request.init, headers, body: JSON.stringify(body) } }, f.transport)
    }
  })
  const bodies = f.sent.map(request => JSON.parse(String(request.init?.body)))
  expect(bodies.map(body => body.model)).toEqual(['claude-original', 'claude-classifier'])
  for (const [index, request] of f.sent.entries()) {
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(bodies[index].messages).toEqual([{ role: 'user', content: 'hello' }, followUp])
  }
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
  await f.step(f.id, 'claude-original', async model => { expect(model).toBe('ollama-model') })
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, model: 'different-model' } })
  await f.step(f.id, 'claude-original', async model => { expect(model).toBe('ollama-model') }, undefined, 1)
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(`${f.id}-new`, 'claude-new-selection', async model => { await executionFetch(f.engine, f.request(model), next) })
  expect(f.sent.length).toBe(1)
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('different-model')
})

test('thread continuation without a saved beginning stops before sending', async () => {
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
  expect(f.sent.length).toBe(0)
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

test('switching off drops thinking-only Ollama replies from the native conversation', async () => {
  const f = fixture()
  const followUp = { role: 'user', content: 'continue' }
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await f.step(f.id, 'claude-original', async model => {
    const request = f.request(model)
    const body = JSON.parse(String(request.init?.body))
    body.messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'unfinished' }] }, followUp)
    await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, f.transport)
  })
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).messages).toEqual([{ role: 'user', content: 'hello' }, followUp])
})

test('failed continuation is sent once to Ollama with the whole conversation', async () => {
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
  expect(f.sent.length).toBe(2)
  const native = JSON.parse(String(f.sent[1]?.init?.body))
  expect(native.thread).toBe(undefined)
  expect(native.messages.length).toBe(3)
  expect(native.system).toEqual([])
})

test('a new chat never reuses another chat main-loop system and tools', async () => {
  const first = fixture()
  await first.step(first.id, 'claude-first', async model => { await executionFetch(first.engine, first.request(model), first.transport) })
  const second = fixture()
  await second.step(second.id, 'claude-second', async model => {
    const request = second.request(model)
    await executionFetch(second.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'new chat delta' }] }) } }, second.transport)
  })
  expect(second.sent.length).toBe(0)
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
  await f.step(`${f.id}-worker`, 'claude-worker', async model => { expect(model).toBe('ollama-model') }, agentId, 1)
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

test('malformed or unavailable template storage stops without inventing history', async () => {
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
    expect(f.sent.length).toBe(0)
  }
})

test('a failed Ollama request does not seed a successful template', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), next) })
  expect(f.stored.get(`request-template-v1:${JSON.stringify([f.id, 'main'])}`)).toBe(undefined)
  expect(f.sent.length).toBe(1)
})


test('reload cache accepts realistic Desktop templates and bounds their UTF-8 bytes', async () => {
  for (const entry of [{ text: 's'.repeat(161_875), expectedHost: 'http://127.0.0.1:11434/v1/messages' }, { text: '€'.repeat(90_000), expectedHost: undefined }]) {
    const f = fixture()
    f.stored.set(`request-template-v1:${JSON.stringify([f.id, 'main'])}`, { version: 1, system: [{ type: 'text', text: entry.text }], tools: [] })
    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify({ model, thread: { type: 'continue' }, messages: [{ role: 'user', content: 'next' }] }) } }, f.transport)
    })
    expect(f.sent.length).toBe(entry.expectedHost ? 1 : 0)
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
    const suggestion = { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'x-claude-1p-request-class': 'followup-generation' } } }
    await executionFetch(f.engine, suggestion, next)
    expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    await executionFetch(f.engine, request, next)
    expect(f.sent[1]?.url).toBe('http://127.0.0.1:11434/v1/messages')
    const replay = await executionFetch(f.engine, request, next)
    expect('deny' in replay).toBe(true)
    const nativeReplay = await executionFetch(f.engine, f.request('claude-original'), next)
    expect('deny' in nativeReplay).toBe(true)
    expect(f.sent.length).toBe(2)
    const classifier = { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' } } }
    await executionFetch(f.engine, classifier, next)
    expect(f.sent.length).toBe(3)
    expect(f.sent[2]?.url).toBe('https://api.anthropic.com/v1/messages')
  })
  await f.step(f.id, 'claude-original', async model => { await executionFetch(f.engine, f.request(model), next) }, undefined, 1)
  expect(f.sent.length).toBe(4)
  expect(f.sent[3]?.url).toBe('http://127.0.0.1:11434/v1/messages')
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


test('an Ollama native picker selection is not replayed on its saved native baseline', async () => {
  const f = fixture()
  f.stored.set(`native-model-v1:${f.id}`, 'claude-saved')
  const next = Object.assign(async (e: FetchInput) => {
    f.sent.push(e)
    return e.url.startsWith('https://api.anthropic.com') ? ok : { value: { ...ok.value, status: 503, ok: false } }
  }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'ollama-model', async model => { await executionFetch(f.engine, f.request(model), next) })
  expect(f.sent.length).toBe(1)
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('ollama-model')
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
  expect(f.sent.length).toBe(1)
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('ollama-model')
  expect(f.stored.get(`native-model-v1:${f.id}`)).toBe('claude-main')
  expect(f.stored.get('native-model-v1:last')).toBe('claude-main')
})

test('native side requests can inherit the Ollama model after a completed turn', async () => {
  const f = fixture('full', true)
  await f.step(f.id, 'claude-saved', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  await executionComplete(f.engine, { turnId: f.id, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' },
    (async () => ({})) as unknown as Parameters<Hook<'turn.complete'>>[2])

  const markers: Record<string, string>[] = [
    { 'anthropic-beta': 'auto-mode-classifier-2026' },
    { 'anthropic-beta': 'claude-code-side-query' },
    { 'X-Claude-Code-Request-Class': 'auxiliary' },
    { 'x-claude-1p-request-class': 'followup-generation' },
    { 'x-claude-1p-request-class': 'summary-extraction' },
  ]
  for (const marker of markers) {
    const request = f.request('ollama-model')
    const result = await executionFetch(f.engine, { ...request, init: { ...request.init, headers: { ...request.init?.headers, ...marker } } }, f.transport)
    expect(result.deny).toBeUndefined()
  }
  const sideRequests = f.sent.slice(1)
  expect(sideRequests.length).toBe(markers.length)
  for (const request of sideRequests) {
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(request.init?.body)).model).toBe('claude-saved')
    expect(request.init?.headers?.authorization).toBe('native-secret')
  }
  expect(f.logs.filter(log => log.to === 'transcript')).toEqual([])
})

test('an untracked Ollama request is denied without reporting a failed chat turn', async () => {
  const f = fixture('full', true)
  const result = await executionFetch(f.engine, f.request('ollama-model'), f.transport)
  expect(result.deny).toBeDefined()
  expect(f.sent.length).toBe(0)
  expect(f.logs.filter(log => log.to === 'transcript')).toEqual([])
})

test('Off restores a known auxiliary Ollama selection to the native baseline', async () => {
  const f = fixture()
  f.stored.set(`native-model-v1:${f.id}`, 'claude-saved')
  f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, enabled: false } })
  await f.step(f.id, 'ollama-model', async model => {
    expect(model).toBe('claude-saved')
    const request = f.request('ollama-model')
    await executionFetch(f.engine, { ...request, init: { ...request.init, headers: { ...request.init?.headers, 'anthropic-beta': 'auto-mode-classifier-2026' } } }, f.transport)
  })
  expect(f.sent.length).toBe(1)
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('claude-saved')
  expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
})


test('an unknown native baseline never sends the default alias in HTTP fallback', async () => {
  const f = fixture()
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); return { value: { ...ok.value, status: 503, ok: false } } }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'ollama-model', async model => {
    const result = await executionFetch(f.engine, f.request(model), next)
    expect(result.deny?.includes('/model') === true).toBe(true)
  })
  expect(f.sent.length).toBe(1)
  expect(f.sent[0]?.url).toBe('http://127.0.0.1:11434/v1/messages')
  expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('ollama-model')
  const request = f.request('ollama-model')
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
    await f.step(f.id, 'ollama-model', async model => {
      expect(model).toBe('claude-global')
      await executionFetch(f.engine, f.request(model), f.transport)
    })
    expect(f.sent[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(f.sent[0]?.init?.body)).model).toBe('claude-global')
    const agentId = `${f.id}-worker`
    let startupModel = ''
    await executionSpawn(f.engine, { parentModel: 'ollama-model', prompt: 'task', description: 'task', subagentType: 'Explore', tool_use_id: 'tool', provider: { plugin: 'engine', tier: 'core' } } as Parameters<Hook<'agent.spawn'>>[1], (async (e: Parameters<Hook<'agent.spawn'>>[1]) => {
      startupModel = e.model ?? e.parentModel
      return { model: startupModel, agentId }
    }) as Parameters<Hook<'agent.spawn'>>[2])
    expect(startupModel).toBe('claude-global')
    await f.step(`${f.id}-worker`, startupModel, async model => {
      expect(model).toBe(enabled ? 'ollama-model' : 'claude-global')
      await executionFetch(f.engine, f.request(model, agentId), f.transport)
    }, agentId)
    expect(f.sent[1]?.url).toBe(enabled ? 'http://127.0.0.1:11434/v1/messages' : 'https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(f.sent[1]?.init?.body)).model).toBe(enabled ? 'ollama-model' : 'claude-global')
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

test('Full sends the main request and parallel native Haiku agents to the selected Ollama model', async () => {
  const f = fixture()
  const selected = 'deepseek-v4.1-flash:cloud'
  f.stored.set(`preferences:${f.id}:model`, { version: 1, value: selected })
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
  // Switching the model after launch affects new work only.
  f.stored.set(`preferences:${f.id}:model`, { version: 1, value: 'kimi-k3.1-pro:cloud' })
  await Promise.all(ids.map(agentId => f.step(`${agentId}-turn`, 'claude-haiku-resolved', async model => {
    expect(model).toBe(selected)
    await executionFetch(f.engine, f.request(model, agentId), f.transport)
  }, agentId)))
  expect(f.sent.every(request => request.url === 'http://127.0.0.1:11434/v1/messages')).toBe(true)
  expect(f.sent.map(request => JSON.parse(String(request.init?.body)).model)).toEqual([selected, selected, selected])
  await f.step(`${f.id}-next`, 'claude-opus', async model => { await executionFetch(f.engine, f.request(model), f.transport) })
  expect(JSON.parse(String(f.sent[3]?.init?.body)).model).toBe('kimi-k3.1-pro:cloud')
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
        expect(model).toBe('ollama-model')
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
  expect(f.sent.every(request => JSON.parse(String(request.init?.body)).model === 'ollama-model')).toBe(true)
})


test('Ollama failures log only model, phase, status and a safe reason through the host', async () => {
  for (const phase of ['connection', 'preparation', 'transport', 'response', 'restriction'] as const) {
    const f = fixture()
    if (phase === 'connection') f.stored.set('connection-v1', 123)
    if (phase === 'preparation') f.engine.http.fetch = async () => ({ status: 429, ok: false, text: 'secret server body', headers: {} })
    const next = Object.assign(async (e: FetchInput) => {
      f.sent.push(e)
      if (phase === 'transport') throw new Error('secret transport token')
      return { value: { ...ok.value, status: 429, ok: false, text: 'secret response body' } }
    }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      const body = JSON.parse(String(request.init?.body))
      body.messages = [{ role: 'user', content: 'secret prompt' }]
      if (phase === 'restriction') body.tools.push({ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['private.example'] })
      const result = await executionFetch(f.engine, { ...request, init: { ...request.init, body: JSON.stringify(body) } }, next)
      if (phase === 'connection' || phase === 'transport') expect(result.deny).toContain('Settings → Advanced')
      else expect(result.deny).toContain('/model')
      if (phase === 'preparation' || phase === 'response') {
        expect(result.deny?.includes('HTTP 429')).toBe(true)
        expect(result.deny?.includes('Rate limit')).toBe(true)
      }
    })
    expect(f.sent.length).toBe(phase === 'transport' || phase === 'response' ? 1 : 0)
    const debug = f.logs.filter(log => log.to === 'debug')
    expect(debug).toHaveLength(1)
    const diagnostic = JSON.parse(debug[0]!.text.replace('Ollama failure: ', ''))
    expect(diagnostic.model).toBe('ollama-model')
    expect(diagnostic.phase).toBe(phase === 'restriction' ? 'request' : phase === 'transport' ? 'connection' : phase)
    if (phase === 'preparation' || phase === 'response') expect(diagnostic.status).toBe(429)
    const visible = f.logs.filter(log => log.to === 'transcript')
    expect(visible).toHaveLength(1)
    expect(visible[0]!.text).toContain('Ollama request failed (ollama-model')
    expect(visible[0]!.text).toContain(diagnostic.reason)
    expect(f.logs.some(log => /secret|private.example|native-key|native-secret/.test(log.text))).toBe(false)
  }
})

test('a disconnected subagent stops at the saved address while the native main chat can continue', async () => {
  const f = fixture('subagent', true)
  f.stored.set('connection-v1', 'http://127.0.0.1:49172')
  f.engine.http.fetch = async () => { throw new Error('unreachable') }
  const agentId = `${f.id}-worker`
  await executionSpawn(f.engine, { parentModel: 'claude-native', prompt: 'Work', description: 'Work', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1],
    (async () => ({ agentId, model: 'claude-native' })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  await f.step(`${f.id}-newer`, 'claude-native', async () => {})
  await f.step(agentId, 'claude-native', async model => {
    const failure = await executionFetch(f.engine, f.request(model, agentId), f.transport)
    expect(failure.deny).toContain("Can't reach Ollama at 127.0.0.1:49172")
    expect(failure.deny).toContain('Settings → Advanced')
    expect(await executionFetch(f.engine, f.request('claude-native', agentId), f.transport)).toEqual(failure)
  }, agentId)
  expect(f.sent).toHaveLength(0)
  await executionComplete(f.engine, { agentId, turnId: agentId, answer: '', durationMs: 1, isAborted: false, reason: 'error' },
    (async () => ({})) as unknown as Parameters<Hook<'turn.complete'>>[2])
  const visible = f.logs.filter(log => log.to === 'transcript')
  expect(visible).toHaveLength(1)
  expect(visible[0]!.text).toContain("Ollama subagent failed (ollama-model). Can't reach Ollama at 127.0.0.1:49172")
  await f.step(`${f.id}-main`, 'claude-native', async model => {
    expect(await executionFetch(f.engine, f.request(model), f.transport)).toBe(ok)
  })
  expect(f.sent.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages'])
})

test('completion-only errors surface for Ollama while cancellation and native turns stay quiet', async () => {
  for (const [mode, reason] of [['full', 'error'], ['full', 'aborted'], ['subagent', 'error']] as const) {
    const f = fixture(mode)
    await f.step(f.id, 'claude-native', async () => {})
    await executionComplete(f.engine, { turnId: f.id, answer: '', durationMs: 1, isAborted: reason === 'aborted', reason },
      (async () => ({})) as unknown as Parameters<Hook<'turn.complete'>>[2])
    const visible = f.logs.filter(log => log.to === 'transcript')
    if (mode === 'full' && reason === 'error') {
      expect(visible).toHaveLength(1)
      expect(visible[0]!.text).toContain('Claude Code reported an API error')
    } else expect(visible).toHaveLength(0)
  }
})

test('a retry after Ollama restarts clears its connection warning and keeps other notices', async () => {
  const f = fixture('full', true)
  await updateView(f.engine, state => ({ ...state, endpoint: 'http://127.0.0.1:11434' }))
  const online = f.engine.http.fetch
  f.engine.http.fetch = async () => { throw new Error('Connection refused') }
  await f.step(f.id, 'claude-native', async model => {
    const failure = await executionFetch(f.engine, f.request(model), f.transport)
    expect((await readView(f.engine)).connectionIssue).toBe(failure.deny)
    expect((await readView(f.engine)).connected).toBe(false)
  })
  f.engine.http.fetch = online
  await updateView(f.engine, state => ({ ...state, notice: 'Another notice' }))
  await f.step(`${f.id}-retry`, 'claude-native', async model => {
    expect(await executionFetch(f.engine, f.request(model), f.transport)).toBe(ok)
  })
  expect(await readView(f.engine)).toMatchObject({ connected: true, notice: 'Another notice' })
  expect((await readView(f.engine)).connectionIssue).toBeUndefined()
})

test('a host denial is preserved and cannot trigger a native or Ollama retry', async () => {
  const f = fixture()
  const denied = { deny: 'Stopped by the host policy.' }
  const next = Object.assign(async (e: FetchInput) => { f.sent.push(e); return denied }, { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
  await f.step(f.id, 'claude-original', async model => {
    expect(await executionFetch(f.engine, f.request(model), next)).toBe(denied)
    expect(await executionFetch(f.engine, f.request('claude-original'), next)).toEqual(denied)
  })
  expect(f.sent.length).toBe(1)
})


test('unsupported threaded requests and malformed bodies never leak to native inference', async () => {
  for (const body of ['{broken', JSON.stringify({ model: 'ollama-model', thread: { type: 'unknown' }, messages: [{ role: 'user', content: 'next' }] })]) {
    const f = fixture()
    await f.step(f.id, 'claude-original', async model => {
      const request = f.request(model)
      const result = await executionFetch(f.engine, { ...request, init: { ...request.init, body } }, f.transport)
      expect(result.deny?.includes('/model')).toBe(true)
    })
    expect(f.sent.length).toBe(0)
  }
})


test('routed failures publish one safe model-specific notice while retaining the original failure', async () => {
  for (const phase of ['response', 'host', 'stream'] as const) {
    const f = fixture('full', true)
    const original = new Error('secret interrupted stream')
    const denied = { deny: 'secret host denial' }
    const next = Object.assign(async () => phase === 'host' ? denied : phase === 'stream' ? ok : { value: { ...ok.value, status: 404, ok: false, text: 'secret response body' } },
      { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
    let caught: unknown
    let notice = ''
    try {
      await f.step(f.id, 'claude-native', async model => {
        const result = await executionFetch(f.engine, f.request(model), next)
        if (phase === 'stream') throw original
        if (phase === 'host') expect(result).toBe(denied)
        else expect(result.deny?.includes('HTTP 404')).toBe(true)
        notice = (await readView(f.engine)).notice
        await updateView(f.engine, state => ({ ...state, notice: 'Retrying now' }))
        await executionFetch(f.engine, f.request(model), next)
        expect((await readView(f.engine)).notice).toBe('Retrying now')
      })
    } catch (error) { caught = error }
    if (phase === 'stream') {
      expect(caught).toBe(original)
      notice = (await readView(f.engine)).notice
    }
    expect(notice.includes('ollama-model')).toBe(true)
    expect(notice.includes(phase)).toBe(true)
    if (phase === 'response') expect(notice.includes('HTTP 404')).toBe(true)
    expect(notice.includes('/model')).toBe(true)
    expect(notice.includes('secret')).toBe(false)
  }
})

test('late failures cannot overwrite a new chat, newer turn, model choice or retry notice', async () => {
  for (const changed of ['chat', 'turn', 'model', 'notice']) {
    const f = fixture('full', true)
    let release!: () => void
    let reached!: () => void
    const ready = new Promise<void>(resolve => { reached = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const next = Object.assign(async () => { reached(); await wait; return { value: { ...ok.value, status: 404, ok: false } } },
      { signal: f.controller.signal, origin: { plugin: 'engine', tier: 'core' } }) as unknown as FetchNext
    const pending = f.step(f.id, 'claude-native', async model => { await executionFetch(f.engine, f.request(model), next) })
    await ready
    if (changed === 'chat') f.setSessionId(`${f.id}-new`)
    if (changed === 'turn') await f.step(`${f.id}-new`, 'claude-native', async () => {})
    if (changed === 'model') f.stored.set(`preferences:${f.id}`, { version: 1, value: { ...f.preferences, model: 'different-model' } })
    if (changed === 'notice') await updateView(f.engine, state => ({ ...state, notice: 'Retrying now' }))
    const before = (await readView(f.engine)).notice
    release()
    await pending
    expect((await readView(f.engine)).notice).toBe(before)
    expect(f.logs.filter(log => log.to === 'transcript')).toHaveLength(changed === 'chat' ? 0 : 1)
  }
})
