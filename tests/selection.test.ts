import { expect, test } from 'claude-code/testing'
import type { ClassicHookInputs, ClassicResult, CommandRunResult, EngineInterface, Hook } from 'claude-code'
import { cancelSelection, confirmSelection, isOwnSelection, scheduleSelection, selectModel } from '../hooks/selection'
import { loadPreferences, savePreference } from '../hooks/settings'
import type { Preferences } from '../types'
import { register } from '../hooks/register'
import { executionStep } from '../hooks/execution'
import { modelSwitched } from '../hooks/models'
import type { Register } from 'claude-code'

const NATIVE = 'claude-opus-5-5'
const FULL = 'glm-5.3-flash:cloud'
const WORKER = 'kimi-k3:cloud'
const defaults: Preferences = { enabled: false, mode: 'full', full: FULL, subagent: WORKER }
type Command = Parameters<Hook<'command.run'>>[1]
type Next = Parameters<Hook<'command.run'>>[2]
type ConfirmNext = Parameters<Hook<'classic.PreModelSwitch'>>[2]

// The public scheduler is fire-and-forget. Drain its finite promise work without
// wall-clock sleeps; an unresolved native command remains deliberately queued.
async function settle(): Promise<void> {
  for (let index = 0; index < 500; index++) await Promise.resolve()
}

function fixture(current = FULL, preferences = defaults, throughCommandHook = false) {
  cancelSelection()
  let id = 'selection-chat'
  let model = current
  let held = false
  let outcome: 'ok' | 'denied' | 'nonzero' = 'ok'
  let preResult: ClassicResult = {}
  let metadataWait: Promise<void> | undefined
  let releaseMetadata: (() => void) | undefined
  let metadataStatus = 200
  let state = { shape: 'view-v1', value: { preferences, models: [], notice: '' } }
  const timers: { cancelled: boolean; callback: () => void }[] = []
  const queued: { event: Command; resolve: (value: CommandRunResult) => void }[] = []
  const calls: string[] = []
  const selected: string[] = []
  const ownership: boolean[] = []
  const confirmations: ClassicResult[] = []
  const stored = new Map<string, unknown>([
    ['preferences:selection-chat', { version: 1, value: { ...preferences } }],
    ['native-model-v1:last', NATIVE],
  ])
  const engine = {
    session: { id: async () => id, model: async () => model },
    env: { get: async () => undefined },
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => { stored.set(key, value) },
    },
    settings: { read: async () => ({}) },
    http: { fetch: async () => {
      await metadataWait
      return { status: metadataStatus, ok: metadataStatus === 200, headers: {}, text: JSON.stringify({ capabilities: ['tools'] }) }
    } },
    state: {
      get: async () => ({ value: state, version: 0 }),
      set: async (_ref: unknown, value: typeof state) => { state = value; return { isSet: true, version: 1 } },
    },
    clock: {
      sleep: async () => undefined,
      after: (_ms: number, callback: () => void) => {
        const timer = { callback, cancelled: false }
        timers.push(timer)
        return { cancel: () => { timer.cancelled = true } }
      },
    },
    command: { run: async ({ args }: { command: string; args: string }) => {
      calls.push(args)
      const event = { command: 'model', args, origin: { kind: 'plugin', name: 'ollama' } } as Command
      if (held) return new Promise<CommandRunResult>(resolve => { queued.push({ event, resolve }) })
      return dispatch(event)
    } },
  } as unknown as EngineInterface
  async function dispatch(event: Command) {
    const native = async () => {
      if (outcome === 'nonzero') return { text: 'Unavailable', exitCode: 1 }
      if (outcome === 'denied') return { text: 'Denied' }
      const to = event.args === 'default' ? NATIVE : event.args
      const switched = { session_id: id, from_model: model, to_model: to, requested_model: event.args === 'default' ? null : event.args, source: 'command' } as ClassicHookInputs['PostModelSwitch']
      const confirmation = await confirmSelection(engine, switched as unknown as ClassicHookInputs['PreModelSwitch'], (async () => preResult) as unknown as ConfirmNext)
      confirmations.push(confirmation)
      if (confirmation.block || confirmation.preventContinuation || confirmation.permissionDecision === 'ask' || confirmation.permissionDecision === 'deny') return { text: 'Switch refused' }
      model = to
      selected.push(to)
      ownership.push(isOwnSelection(switched))
      return { text: `Selected ${to}` }
    }
    // Timer calls reach the native command without re-entering this plugin's
    // command hook. Its native PreModelSwitch event still runs the plugin.
    if (!throughCommandHook && event.origin.kind === 'plugin') return native()
    return selectModel(engine, event, native as unknown as Next)
  }
  return {
    engine, calls, selected, ownership, confirmations,
    model: () => model,
    notice: () => state.value.notice,
    state: () => state.value as typeof state.value & { selection?: { target: string; current: string; status: string } },
    pendingTimers: () => timers.filter(timer => !timer.cancelled).length,
    preferences: (value: Preferences) => { stored.set(`preferences:${id}`, { version: 1, value: { ...value } }) },
    move: (nextId: string) => { id = nextId; stored.set(`preferences:${id}`, { version: 1, value: { ...defaults } }) },
    hold: () => { held = true },
    holdMetadata: () => { metadataWait = new Promise(resolve => { releaseMetadata = resolve }) },
    releaseMetadata: () => { metadataWait = undefined; releaseMetadata?.() },
    metadataStatus: (status: number) => { metadataStatus = status },
    fail: (value: typeof outcome) => { outcome = value },
    confirmation: (value: ClassicResult) => { preResult = value },
    fire: async () => {
      const timer = timers.find(item => !item.cancelled)
      if (timer) { timer.cancelled = true; timer.callback() }
      await settle()
    },
    release: async () => {
      held = false
      const command = queued.shift()
      if (command) command.resolve(await dispatch(command.event))
      await settle()
    },
    manual: async (target: string) => {
      await dispatch({ command: 'model', args: target, origin: { kind: 'composer' } } as Command)
      await settle()
    },
  }
}

