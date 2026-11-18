import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { getPreferences, preferenceOwner } from '../hooks/runtime'
import { DEFAULT_PREFERENCES, loadPreferences, savePreference, savePreferences } from '../hooks/settings'

import { getConnection } from '../hooks/ollama'

const HOST_A = 'local_11111111-1111-4111-8111-111111111111'
const HOST_B = 'local_22222222-2222-4222-8222-222222222222'

function desktop() {
  let sessionId = 'cli-before-clear'
  let hostId = HOST_A
  let entrypoint = 'claude-desktop'
  const values = new Map<string, unknown>()
  const writes: string[] = []
  const engine = {
    session: { id: async () => sessionId },
    env: { get: async (key: string) => key === 'CLAUDE_CODE_ENTRYPOINT' ? entrypoint : key === 'CLAUDE_CODE_HOST_SESSION_ID' ? hostId : undefined },
    store: {
      get: async (key: string) => values.has(key) ? structuredClone(values.get(key)) : undefined,
      set: async (key: string, value: unknown) => { writes.push(key); values.set(key, structuredClone(value)) },
    },
  } as EngineInterface
  return {
    engine, values, writes,
    move: (id: string, host = HOST_A, entry = 'claude-desktop') => { sessionId = id; hostId = host; entrypoint = entry },
  }
}

const chosen = { ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent' as const, full: 'first', subagent: 'second', subagentEffort: 'high' as const }

test('Desktop process replacement keeps choices through the exact host identity', async () => {
  const fixture = desktop()
  const $ = fixture.engine
  await loadPreferences($, 'cli-before-clear', chosen)
  expect(await getPreferences($)).toEqual(chosen)
  fixture.move('cli-after-clear')
  expect(await getPreferences($)).toEqual(chosen)
  expect(fixture.values.get('chat-owner-v1:cli-before-clear')).toBe(`desktop:${HOST_A}`)
  expect(fixture.values.get('chat-owner-v1:cli-after-clear')).toBe(`desktop:${HOST_A}`)

  fixture.move('other-chat', HOST_B)
  expect(await getPreferences($)).toEqual(DEFAULT_PREFERENCES)
  expect(await preferenceOwner($, 'other-chat')).toBe(`desktop:${HOST_B}`)
})

test('CLI resume follows the saved Desktop alias and updates the same choices', async () => {
  const fixture = desktop()
  const $ = fixture.engine
  await loadPreferences($, 'cli-before-clear', chosen)
  await getPreferences($)
  fixture.move('cli-before-clear', '', 'cli')
  const owner = await preferenceOwner($, 'cli-before-clear')
  expect(owner).toBe(`desktop:${HOST_A}`)
  await savePreference($, owner, 'enabled', false)
  fixture.move('cli-new-process')
  expect(await getPreferences($)).toEqual({ ...chosen, enabled: false })
})

test('a stale callback owner is never attached to the currently open Desktop chat', async () => {
  const fixture = desktop()
  const $ = fixture.engine
  await loadPreferences($, 'unmapped-old-cli', chosen)
  fixture.move('current-cli', HOST_B)
  const current = { ...DEFAULT_PREFERENCES, full: 'current-chat-model' }
  await loadPreferences($, 'current-cli', current)
  expect(await getPreferences($)).toEqual(current)
  const staleOwner = await preferenceOwner($, 'unmapped-old-cli')
  expect(staleOwner).toBe('unmapped-old-cli')
  await savePreference($, staleOwner, 'full', 'old-chat-edit')
  expect(fixture.values.has('chat-owner-v1:unmapped-old-cli')).toBe(false)
  expect(fixture.values.get('chat-owner-v1:current-cli')).toBe(`desktop:${HOST_B}`)
  expect(await getPreferences($)).toEqual(current)
  expect((await loadPreferences($, 'unmapped-old-cli')).full).toBe('old-chat-edit')
})

test('a damaged saved Desktop alias is rejected without replacing it', async () => {
  const fixture = desktop()
  const $ = fixture.engine
  const key = 'chat-owner-v1:cli-before-clear'
  fixture.values.set(key, { owner: `desktop:${HOST_A}` })
  let rejected = false
  try { await getPreferences($) } catch { rejected = true }
  expect(rejected).toBe(true)
  expect(fixture.values.get(key)).toEqual({ owner: `desktop:${HOST_A}` })
  expect(fixture.writes).toEqual([])
})


test('a distinct new Desktop chat inherits the last complete setup and shared connection', async () => {
  const fixture = desktop()
  const $ = fixture.engine
  fixture.values.set('connection-v1', 'http://local-ollama:11434')
  const originalOwner = await preferenceOwner($, 'cli-before-clear')
  const setup = { ...DEFAULT_PREFERENCES, enabled: true, mode: 'subagent' as const, full: 'full-model', subagent: 'worker-model', subagentEffort: 'medium' as const }
  await savePreferences($, originalOwner, setup)
  fixture.move('new-chat-cli', HOST_B)
  expect(await getPreferences($)).toEqual(setup)
  expect(await getConnection($)).toEqual({ base: 'http://local-ollama:11434', key: '' })
  expect(fixture.values.get('chat-owner-v1:new-chat-cli')).toBe(`desktop:${HOST_B}`)
  await savePreference($, `desktop:${HOST_B}`, 'subagent', 'different-worker')
  fixture.move('cli-before-clear', HOST_A)
  expect(await getPreferences($)).toEqual(setup)
  expect(await getConnection($)).toEqual({ base: 'http://local-ollama:11434', key: '' })
})
