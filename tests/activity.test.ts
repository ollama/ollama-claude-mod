import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Hook } from 'claude-code'
import { readActivity, resetActivity, startAgentActivity, startMainActivity, toggleActivity, updateAgentActivity, updateMainActivity } from '../hooks/activity'
import { executionComplete, executionSpawn, executionStep } from '../hooks/execution'
import { DEFAULT_PREFERENCES } from '../hooks/settings'

let sequence = 0
function fixture() {
  let owner = `activity-${++sequence}`
  let time = 0
  const states = new Map<string, { value: unknown; version: number }>()
  const preferences = { ...DEFAULT_PREFERENCES, fullEffort: 'high' }
  const engine = {
    session: { id: async () => owner },
    state: {
      get: async (ref: unknown) => states.get(JSON.stringify(ref)) ?? { value: undefined, version: 0 },
      set: async (ref: unknown, value: unknown) => { const version = (states.get(JSON.stringify(ref))?.version ?? 0) + 1; states.set(JSON.stringify(ref), { value, version }); return { isSet: true, version } },
    },
    clock: { now: async () => time },
    settings: { read: async () => ({}) },
    store: { get: async (key: string) => key === `preferences:${owner}` ? { version: 1, value: preferences } : undefined, set: async () => { throw new Error('Unexpected persistent write') }, delete: async () => {}, keys: async () => [] },
    env: { get: async () => undefined },
  } as unknown as EngineInterface
  return { engine, owner: () => owner, switchOwner: () => { owner = `activity-${++sequence}` }, advance: (ms: number) => { time += ms } }
}

test('activity isolates chat owners and ignores stale result and visibility callbacks', async () => {
  const f = fixture()
  const old = f.owner()
  await resetActivity(f.engine, old)
  await startAgentActivity(f.engine, old, { id: 'old', task: 'old task', model: 'old-model', tokens: 0, running: true })
  f.switchOwner()
  expect((await readActivity(f.engine)).subagents).toEqual([])
  await resetActivity(f.engine, f.owner())
  await startMainActivity(f.engine, f.owner(), { model: 'new', target: '', tokens: 0, running: true }, true)
  await updateAgentActivity(f.engine, old, 'old', row => ({ ...row, tokens: 99 }))
  await updateMainActivity(f.engine, old, { model: 'old', target: '', tokens: 99, running: false })
  await resetActivity(f.engine, old)
  await toggleActivity(f.engine, old)
  expect(await readActivity(f.engine)).toMatchObject({ owner: f.owner(), hidden: false, main: { model: 'new', tokens: 0 }, subagents: [] })
})

test('new turns retain running workers, clear completed rows, and bound retained activity', async () => {
  const f = fixture()
  await resetActivity(f.engine, f.owner())
  await startAgentActivity(f.engine, f.owner(), { id: 'background', task: 'working', model: 'worker', tokens: 12, running: true })
  await startAgentActivity(f.engine, f.owner(), { id: 'done', task: 'finished', model: 'worker', tokens: 34, running: false })
  await toggleActivity(f.engine, f.owner())
  await startMainActivity(f.engine, f.owner(), { model: 'native', target: '', tokens: 0, running: true }, true)
  expect(await readActivity(f.engine)).toMatchObject({ hidden: true, subagents: [{ id: 'background', tokens: 12 }] })
  for (let index = 0; index < 40; index++) await startAgentActivity(f.engine, f.owner(), { id: `worker-${index}`, task: 'task', model: 'worker', tokens: 0, running: true })
  expect((await readActivity(f.engine)).subagents.length).toBe(24)
})

test('execution counts confirmed output and excludes time between model steps', async () => {
  const f = fixture()
  const turnId = f.owner()
  async function step(index: number, output: number, duration: number) {
    const next = async function* () {
      expect((await readActivity(f.engine)).main?.tokens).toBe(index === 0 ? 0 : 100)
      yield { kind: 'text', text: 'No estimated counts' }
      f.advance(duration)
      return { turnId, index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: { model: 'actual-native', output_tokens: output } }
    }
    const stream = executionStep(f.engine, { turnId, index, model: 'claude-native', effort: 'medium', messageCount: 1 }, next as unknown as Parameters<Hook<'turn.step'>>[2])
    for await (const _chunk of stream) { /* Preserve and drain the real stream. */ }
  }
  await step(0, 100, 1000)
  f.advance(9000)
  await step(1, 100, 1000)
  expect((await readActivity(f.engine)).main).toMatchObject({ model: 'actual-native', target: '', effort: 'medium', tokens: 200, tokensPerSecond: 100, running: true })
  await executionComplete(f.engine, { turnId, reason: 'answer', isAborted: false } as Parameters<Hook<'turn.complete'>>[1], (async () => ({ text: '' })) as unknown as Parameters<Hook<'turn.complete'>>[2])
  expect((await readActivity(f.engine)).main?.running).toBe(false)
  expect((await readActivity(f.engine)).main?.effort).toBe('medium')
})

test('a broken step stops activity and preserves its error', async () => {
  const f = fixture()
  const error = new Error('broken stream')
  const next = async function* () { yield { kind: 'text', text: 'partial' }; throw error }
  let caught: unknown
  try {
    for await (const _chunk of executionStep(f.engine, { turnId: f.owner(), index: 0, model: 'claude-native', messageCount: 1 }, next as unknown as Parameters<Hook<'turn.step'>>[2])) { /* drain */ }
  } catch (failure) { caught = failure }
  expect(caught).toBe(error)
  expect((await readActivity(f.engine)).main).toMatchObject({ running: false, tokens: 0 })
})

test('aborted native agents stop with failure instead of reporting success', async () => {
  const f = fixture()
  const input = { parentModel: 'claude-native', description: 'Investigate the failing test', prompt: 'details', subagentType: 'Explore' } as Parameters<Hook<'agent.spawn'>>[1]
  await executionSpawn(f.engine, input, (async () => ({ agentId: 'worker', model: 'actual-worker' })) as unknown as Parameters<Hook<'agent.spawn'>>[2])
  expect((await readActivity(f.engine)).subagents).toMatchObject([{ id: 'worker', model: 'actual-worker', task: input.description, tokens: 0, running: true }])
  await executionComplete(f.engine, { turnId: 'worker-turn', agentId: 'worker', reason: 'aborted', isAborted: true } as Parameters<Hook<'turn.complete'>>[1], (async () => ({ text: '' })) as unknown as Parameters<Hook<'turn.complete'>>[2])
  expect((await readActivity(f.engine)).subagents).toMatchObject([{ id: 'worker', running: false, failed: true, tokens: 0 }])
})