test('native timer commands skip our command hook but confirm Off and Full correctly', async () => {
  const f = fixture()
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.model()).toBe(NATIVE)
  expect(f.ownership).toEqual([true])
  expect(f.confirmations).toEqual([{ permissionDecision: 'allow' }])
  expect(await loadPreferences(f.engine, 'selection-chat')).toEqual(defaults)

  f.preferences({ ...defaults, enabled: true })
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.model()).toBe(FULL)
  expect(f.selected).toEqual([NATIVE, FULL])
  expect(f.confirmations).toEqual([{ permissionDecision: 'allow' }, { permissionDecision: 'allow' }])
  expect(await loadPreferences(f.engine, 'selection-chat')).toEqual({ ...defaults, enabled: true })
  cancelSelection()
})

test('Off and Subagent leave an already native session selected', async () => {
  const f = fixture(NATIVE)
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  f.preferences({ ...defaults, enabled: true, mode: 'subagent' })
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.model()).toBe(NATIVE)
  expect(f.calls).toEqual([])
  cancelSelection()
})

test('a newer toggle replaces a queued model switch before it reaches the host', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true })
  f.hold()
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.calls).toEqual([FULL])
  f.preferences(defaults)
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  await f.release()
  await f.fire()
  expect(f.model()).toBe(NATIVE)
  expect(f.selected).toEqual([])
  expect(f.notice()).toBe('')
  cancelSelection()
})

test('a queued switch cannot follow a session change', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true })
  f.hold()
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  f.move('resumed-chat')
  await f.release()
  expect(f.model()).toBe(NATIVE)
  expect(f.selected).toEqual([])
  expect(f.notice()).toBe('')
  cancelSelection()
})

test('manual model selection cancels a queued automatic switch', async () => {
  for (const target of ['claude-sonnet-4-6', FULL]) {
    const f = fixture(NATIVE, { ...defaults, enabled: true })
    f.hold()
    scheduleSelection(f.engine, 'selection-chat')
    await f.fire()
    await f.manual(target)
    await f.release()
    expect(f.model()).toBe(target)
    expect(f.selected).toEqual([target])
    expect(f.ownership).toEqual([false])
    expect(f.confirmations[0]).toEqual({})
    expect(f.pendingTimers()).toBe(0)
    cancelSelection()
  }
})

