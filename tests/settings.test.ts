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

test('a fresh install enables only Ollama subagents with a cloud model ready before discovery', async () => {
  const store = storage()
  const expected = { enabled: true, mode: 'subagent', model: 'deepseek-v4.1-flash:cloud' }
  expect(await loadPreferences(store.engine, 'fresh')).toEqual(expected)
  expect(store.values.get('preferences:fresh')).toEqual({ version: 1, value: expected })
})

test('migration keeps the model last shown in the picker across mode changes and reloads', async () => {
  const store = storage()
  const { engine, values } = store
  const legacy = { enabled: false, mode: 'full', full: 'old-main', subagent: 'old-worker', fullEffort: 'high', subagentEffort: 'low' }
  values.set('preferences:old', { version: 1, value: legacy })
  values.set('preferences:old:mode', { version: 1, value: 'subagent' })
  values.set('preferences:old:subagent', { version: 1, value: 'edited-worker' })
  values.set('preference-defaults-v1', { version: 1, value: legacy })
  const migrated = { enabled: false, mode: 'subagent', model: 'edited-worker', fullEffort: 'high', subagentEffort: 'low' }
  expect(await loadPreferences(engine, 'old')).toEqual(migrated)
  expect((await loadPreferences(engine, 'fresh')).model).toBe('old-main')
  expect(await savePreference(engine, 'old', 'mode', 'full')).toEqual({ ...migrated, mode: 'full' })
  await savePreference(engine, 'old', 'model', 'shared-choice')
  expect((await loadPreferences(engine, 'old')).model).toBe('shared-choice')
  expect((await loadPreferences(engine, 'next')).model).toBe('shared-choice')
})

test('missing legacy models fall back to the other role and then the saved default', async () => {
  const { engine, values } = storage()
  values.set('preference-defaults-v1', { version: 1, value: { enabled: true, mode: 'subagent', subagent: 'my-default' } })
  values.set('preferences:partial', { version: 1, value: { enabled: true, mode: 'full', full: ' ', subagent: 'only-choice' } })
  values.set('preferences:partial:full', { version: 1, value: '' })
  values.set('preferences:empty', { version: 1, value: { enabled: true, mode: 'full' } })
  expect((await loadPreferences(engine, 'partial')).model).toBe('only-choice')
  expect((await loadPreferences(engine, 'empty')).model).toBe('my-default')
  await savePreference(engine, 'fresh', 'model', 'new-default')
  expect((await loadPreferences(engine, 'empty')).model).toBe('my-default')
})

test('a failed model migration can be retried without losing either legacy value', async () => {
  const store = storage()
  const legacy = { version: 1, value: { enabled: true, mode: 'full', full: 'main', subagent: 'worker' } }
  store.values.set('preferences:old', legacy)
  store.fail('preferences:old')
  expect(await rejected(loadPreferences(store.engine, 'old'))).toBe(true)
  expect(store.values.get('preferences:old')).toEqual(legacy)
  store.fail('')
  expect((await loadPreferences(store.engine, 'old')).model).toBe('main')
})

test('preferences capture defaults once and isolate each chat', async () => {
  const { engine: $ } = storage()
  const initial = { ...DEFAULT_PREFERENCES, model: 'first', subagentEffort: 'medium' as const }
  expect(await loadPreferences($, 'one', initial)).toEqual(initial)
  expect(await loadPreferences($, 'one', { ...initial, model: 'changed' })).toEqual(initial)
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
    savePreference($, 'one', 'model', 'first'),
    savePreference($, 'one', 'mode', 'subagent'),
    savePreference($, 'one', 'model', 'last'),
    savePreference($, 'one', 'subagentEffort', 'high'),
  ])
  expect(await loadPreferences($, 'one')).toEqual({ ...DEFAULT_PREFERENCES, model: 'last', mode: 'subagent', subagentEffort: 'high' })
  expect(store.writes.filter(key => key !== 'preference-defaults-v1')).toEqual(['preferences:one:model', 'preferences:one:mode', 'preferences:one:model', 'preferences:one:subagentEffort'])
  expect(await loadPreferences($, 'new')).toEqual(await loadPreferences($, 'one'))
  await savePreference($, 'one', 'subagentEffort', undefined)
  expect((await loadPreferences($, 'one')).subagentEffort).toBeUndefined()
})

test('failed saves retain the durable choice and do not block later edits', async () => {
  const store = storage()
  const $ = store.engine
  await savePreference($, 'one', 'model', 'durable')
  store.fail('preferences:one:model')
  expect(await rejected(savePreference($, 'one', 'model', 'lost'))).toBe(true)
  expect((await loadPreferences($, 'one')).model).toBe('durable')
  await savePreference($, 'one', 'enabled', true)
  store.fail('')
  await savePreference($, 'one', 'model', 'recovered')
  expect(await loadPreferences($, 'one')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, model: 'recovered' })
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
  store.values.set('preferences:orphan-model:model', { version: 1, value: 'orphaned' })
  expect(await rejected(loadPreferences($, 'orphan-model'))).toBe(true)
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
  await savePreference($, 'source', 'model', 'selected')
  await savePreference($, 'source', 'enabled', true)
  expect(await copyPreferences($, 'source', 'branch')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, model: 'selected' })
  await savePreference($, 'branch', 'mode', 'subagent')
  await savePreference($, 'source', 'model', 'new choice')
  expect(await copyPreferences($, 'source', 'branch')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent', model: 'selected' })
  expect(await loadPreferences($, 'source')).toEqual({ ...DEFAULT_PREFERENCES, enabled: true, model: 'new choice' })
})


