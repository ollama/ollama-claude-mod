import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { copyPreferences, DEFAULT_PREFERENCES, loadPreferences, savePreference, savePreferences } from '../hooks/settings'

// Keep the external store boundary deterministic, while exercising the real
// validation, initialization, serialization, and persistence logic.
function storage() {
  const values = new Map<string, unknown>()
  const writes: string[] = []
  let failedKey = ''
  let unreadableKey = ''
  const engine = {
    store: {
      async get(key: string): Promise<unknown> {
        if (key === unreadableKey) throw new Error('Cannot read preferences')
        const value = values.get(key)
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
      },
      async set(key: string, value: unknown): Promise<void> {
        if (key === failedKey) throw new Error('Cannot save preferences')
        writes.push(key)
        values.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
  } as EngineInterface
  return {
    engine, values, writes,
    fail: (key: string) => { failedKey = key },
    unreadable: (key: string) => { unreadableKey = key },
  }
}

async function rejected(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
    return false
  } catch {
    return true
  }
}

test('a fresh chat stays native with both Ollama models ready before discovery', async () => {
  const store = storage()
  const expected = { enabled: false, mode: 'full', full: 'kimi-k3.1-pro:cloud', subagent: 'deepseek-v4.1-flash:cloud' }
  expect(await loadPreferences(store.engine, 'fresh')).toEqual(expected)
  expect(store.values.get('preferences:fresh')).toEqual({ version: 1, value: expected })
})

test('legacy chats fill missing roles once and retain explicit choices and new-chat defaults', async () => {
  const store = storage()
  const prior = { enabled: true, mode: 'subagent', full: ' ', subagent: 'my-worker' }
  store.values.set('preference-defaults-v1', { version: 1, value: prior })
  store.values.set('preferences:old', { version: 1, value: { enabled: true, mode: 'full', full: 'my-main' } })
  store.values.set('preferences:old:subagent', { version: 1, value: '' })
  expect(await loadPreferences(store.engine, 'fresh')).toEqual({ ...prior, full: 'kimi-k3.1-pro:cloud' })
  const repaired = { enabled: true, mode: 'full', full: 'my-main', subagent: 'my-worker' }
  expect(await loadPreferences(store.engine, 'old')).toEqual(repaired)
  await savePreference(store.engine, 'fresh', 'subagent', 'new-worker')
  expect(await loadPreferences(store.engine, 'old')).toEqual(repaired)
  expect((await loadPreferences(store.engine, 'next')).subagent).toBe('new-worker')
})

test('preferences capture defaults once and isolate each chat', async () => {
  const { engine: $ } = storage()
  const initial = { ...DEFAULT_PREFERENCES, full: 'first', subagentEffort: 'medium' as const }
  expect(await loadPreferences($, 'one', initial)).toEqual(initial)
  expect(await loadPreferences($, 'one', { ...initial, full: 'changed' })).toEqual(initial)
  await savePreference($, 'one', 'enabled', true)
  expect(await loadPreferences($, 'two')).toEqual({ ...initial, enabled: true })
  expect(await loadPreferences($, 'one')).toEqual({ ...initial, enabled: true })
})

test('concurrent edits preserve independent fields and the last saved choice', async () => {
  const store = storage()
  const $ = store.engine
  await loadPreferences($, 'one')
  store.writes.length = 0
  await Promise.all([
    savePreference($, 'one', 'full', 'first'),
    savePreference($, 'one', 'mode', 'subagent'),
    savePreference($, 'one', 'full', 'last'),
    savePreference($, 'one', 'subagentEffort', 'high'),
  ])
  expect(await loadPreferences($, 'one')).toEqual({ ...DEFAULT_PREFERENCES, full: 'last', mode: 'subagent', subagentEffort: 'high' })
  expect(store.writes.filter(key => key !== 'preference-defaults-v1')).toEqual(['preferences:one:full', 'preferences:one:mode', 'preferences:one:full', 'preferences:one:subagentEffort'])
  expect(await loadPreferences($, 'new')).toEqual(await loadPreferences($, 'one'))
  await savePreference($, 'one', 'subagentEffort', undefined)
  expect((await loadPreferences($, 'one')).subagentEffort).toBeUndefined()
})

test('failed saves retain the durable choice and do not block later edits', async () => {
  const store = storage()
  const $ = store.engine
  await savePreference($, 'one', 'full', 'durable')
  store.fail('preferences:one:full')
  expect(await rejected(savePreference($, 'one', 'full', 'lost'))).toBe(true)
  expect((await loadPreferences($, 'one')).full).toBe('durable')
  await savePreference($, 'one', 'enabled', true)
  store.fail('')
  await savePreference($, 'one', 'full', 'recovered')
  expect(await loadPreferences($, 'one')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, full: 'recovered' })
})