test('cancellation while the command gate reads the session still prevents selection', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true }, true)
  f.hold()
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  let release!: () => void
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const original = f.engine.session.id
  let first = true
  f.engine.session.id = async () => {
    if (first) { first = false; entered(); await paused }
    return original()
  }
  const completing = f.release()
  await reading
  cancelSelection()
  release()
  await completing
  expect(f.model()).toBe(NATIVE)
  expect(f.selected).toEqual([])
  cancelSelection()
})

test('denied and nonzero native commands leave one notice without retrying', async () => {
  for (const outcome of ['denied', 'nonzero'] as const) {
    const f = fixture()
    f.fail(outcome)
    scheduleSelection(f.engine, 'selection-chat')
    await f.fire()
    expect(f.model()).toBe(FULL)
    expect(f.calls).toEqual([NATIVE])
    expect(f.notice()).toBe('The model switch did not finish. Choose a model with /model or select the use setting again to retry.')
    expect(f.pendingTimers()).toBe(0)
    cancelSelection()
  }
})

test('external model switches keep their existing confirmation decision', async () => {
  const f = fixture()
  const result = { permissionDecisionReason: 'Keep the native confirmation' }
  const event = { session_id: 'selection-chat', from_model: FULL, to_model: NATIVE, requested_model: NATIVE, source: 'picker' } as ClassicHookInputs['PreModelSwitch']
  expect(await confirmSelection(f.engine, event, (async () => result) as unknown as ConfirmNext)).toEqual(result)
  await f.manual(NATIVE)
  expect(f.confirmations).toEqual([{}])
  cancelSelection()
})

test('our requested switch preserves downstream asks, denials, and stops', async () => {
  for (const result of [
    { permissionDecision: 'ask', permissionDecisionReason: 'Confirm with the administrator' },
    { permissionDecision: 'deny', permissionDecisionReason: 'Model is restricted' },
    { block: 'Switch blocked by policy' },
    { preventContinuation: true, stopReason: 'Stop this session' },
  ] as ClassicResult[]) {
    const f = fixture()
    f.confirmation(result)
    scheduleSelection(f.engine, 'selection-chat')
    await f.fire()
    expect(f.confirmations).toEqual([result])
    expect(f.model()).toBe(FULL)
    expect(f.pendingTimers()).toBe(0)
    cancelSelection()
  }
})

test('failure keeps the requested settings and exposes the actual host until retry succeeds', async () => {
  const desired = { ...defaults, enabled: true }
  const f = fixture(NATIVE, desired)
  f.fail('nonzero')
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.state().selection).toEqual({ target: FULL, current: '', status: 'failed' })
  expect(await loadPreferences(f.engine, 'selection-chat')).toEqual(desired)
  f.fail('ok')
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.model()).toBe(FULL)
  expect(f.state().selection).toBeUndefined()
  expect(f.notice()).toBe('')
  cancelSelection()
})

test('a successful switch waits for Desktop to publish the session model', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true })
  let visibleModel = NATIVE
  f.engine.session.model = async () => visibleModel
  f.engine.clock.sleep = async () => {
    expect(f.state().selection?.status).toBe('pending')
    visibleModel = f.model()
  }
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.selected).toEqual([FULL])
  expect(f.calls).toEqual([FULL])
  expect(f.state().selection).toBeUndefined()
  expect(f.notice()).toBe('')
  cancelSelection()
})

test('editing the full model replaces a queued switch with the latest model', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true })
  f.hold()
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  f.preferences({ ...defaults, enabled: true, full: WORKER })
  scheduleSelection(f.engine, 'selection-chat')
  await f.release()
  await f.fire()
  expect(f.model()).toBe(WORKER)
  expect(f.selected).toEqual([WORKER])
  cancelSelection()
})