test('the latest explicit chat configuration seeds new chats without mixing other chats', async () => {
  const { engine: $ } = storage()
  const first = { ...DEFAULT_PREFERENCES, enabled: true, model: 'first-choice' }
  const second = { ...DEFAULT_PREFERENCES, model: 'second-choice', subagentEffort: 'high' as const }
  await loadPreferences($, 'first', first)
  await loadPreferences($, 'second', second)
  await Promise.all([
    savePreference($, 'first', 'model', 'first-edited'),
    savePreference($, 'second', 'mode', 'subagent'),
  ])
  const latest = { ...second, mode: 'subagent' as const }
  expect(await loadPreferences($, 'new')).toEqual(latest)
  expect(await loadPreferences($, 'first')).toEqual({ ...first, model: 'first-edited' })
  await savePreference($, 'second', 'enabled', true)
  await savePreference($, 'second', 'subagentEffort', 'medium')
  expect(await loadPreferences($, 'next')).toEqual({ ...latest, enabled: true, subagentEffort: 'medium' })
  expect(await loadPreferences($, 'new')).toEqual(latest)
})

test('reads, resume-style loads, and explicit copies never publish defaults', async () => {
  const { engine: $ } = storage()
  const old = { ...DEFAULT_PREFERENCES, model: 'old-chat' }
  await loadPreferences($, 'old', old)
  await savePreference($, 'chosen', 'model', 'new-worker')
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
  await savePreference($, 'one', 'model', 'before')
  store.fail('preference-defaults-v1')
  let message = ''
  try { await savePreference($, 'one', 'model', 'after') }
  catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toContain('Saved this chat')
  expect(message).toContain('could not update defaults')
  expect((await loadPreferences($, 'one')).model).toBe('after')
  expect((await loadPreferences($, 'new')).model).toBe('before')
  store.fail('')
  await savePreference($, 'one', 'model', 'after')
  expect((await loadPreferences($, 'next')).model).toBe('after')
})

test('malformed or unreadable defaults cannot be overwritten by explicit saves', async () => {
  const store = storage()
  const $ = store.engine
  const own = { ...DEFAULT_PREFERENCES, model: 'own-chat' }
  await loadPreferences($, 'one', own)
  for (const damaged of [null, { version: 2, value: own }, { version: 1, value: { ...own, mode: 'router' } }]) {
    store.values.set('preference-defaults-v1', damaged)
    expect(await rejected(savePreference($, 'one', 'model', 'replacement'))).toBe(true)
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
  const expected = { ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent' as const, model: 'worker', subagentEffort: 'medium' as const }
  expect(await savePreferences($, 'one', { enabled: true, mode: 'subagent', model: 'worker', subagentEffort: 'medium' })).toEqual(expected)
  expect(store.writes).toEqual(['preferences:one:enabled', 'preferences:one:mode', 'preferences:one:model', 'preferences:one:subagentEffort', 'preference-defaults-v1'])
  expect(await loadPreferences($, 'fresh')).toEqual(expected)
})

test('invalid patches are rejected before writing any valid field', async () => {
  const store = storage()
  const $ = store.engine
  await loadPreferences($, 'one')
  store.writes.length = 0
  expect(await rejected(savePreferences($, 'one', {}))).toBe(true)
  expect(await rejected(savePreferences($, 'one', { enabled: true, model: '  ' }))).toBe(true)
  expect(await rejected(savePreferences($, 'one', { enabled: true, mode: 'router' } as never))).toBe(true)
  expect(await rejected(savePreferences($, 'one', { enabled: true, credentials: 'invalid' } as never))).toBe(true)
  expect(store.writes).toEqual([])
  expect(await loadPreferences($, 'one')).toEqual(DEFAULT_PREFERENCES)
})

test('a partial patch failure preserves successful fields without publishing partial defaults', async () => {
  const store = storage()
  const $ = store.engine
  await savePreference($, 'one', 'model', 'native-choice')
  store.fail('preferences:one:mode')
  let message = ''
  try { await savePreferences($, 'one', { enabled: true, mode: 'subagent', model: 'worker' }) }
  catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toContain('Some chat changes were saved')
  expect(message).toContain('Defaults are unchanged')
  expect(await loadPreferences($, 'one')).toEqual({ ...DEFAULT_PREFERENCES, model: 'native-choice', enabled: true })
  expect(await loadPreferences($, 'fresh')).toEqual({ ...DEFAULT_PREFERENCES, model: 'native-choice' })
  store.fail('')
  const result = await savePreferences($, 'one', { enabled: true, mode: 'subagent', model: 'worker' })
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
      store.values.set('preferences:one:model', { version: 1, value: 'other-process-choice' })
    }
  }
  const expected = { ...DEFAULT_PREFERENCES, mode: 'subagent' as const, subagentEffort: 'high' as const, model: 'other-process-choice' }
  expect(await savePreferences($, 'one', { mode: 'subagent', subagentEffort: 'high' })).toEqual(expected)
  expect(await loadPreferences($, 'fresh')).toEqual(expected)
})

test('existing disabled chats and defaults retain their saved modes and explicit models', async () => {
  const store = storage()
  const disabled = { enabled: false, mode: 'full' as const, full: 'chosen-main', subagent: 'chosen-worker' }
  store.values.set('preferences:old', { version: 1, value: disabled })
  store.values.set('preference-defaults-v1', { version: 1, value: disabled })
  const converted = { enabled: false, mode: 'full', model: 'chosen-main' }
  expect(await loadPreferences(store.engine, 'old')).toEqual(converted)
  expect(await loadPreferences(store.engine, 'new')).toEqual(converted)
})
