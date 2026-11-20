import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Hook } from 'claude-code'
import type { Preferences } from '../types'
import { composeRoutingContext, refreshQueuedRoutingContext, submitRoutingContext } from '../hooks/context'

function fixture() {
  let preferences: Preferences = { enabled: true, mode: 'full', full: 'configured-model', subagent: 'worker-model' }
  let unreadable = false
  const engine = {
    session: { id: async () => 'context-chat' },
    env: { get: async () => undefined },
    store: { get: async (key: string) => {
      if (unreadable) throw new Error('unreadable')
      return key === 'preferences:context-chat' ? { version: 1, value: preferences } : undefined
    } },
  } as unknown as EngineInterface
  return { engine, set: (next: Preferences) => { preferences = next }, fail: () => { unreadable = true } }
}
const prompt = { text: 'Do the requested work', wait: false, origin: { kind: 'composer' }, context: ['Other plugin context'] } as Parameters<Hook<'prompt.submit'>>[1]
async function submit(engine: EngineInterface) {
  let captured = prompt
  await submitRoutingContext(engine, prompt, (async (value: Parameters<Hook<'prompt.submit'>>[1]) => { captured = value; return value }) as unknown as Parameters<Hook<'prompt.submit'>>[2])
  return captured
}

test('Agent-enabled prompts explain model aliases and how to inherit the configured route', async () => {
  const base = { sections: [{ id: 'base', text: 'Original system instructions', scope: 'shared' as const }] }
  const e: Parameters<Hook<'prompt.compose'>>[1] = { model: 'claude-opus', promptModel: 'claude-opus', surfaces: [], tools: ['Agent'], outputStyle: null, traits: [] }
  const next = (async () => base) as unknown as Parameters<Hook<'prompt.compose'>>[2]
  const result = await composeRoutingContext({} as EngineInterface, e, next)
  expect(result.sections[0]).toEqual(base.sections[0])
  expect(result.sections.length).toBe(2)
  const explanation = result.sections[1]!.text
  expect(explanation.includes('native startup model')).toBe(true)
  expect(explanation.split('\n\n').slice(2)).toEqual(['Use the native Agent tool normally. Omit its model argument unless a specific native model is wanted.'])
  expect(await composeRoutingContext({} as EngineInterface, { ...e, tools: ['Read'] }, next)).toEqual(base)
})

test('each submitted prompt carries configured routing while preserving text and other context', async () => {
  const f = fixture()
  const full = await submit(f.engine)
  expect(full.text).toBe(prompt.text)
  expect(full.context?.[0]).toBe('Other plugin context')
  expect(full.context?.[1]).toContain('"configured-model" for this conversation')
  expect(full.context?.[1]).toContain('"worker-model" for native subagents')
  f.set({ enabled: false, mode: 'full', full: 'configured-model', subagent: 'worker-model' })
  expect((await submit(f.engine)).context?.[1]).toBe('ollama routing: Off for new work; use native Claude Code models.')
  f.fail()
  expect((await submit(f.engine)).context?.[1]?.includes('Current settings could not be read')).toBe(true)
})

test('queued context updates our routing note at append time and leaves unrelated text intact', async () => {
  const f = fixture()
  const submitted = await submit(f.engine)
  f.set({ enabled: true, mode: 'subagent', full: 'configured-model', subagent: 'new-worker-model' })
  const e = {
    door: 'hook-context', uuid: 'queued-context', origin: { kind: 'composer' },
    message: { type: 'attachment', content: [{ type: 'text', text: `Other plugin context\n${submitted.context![1]!.replace('ollama routing:', 'ollama-chat routing:')}` }, { type: 'text', text: 'Keep this second block' }] },
  } as Parameters<Hook<'session.append'>>[1]
  let captured = e
  const next = (async (value: Parameters<Hook<'session.append'>>[1]) => { captured = value; return { message: value.message } }) as unknown as Parameters<Hook<'session.append'>>[2]
  await refreshQueuedRoutingContext(f.engine, e, next)
  expect(String(captured.message.content[0]?.text).includes('Other plugin context\n')).toBe(true)
  expect(String(captured.message.content[0]?.text).includes('Subagents; this conversation stays native, configured target "new-worker-model"')).toBe(true)
  expect(String(captured.message.content[0]?.text).includes('Full;')).toBe(false)
  expect(String(captured.message.content[0]?.text).includes('ollama-chat routing:')).toBe(false)
  expect(captured.message.content[1]).toEqual(e.message.content[1])
  const ordinary = { ...e, door: 'prompt' as const }
  await refreshQueuedRoutingContext(f.engine, ordinary, next)
  expect(captured).toEqual(ordinary)
})

test('routing changes preserve the system prefix and previously submitted context', async () => {
  const f = fixture()
  const base = { sections: [
    { id: 'base', text: 'Shared system instructions', scope: 'shared' as const },
    { id: 'session', text: 'Stable session instructions', scope: 'session' as const },
  ] }
  const event: Parameters<Hook<'prompt.compose'>>[1] = { model: 'claude-opus', promptModel: 'claude-opus', surfaces: [], tools: ['Agent'], outputStyle: null, traits: [] }
  const next = (async () => base) as unknown as Parameters<Hook<'prompt.compose'>>[2]
  const original = await composeRoutingContext(f.engine, event, next)
  const submitted = await submit(f.engine)
  const previousContext = [...submitted.context!]
  expect(original.sections.slice(0, base.sections.length)).toEqual(base.sections)
  expect(original.sections.at(-1)?.scope).toBe('session')

  for (const preferences of [
    { enabled: true, mode: 'subagent' as const, full: 'other-full', subagent: 'other-worker' },
    { enabled: false, mode: 'full' as const, full: 'other-full', subagent: 'other-worker' },
  ]) {
    f.set(preferences)
    expect(await composeRoutingContext(f.engine, event, next)).toEqual(original)
    const current = await submit(f.engine)
    expect(current.context?.[0]).toBe('Other plugin context')
    expect(current.context?.[1]).not.toBe(previousContext[1])
    expect(submitted.context).toEqual(previousContext)
  }
})