test('damaged, unknown-version, and unreadable records are never replaced', async () => {
  const store = storage()
  const $ = store.engine
  const damaged = [
    null,
    { version: 2, value: DEFAULT_PREFERENCES },
    { version: 1, value: { ...DEFAULT_PREFERENCES, mode: 'router' } },
    { version: 1, value: { ...DEFAULT_PREFERENCES, credentials: 'must not be accepted' } },
  ]
  for (const value of damaged) {
    store.values.set('preferences:broken', value)
    expect(await rejected(loadPreferences($, 'broken'))).toBe(true)
    expect(await rejected(savePreference($, 'broken', 'enabled', true))).toBe(true)
    expect(store.values.get('preferences:broken')).toEqual(value)
  }
  store.unreadable('preferences:unreadable')
  expect(await rejected(loadPreferences($, 'unreadable'))).toBe(true)
  expect(await rejected(savePreference($, 'unreadable', 'enabled', true))).toBe(true)
  store.values.set('preferences:orphan:full', { version: 1, value: 'orphaned' })
  expect(await rejected(loadPreferences($, 'orphan'))).toBe(true)
  expect(store.writes).toEqual([])
})

test('a malformed edited field cannot be hidden by a later save', async () => {
  const store = storage()
  const $ = store.engine
  await loadPreferences($, 'one')
  store.values.set('preferences:one:fullEffort', { version: 1, value: 'unrecognized' })
  store.writes.length = 0
  expect(await rejected(savePreference($, 'one', 'enabled', true))).toBe(true)
  expect(store.writes).toEqual([])
})

test('clear or branch copies choices once and does not follow later source edits', async () => {
  const { engine: $ } = storage()
  await savePreference($, 'source', 'full', 'selected')
  await savePreference($, 'source', 'enabled', true)
  expect(await copyPreferences($, 'source', 'branch')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, full: 'selected' })
  await savePreference($, 'branch', 'mode', 'subagent')
  await savePreference($, 'source', 'full', 'new choice')
  expect(await copyPreferences($, 'source', 'branch')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent', full: 'selected' })
  expect(await loadPreferences($, 'source')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, full: 'new choice' })
})


test('the latest explicit chat configuration seeds new chats without mixing other chats', async () => {
  const { engine: $ } = storage()
  const first = { ...DEFAULT_PREFERENCES, enabled: true, full: 'first-full', subagent: 'first-worker' }
  const second = { ...DEFAULT_PREFERENCES, full: 'second-full', subagent: 'second-worker', subagentEffort: 'high' as const }
  await loadPreferences($, 'first', first)
  await loadPreferences($, 'second', second)
  await Promise.all([
    savePreference($, 'first', 'full', 'first-edited'),
    savePreference($, 'second', 'mode', 'subagent'),
  ])
  const latest = { ...second, mode: 'subagent' as const }
  expect(await loadPreferences($, 'new')).toEqual(latest)
  expect(await loadPreferences($, 'first')).toEqual({ ...first, full: 'first-edited' })
  await savePreference($, 'second', 'enabled', true)
  await savePreference($, 'second', 'subagentEffort', 'medium')
  expect(await loadPreferences($, 'next')).toEqual({ ...latest, enabled: true, subagentEffort: 'medium' })
  expect(await loadPreferences($, 'new')).toEqual(latest)
})

test('reads, resume-style loads, and explicit copies never publish defaults', async () => {
  const { engine: $ } = storage()
  const old = { ...DEFAULT_PREFERENCES, full: 'old-chat' }
  await loadPreferences($, 'old', old)
  await savePreference($, 'chosen', 'subagent', 'new-worker')
  await savePreference($, 'chosen', 'mode', 'subagent')
  await savePreference($, 'chosen', 'enabled', true)
  const latest = await loadPreferences($, 'chosen')
  expect(await copyPreferences($, 'old', 'branch')).toEqual(old)
  expect(await loadPreferences($, 'migration', old)).toEqual(old)
  expect(await loadPreferences($, 'old')).toEqual(old)
  expect(await loadPreferences($, 'fresh')).toEqual(latest)
})

test('a failed defaults update reports the saved chat and preserves prior new-chat defaults', async () => {
  const store = storage()
  const $ = store.engine
  await savePreference($, 'one', 'full', 'before')
  store.fail('preference-defaults-v1')
  let message = ''
  try { await savePreference($, 'one', 'full', 'after') }
  catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toContain('Saved this chat')
  expect(message).toContain('could not update defaults')
  expect((await loadPreferences($, 'one')).full).toBe('after')
  expect((await loadPreferences($, 'new')).full).toBe('before')
  store.fail('')
  await savePreference($, 'one', 'full', 'after')
  expect((await loadPreferences($, 'next')).full).toBe('after')
})