test('worker, automatic, resume and stale main events do not cancel a queued explicit main switch', async () => {
  let post!: Hook<'classic.PostModelSwitch'>
  register(((name: string, ...args: unknown[]) => {
    if (name === 'classic.PostModelSwitch') post = args.at(-1) as typeof post
  }) as unknown as Parameters<Register>[0], {} as Parameters<Register>[1])
  for (const event of [
    { agent_id: 'worker', source: 'command', to_model: NATIVE },
    { source: 'auto', to_model: NATIVE },
    { source: 'resume', to_model: NATIVE },
    { source: 'picker', to_model: 'claude-sonnet-4-6' },
  ]) {
    const f = fixture(NATIVE, { ...defaults, enabled: true })
    f.hold()
    scheduleSelection(f.engine, 'selection-chat')
    await f.fire()
    await post(f.engine, { session_id: 'selection-chat', from_model: NATIVE, requested_model: event.to_model, ...event } as ClassicHookInputs['PostModelSwitch'], (async () => ({})) as unknown as Parameters<Hook<'classic.PostModelSwitch'>>[2])
    await f.release()
    expect(f.model()).toBe(FULL)
    expect(f.ownership).toEqual([true])
    cancelSelection()
  }
})

test('native model to Ollama then Subagents Only restores native while retaining worker settings', async () => {
  const f = fixture(NATIVE)
  await f.manual(FULL)
  await modelSwitched(f.engine, { session_id: 'selection-chat', from_model: NATIVE, to_model: FULL, requested_model: FULL, source: 'command' } as ClassicHookInputs['PostModelSwitch'])
  expect(await loadPreferences(f.engine, 'selection-chat')).toMatchObject({ enabled: true, mode: 'full', full: FULL })
  await savePreference(f.engine, 'selection-chat', 'mode', 'subagent')
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.model()).toBe(NATIVE)
  expect(await loadPreferences(f.engine, 'selection-chat')).toMatchObject({ enabled: true, mode: 'subagent', full: FULL, subagent: WORKER })
  cancelSelection()
})


test('an idle automatic main switch reconciles the saved choice without publishing new preferences', async () => {
  let post!: Hook<'classic.PostModelSwitch'>
  register(((name: string, ...args: unknown[]) => {
    if (name === 'classic.PostModelSwitch') post = args.at(-1) as typeof post
  }) as unknown as Parameters<Register>[0], {} as Parameters<Register>[1])
  const desired = { ...defaults, enabled: true }
  const f = fixture(NATIVE, desired)
  await post(f.engine, { session_id: 'selection-chat', from_model: FULL, to_model: NATIVE, requested_model: null, source: 'auto' } as ClassicHookInputs['PostModelSwitch'], (async () => ({})) as unknown as Parameters<Hook<'classic.PostModelSwitch'>>[2])
  await f.fire()
  expect(f.model()).toBe(FULL)
  expect(await loadPreferences(f.engine, 'selection-chat')).toEqual(desired)
  cancelSelection()
})


test('an unavailable Ollama target never emits a synthetic successful native model command', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true, full: 'missing:cloud' })
  f.metadataStatus(404)
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  expect(f.calls).toEqual([])
  expect(f.state().selection?.status).toBe('failed')
  expect(f.model()).toBe(NATIVE)
  expect(f.notice().includes('/model')).toBe(true)
  cancelSelection()
})

test('inference cancels a startup switch awaiting metadata before it can mask the turn error', async () => {
  const f = fixture(NATIVE, { ...defaults, enabled: true })
  f.holdMetadata()
  scheduleSelection(f.engine, 'selection-chat')
  await f.fire()
  const error = new Error('Synthetic inference failure')
  const stream = executionStep(f.engine, { turnId: 'selection-error', index: 0, model: NATIVE, messageCount: 1 },
    (async function* () { throw error }) as unknown as Parameters<Hook<'turn.step'>>[2])
  const result = stream.next().catch(caught => caught)
  await settle()
  f.releaseMetadata()
  expect(await result).toBe(error)
  await settle()
  expect(f.calls).toEqual([])
  expect(f.model()).toBe(NATIVE)
  expect(f.state().selection).toBeUndefined()
  cancelSelection()
})