test('malformed or unreadable defaults cannot be overwritten by explicit saves', async () => {
  const store = storage()
  const $ = store.engine
  const own = { ...DEFAULT_PREFERENCES, full: 'own-chat' }
  await loadPreferences($, 'one', own)
  for (const damaged of [null, { version: 2, value: own }, { version: 1, value: { ...own, mode: 'router' } }]) {
    store.values.set('preference-defaults-v1', damaged)
    expect(await rejected(savePreference($, 'one', 'full', 'replacement'))).toBe(true)
    expect(await rejected(loadPreferences($, 'new'))).toBe(true)
    expect(store.values.get('preference-defaults-v1')).toEqual(damaged)
    expect(await loadPreferences($, 'one')).toEqual(own)
  }
  store.unreadable('preference-defaults-v1')
  expect(await rejected(savePreference($, 'one', 'enabled', true))).toBe(true)
  expect(await rejected(loadPreferences($, 'unreadable'))).toBe(true)
  expect(await loadPreferences($, 'explicit-copy', own)).toEqual(own)
  expect(store.writes).toEqual(['preferences:one', 'preferences:explicit-copy'])
})


test('one explicit patch publishes only its complete configuration as new-chat defaults', async () => {
  const store = storage()
  const $ = store.engine
  await loadPreferences($, 'one')
  store.writes.length = 0
  const expected = { ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent' as const, subagent: 'worker', subagentEffort: 'medium' as const }
  expect(await savePreferences($, 'one', { enabled: true, mode: 'subagent', subagent: 'worker', subagentEffort: 'medium' })).toEqual(expected)
  expect(store.writes).toEqual(['preferences:one:enabled', 'preferences:one:mode', 'preferences:one:subagent', 'preferences:one:subagentEffort', 'preference-defaults-v1'])
  expect(await loadPreferences($, 'fresh')).toEqual(expected)
})

test('invalid patches are rejected before writing any valid field', async () => {
  const store = storage()
  const $ = store.engine
  await loadPreferences($, 'one')
  store.writes.length = 0
  expect(await rejected(savePreferences($, 'one', {}))).toBe(true)
  expect(await rejected(savePreferences($, 'one', { enabled: true, subagent: '  ' }))).toBe(true)
  expect(await rejected(savePreferences($, 'one', { enabled: true, mode: 'router' } as never))).toBe(true)
  expect(await rejected(savePreferences($, 'one', { enabled: true, credentials: 'invalid' } as never))).toBe(true)
  expect(store.writes).toEqual([])
  expect(await loadPreferences($, 'one')).toEqual(DEFAULT_PREFERENCES)
})

test('a partial patch failure preserves successful fields without publishing partial defaults', async () => {
  const store = storage()
  const $ = store.engine
  await savePreference($, 'one', 'full', 'native-choice')
  store.fail('preferences:one:mode')
  let message = ''
  try { await savePreferences($, 'one', { enabled: true, mode: 'subagent', subagent: 'worker' }) }
  catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toContain('Some chat changes were saved')
  expect(message).toContain('Defaults are unchanged')
  expect(await loadPreferences($, 'one')).toEqual({ ...DEFAULT_PREFERENCES, full: 'native-choice', enabled: true })
  expect(await loadPreferences($, 'fresh')).toEqual({ ...DEFAULT_PREFERENCES, full: 'native-choice' })
  store.fail('')
  const result = await savePreferences($, 'one', { enabled: true, mode: 'subagent', subagent: 'worker' })
  expect(await loadPreferences($, 'next')).toEqual(result)
})

test('patch publication rereads unrelated durable edits instead of overwriting them', async () => {
  const store = storage()
  const $ = store.engine
  await loadPreferences($, 'one')
  const persist = $.store.set
  $.store.set = async (key, value) => {
    await persist(key, value)
    if (key === 'preferences:one:mode') {
      store.values.set('preferences:one:full', { version: 1, value: 'other-process-choice' })
    }
  }
  const expected = { ...DEFAULT_PREFERENCES, mode: 'subagent' as const, subagent: 'worker', full: 'other-process-choice' }
  expect(await savePreferences($, 'one', { mode: 'subagent', subagent: 'worker' })).toEqual(expected)
  expect(await loadPreferences($, 'fresh')).toEqual(expected)
})
