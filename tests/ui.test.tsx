import { expect, mock, test } from 'claude-code/testing'
import type { Hook, On } from 'claude-code'
import type { UIState } from '../hooks/ui'
import { cancelSelection } from '../hooks/selection'

const initial: UIState = {
  preferences: { enabled: true, mode: 'full', full: 'first', subagent: 'second', fullEffort: 'high', subagentEffort: 'on' },
  models: [
    { name: 'first', isCloud: false, isDecision: false, contextLength: 8192, efforts: ['low', 'high'] },
    { name: 'second', isCloud: false, isDecision: false, contextLength: 8192, efforts: ['off', 'on'] },
    { name: 'decider', isCloud: false, isDecision: true, contextLength: 8192, efforts: [] },
  ],
  connected: true, endpoint: 'http://localhost:11434', settingsOpen: false, notice: '',
}
const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} }

function setup(on: On, initialState = initial) {
  cancelSelection()
  let state = structuredClone(initialState)
  let sessionId = 'ui-test'
  let connectionRead: (() => Promise<unknown>) | undefined
  let failedStoreKey = ''
  const values = new Map<string, unknown>([['preferences:ui-test', { version: 1, value: state.preferences }], ['connection-v1', state.endpoint]])
  values.set(`model-discovery-v1:${encodeURIComponent(state.endpoint)}`, state.models.filter(model => !model.isDecision))
  const writes: string[] = []
  const processes: Parameters<Hook<'process.run'>>[1][] = []
  const clock = mock.clock(on)
  let fetch: Hook<'http.fetch'> = () => { throw new Error('Offline fixture') }
  on('http.fetch', ($, e, next) => fetch($, e, next))
  on('process.run', (_, e) => {
    processes.push(e)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: sessionId }))
  on('env.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [{ key: 'ollama.modelCatalog', label: 'Model catalog', kind: 'text' as const, value: '[]', provider: { plugin: 'ollama', tier: 'user' as const }, isLocked: false }] }))
  on('state.get', async (_, e, next) => {
    const result = await next(e)
    if (e.key === 'activity' && state.activity) return { value: { value: { shape: 'activity-v1', value: state.activity }, version: result.value?.version ?? 0 } }
    return e.key === 'view' ? { value: { value: { shape: 'view-v1', value: state }, version: result.value?.version ?? 0 } } : result
  })
  on('state.set', async (_, e, next) => {
    const result = await next(e)
    if (e.key === 'view' && result.value?.isSet) state = structuredClone(e.value.value)
    if (e.key === 'activity' && result.value?.isSet) state.activity = structuredClone(e.value.value)
    return result
  })
  on('store.get', async (_, e) => ({ value: e.key === 'connection-v1' && connectionRead ? await connectionRead() : values.get(e.key) }))
  on('store.delete', (_, e) => { values.delete(e.key); return { value: undefined } })
  on('store.set', (_, e) => {
    if (e.key === failedStoreKey) throw new Error('Cannot save defaults')
    writes.push(e.key)
    values.set(e.key, e.value)
    return { value: undefined }
  })
  return {
    writes, values, clock, processes,
    http: (handler: Hook<'http.fetch'>) => { fetch = handler },
    session: (id: string) => { sessionId = id },
    connection: (read: () => Promise<unknown>) => { connectionRead = read },
    state: () => state,
    resetState: () => { state = { ...state, models: [], connected: false, endpoint: '' } },
    failStore: (key: string) => { failedStoreKey = key },
  }
}

test('opening either picker shares cached discovery and refreshes native rows when it expires', async ($, on) => {
  const f = setup(on, { ...initial, endpoint: 'http://picker-refresh:11434' })
  let name = 'released-model'
  let requests = 0
  f.http((_, e) => {
    requests++
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/tags')
      ? { models: [{ name, capabilities: ['tools'] }] }
      : { capabilities: ['tools'] }) } }
  })
  on('settings.read', () => ({ value: {} }))
  on('config.set', (_, e) => ({ value: e.value }))
  on('command.run', { command: 'model' }, () => ({ text: '' }))
  const openNative = () => $.command.run({ command: 'model', args: '', origin: { kind: 'composer' } } as Parameters<typeof $.command.run>[0])
  await openNative()
  expect(f.state().models.map(model => model.name)).toEqual(['released-model', 'released-model:cloud'])
  expect(f.processes).toHaveLength(1)
  expect(JSON.parse(f.processes[0]!.init!.stdin!).models).toEqual(f.state().models)
  const before = requests
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'terminal', component: 'AbovePrompt', requestId: 'refresh', props })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'model' })
  await f.clock.settle()
  expect(await ui.find({ key: 'model-option-released-model' })).toBeDefined()
  expect(requests).toBe(before)
  expect(f.processes).toHaveLength(1)
  await f.clock.advance(300000)
  name = 'new-release'
  await openNative()
  expect(f.state().models.map(model => model.name)).toEqual(['new-release', 'new-release:cloud'])
  expect(f.processes).toHaveLength(2)
  expect(JSON.parse(f.processes[1]!.init!.stdin!).models).toEqual(f.state().models)
  expect(f.values.has('preference-defaults-v1')).toBe(false)
  await ui.unmount()
})

test('desktop: selecting a mode uses its model and effort, and off restores Claude', async ($, on) => {
  const { values } = setup(on)
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'bar', props })
  await ui.press({ key: 'settings' })
  expect((await ui.find({ key: 'model' }))?.props).toMatchObject({ label: 'Model: First ▾' })
  expect((await ui.find({ key: 'effort' }))?.props).toMatchObject({ value: 'high', options: [{ value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] })
  await ui.select({ key: 'mode', value: 'subagent' })
  expect(await ui.find({ type: 'Text', text: 'Claude runs this chat. Ollama runs eligible subagents.' })).toBeUndefined()
  expect(values.get('preferences:ui-test:mode')).toEqual({ version: 1, value: 'subagent' })
  expect((await ui.find({ key: 'model' }))?.props).toMatchObject({ label: 'Model: Second ▾' })
  expect((await ui.find({ key: 'effort' }))?.props).toMatchObject({ value: 'on' })
  await ui.press({ key: 'model' })
  await ui.press({ key: 'model-option-first' })
  await ui.select({ key: 'effort', value: '' })
  expect(values.get('preferences:ui-test:subagent')).toEqual({ version: 1, value: 'first' })
  expect(values.get('preferences:ui-test:subagentEffort')).toEqual({ version: 1, value: null })
  await ui.select({ key: 'mode', value: 'never' })
  expect(await ui.find({ type: 'Text', text: 'Off · Claude runs this chat and its subagents.' })).toBeUndefined()
  expect(values.get('preferences:ui-test:enabled')).toEqual({ version: 1, value: false })
  await ui.unmount()
})

test('connection is disclosed on demand and saves only on Enter', async ($, on) => {
  const { writes, values, http } = setup(on)
  http( () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'terminal', component: 'AbovePrompt', requestId: 'connection', props })
  expect(await ui.find({ key: 'endpoint' })).toBeUndefined()
  await ui.press({ key: 'settings' })
    await ui.press({ key: 'advanced' })
  expect((await ui.find({ key: 'endpoint' }))?.props).toMatchObject({ value: initial.endpoint, submitLabel: '' })
  expect(await ui.find({ type: 'Text', text: 'Connected' })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  await ui.input({ key: 'endpoint', text: 'ftp://invalid', kind: 'change' })
  expect(writes).toEqual([])
  await ui.input({ key: 'endpoint', text: 'ftp://invalid' })
  expect(writes).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Use an HTTP or HTTPS Ollama address without credentials.' })).toBeDefined()
  expect(values.get('connection-v1')).toBe(initial.endpoint)
  await ui.input({ key: 'endpoint', text: 'http://host:11434' })
  expect(values.get('connection-v1')).toBe('http://host:11434')
  expect(await ui.find({ type: 'Text', text: 'Connected' })).toBeUndefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('native new alias keeps chat preferences and rediscovers connection after the view resets', async ($, on) => {
  const fixture = setup(on)
  fixture.values.set('connection-v1', 'http://saved-ollama:11434')
  fixture.values.set('preference-defaults-v1', { version: 1, value: { ...initial.preferences, mode: 'subagent', subagent: 'other-chat-default' } })
  const requested: string[] = []
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('command.run', { command: 'clear' }, async () => {
    await $.session.end({ sessionId: 'ui-test', reason: 'clear', resume: { id: 'ui-test' } })
    fixture.session('after-new')
    fixture.resetState()
    return { text: '' }
  })
  fixture.http((_, e) => {
    requested.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: e.url.endsWith('/api/tags')
      ? JSON.stringify({ models: [{ name: 'first' }, { name: 'second' }] })
      : JSON.stringify({ capabilities: ['tools'], thinking: { values: ['low', 'high'] } }) } }
  })
  on('settings.read', () => ({ value: {} }))
  on('config.set', (_, e) => ({ value: e.value }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.prompt.submit({ text: 'Hello before clearing', wait: false, origin: { kind: 'composer' } })
  // Installed Claude resolves /new to its canonical clear command. No
  // session.start follows it; the classic clear lifecycle fires instead.
  await $.command.run({ command: 'clear', args: '' } as Parameters<typeof $.command.run>[0])
  await $.classic.SessionStart({ source: 'clear', session_id: 'after-new' })
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'cleared', props })
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await ui.press({ key: 'settings' })
  expect(fixture.values.get('preferences:after-new')).toEqual({ version: 1, value: initial.preferences })
  expect(fixture.state().notice).toBe('')
  expect(requested).toContain('http://saved-ollama:11434/api/tags')
  expect(fixture.state().connected).toBe(true)
  expect((await ui.find({ key: 'mode' }))?.props).toMatchObject({ value: 'full' })
  expect((await ui.find({ key: 'model' }))?.props).toMatchObject({ label: 'Model: First ▾' })
  expect((await ui.find({ key: 'effort' }))?.props).toMatchObject({ value: 'high' })
  expect(fixture.state().endpoint).toBe('http://saved-ollama:11434')
  await ui.unmount()
})

test('a control drawn in the previous chat cannot change the resumed chat', async ($, on) => {
  const fixture = setup(on)
  const resumed = { ...initial.preferences, enabled: false, mode: 'subagent', subagent: 'resumed-model' }
  fixture.values.set('preferences:resumed', { version: 1, value: resumed })
  const old = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'old-chat', props })
  await old.press({ key: 'settings' })
  await old.press({ key: 'model' })
  fixture.session('resumed')
  await old.press({ key: 'model-option-second' })
  expect(fixture.values.get('preferences:ui-test:full')).toEqual({ version: 1, value: 'second' })
  expect(fixture.values.get('preferences:resumed')).toEqual({ version: 1, value: resumed })
  expect(fixture.values.has('preferences:resumed:full')).toBe(false)
  const current = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'resumed-chat', props })
  if (!await current.find({ key: 'settings-panel' })) await current.press({ key: 'settings' })
  if (await current.find({ key: 'model-search' })) await current.press({ key: 'model' })
  expect((await current.find({ key: 'mode' }))?.props).toMatchObject({ value: 'never' })
  expect((await current.find({ key: 'model' }))?.props).toMatchObject({ label: 'Model: resumed-model (unavailable) ▾' })
  await old.unmount()
  await current.unmount()
})

test('a slow connection refresh cannot replace a newer mode choice', async ($, on) => {
  const fixture = setup(on, { ...initial, settingsOpen: true, connected: false })
  let release!: (value: unknown) => void
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const connection = new Promise<unknown>(resolve => { release = resolve })
  fixture.connection(() => { reached(); return connection })
  fixture.http(() => ({ value: { status: 200, ok: true, headers: {}, text: '{"models":[]}' } }))
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'refresh-race', props })
  await ui.press({ key: 'advanced' })
  const refresh = ui.press({ key: 'refresh' })
  await waiting
  await ui.select({ key: 'mode', value: 'subagent' })
  release('http://localhost:11434')
  await refresh
  expect(fixture.state().preferences.mode).toBe('subagent')
  expect(fixture.values.get('preferences:ui-test:mode')).toEqual({ version: 1, value: 'subagent' })
  expect((await ui.find({ key: 'mode' }))?.props).toMatchObject({ value: 'subagent' })
  await ui.unmount()
})


test('a committed chat change stays visible when publishing new-chat defaults fails', async ($, on) => {
  const fixture = setup(on)
  const defaults = { version: 1, value: initial.preferences }
  fixture.values.set('preference-defaults-v1', defaults)
  fixture.failStore('preference-defaults-v1')
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'partial-default-save', props })
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'mode', value: 'never' })
  expect(fixture.values.get('preferences:ui-test:enabled')).toEqual({ version: 1, value: false })
  expect(fixture.values.get('preference-defaults-v1')).toEqual(defaults)
  expect(fixture.state().preferences.enabled).toBe(false)
  expect(await ui.find({ type: 'Text', text: 'Off · Claude runs this chat and its subagents.' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Saved this chat, but could not update defaults for new chats. Previous defaults are unchanged; try saving again.' })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: one usage selector enables either mode and Never preserves both choices`, async ($, on) => {
    const fixture = setup(on, { ...initial, connected: false, preferences: { ...initial.preferences, enabled: false } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'usage', props })
    const select = async (value: string) => {
      if (surface === 'desktop') await ui.select({ key: 'mode', value })
      else {
        await ui.press({ key: 'mode' })
        await ui.press({ key: `mode-option-${value}` })
      }
    }
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'enabled' })).toBeUndefined()
    if (surface === 'desktop') expect((await ui.find({ key: 'mode' }))?.props).toMatchObject({ value: 'never', options: [
      { value: 'never', label: 'Never' }, { value: 'subagent', label: 'Subagents Only' }, { value: 'full', label: 'Always' },
    ] })
    else expect((await ui.find({ key: 'mode' }))?.props.label).toBe('When to use Ollama: Never ▾')
    await select('subagent')
    expect(fixture.state().preferences).toMatchObject({ enabled: true, mode: 'subagent', full: 'first', subagent: 'second' })
    await select('full')
    expect(fixture.state().preferences).toMatchObject({ enabled: true, mode: 'full' })
    await select('never')
    expect(fixture.state().preferences).toEqual({ ...initial.preferences, enabled: false })
    expect(await ui.find({ type: 'Text', text: 'Claude' })).toBeDefined()
    expect(fixture.values.has('preferences:ui-test:full')).toBe(false)
    expect(fixture.values.has('preferences:ui-test:subagent')).toBe(false)
    await select('full')
    expect(fixture.state().preferences).toEqual(initial.preferences)
    await ui.unmount()
  })

  test(`${surface}: settings open without saving preferences and close to a compact bar`, async ($, on) => {
    const { writes } = setup(on, { ...initial, modelWindow: { model: 'first', endpoint: initial.endpoint, effective: 16384, override: 16384, source: 'manual' },
      activity: { owner: 'ui-test', hidden: false, subagents: [], ollama: { requests: 12, inputTokens: 84260, outputTokens: 1234 } },
    })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'disclosure', props })
    expect(await ui.find({ key: 'settings-panel' })).toBeUndefined()
    expect(await ui.find({ key: 'model' })).toBeUndefined()
    expect(await ui.find({ key: 'actual-model' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'advanced' })
    expect(await ui.find({ type: 'Text', text: 'Ollama · 12 requests · 84,260 input tokens · 1,234 output tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Last response: last-model' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Ollama runs this chat and its subagents.' })).toBeUndefined()
    expect(await ui.find({ key: 'model' })).toBeDefined()
    expect(await ui.find({ key: 'endpoint' })).toBeDefined()
    expect((await ui.find({ key: `context-${initial.endpoint}-first` }))?.props).toMatchObject({ label: 'Context length', value: '16384', submitLabel: surface === 'terminal' ? '' : 'Save' })
    expect((await ui.find({ key: 'endpoint' }))?.props.submitLabel).toBe(surface === 'terminal' ? '' : 'Save')
    expect(await ui.find({ type: 'Text', text: '16384 tokens · Manual' })).toBeUndefined()
    expect(writes).toEqual([])
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings-panel' })).toBeUndefined()
    expect(writes).toEqual([])
    await ui.unmount()
  })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: mode introduction collapses after sending while the quick switch remains available`, async ($, on) => {
    const fixture = setup(on)
    fixture.http(() => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    const mount = () => $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'summary-lifecycle', props })
    let ui = await mount()
    expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
    await $.prompt.submit({ text: 'Hello', wait: false, origin: { kind: surface === 'desktop' ? 'sdk' : 'composer' } })
    expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'mode' })).toBeDefined()
    if (surface === 'desktop') await ui.select({ key: 'mode', value: 'never' })
    else { await ui.press({ key: 'mode' }); await ui.press({ key: 'mode-option-never' }) }
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
    await $.prompt.submit({ text: 'Continue', wait: false, origin: { kind: surface === 'desktop' ? 'sdk' : 'composer' } })
    expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
    await ui.unmount()
    // Remount/resume retains the compact control for a setup already used in this chat.
    ui = await mount()
    expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'model' })
    await ui.unmount()
    fixture.session('new-chat')
    ui = await mount()
    expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
    expect(await ui.find({ key: 'settings-panel' })).toBeUndefined()
    expect(await ui.find({ key: 'model-search' })).toBeUndefined()
    expect((fixture.values.get('preferences:new-chat') as { value: unknown }).value).toEqual(fixture.state().preferences)
    await ui.unmount()
    fixture.session('ui-test')
    ui = await mount()
    expect(await ui.find({ key: 'mode' })).toBeDefined()
    await ui.unmount()
  })
}

test('rejected and background prompts leave the mode summary visible', async ($, on) => {
  const fixture = setup(on)
  fixture.http( () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_, e) => e.text === 'Rejected' ? { drop: 'Not accepted' } : { text: e.text })
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'summary-rejected', props })
  await $.prompt.submit({ text: 'Rejected', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await $.prompt.submit({ text: 'Background notification', wait: false, origin: { kind: 'task-notification' } })
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await $.prompt.submit({ text: 'Accepted', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await ui.unmount()
})

test('a native model picker change brings the mode summary back', async ($, on) => {
  const fixture = setup(on)
  fixture.http( () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.PostModelSwitch', () => ({}))
  on('session.model', () => ({ value: 'second' }))
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'summary-model', props })
  await $.prompt.submit({ text: 'Hello', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await $.classic.PostModelSwitch({
    session_id: 'ui-test', from_model: 'first', to_model: 'second', requested_model: 'second', source: 'picker',
  } as Parameters<typeof $.classic.PostModelSwitch>[0])
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await ui.unmount()
})

test('a setting changed while a prompt is pending stays visible when that prompt is accepted', async ($, on) => {
  const fixture = setup(on)
  fixture.http( () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  let entered!: () => void
  let accept!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const accepted = new Promise<void>(resolve => { accept = resolve })
  on('prompt.submit', async (_, e) => { entered(); await accepted; return { text: e.text } })
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'summary-pending', props })
  const submission = $.prompt.submit({ text: 'Hello', wait: false, origin: { kind: 'composer' } })
  await waiting
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'mode', value: 'never' })
  await ui.press({ key: 'settings' })
  accept()
  await submission
  expect(await ui.find({ key: 'compact-mode' })).toBeDefined()
  await ui.unmount()
})

test('terminal menus are clickable, exclusive, close on selection, and preserve per-mode choices', async ($, on) => {
  const { values, writes } = setup(on)
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'terminal', component: 'AbovePrompt', requestId: 'menus', props })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'model' })
  expect((await ui.find({ key: 'model-option-first' }))?.props).toMatchObject({ label: '✓ First' })
  expect(await ui.find({ key: 'model-option-decider' })).toBeUndefined()
  expect(await ui.find({ key: 'mode' })).toBeDefined()
  expect(await ui.find({ key: 'enabled' })).toBeUndefined()
  expect(await ui.find({ key: 'endpoint' })).toBeUndefined()
  expect(await ui.find({ key: `context-${initial.endpoint}-first` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'First' })).toBeDefined()
  await ui.press({ key: 'model' })
  expect(await ui.find({ key: 'endpoint' })).toBeUndefined()
  expect(await ui.find({ key: 'enabled' })).toBeUndefined()
  await ui.press({ key: 'mode' })
  expect(await ui.find({ key: 'enabled' })).toBeUndefined()
  expect(await ui.find({ key: 'model-options' })).toBeUndefined()
  expect(writes).toEqual([])
  await ui.press({ key: 'mode-option-subagent' })
  expect(values.get('preferences:ui-test:mode')).toEqual({ version: 1, value: 'subagent' })
  expect(await ui.find({ key: 'mode-option-subagent' })).toBeUndefined()
  expect(await ui.find({ key: 'endpoint' })).toBeUndefined()
  expect((await ui.find({ key: 'model' }))?.props).toMatchObject({ label: 'Model: Second ▾' })
  expect((await ui.find({ key: 'effort' }))?.props).toMatchObject({ label: 'Effort: On ▾' })
  await ui.press({ key: 'model' })
  await ui.press({ key: 'model-option-first' })
  await ui.press({ key: 'effort' })
  expect(await ui.find({ key: 'enabled' })).toBeUndefined()
  await ui.press({ key: 'effort-option-' })
  expect(values.get('preferences:ui-test:subagent')).toEqual({ version: 1, value: 'first' })
  expect(values.get('preferences:ui-test:subagentEffort')).toEqual({ version: 1, value: null })
  expect(await ui.find({ key: 'effort-option-' })).toBeUndefined()
  await ui.press({ key: 'mode' })
  await ui.press({ key: 'mode-option-never' })
  expect(values.get('preferences:ui-test:enabled')).toEqual({ version: 1, value: false })
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: one model opener shows real results with the selected choice marked`, async ($, on) => {
    const models = Array.from({ length: 24 }, (_, i) => ({ name: `model-${i}`, isCloud: false, isDecision: false, contextLength: 8192, efforts: [] }))
    const { writes, values } = setup(on, { ...initial, models, preferences: { ...initial.preferences, full: 'model-23' } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'scroll', props: { ...props, maxRows: 10 } })
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'model' })
    expect((await ui.find({ key: 'model-option-model-23' }))?.props).toMatchObject({ label: '✓ Model 23' })
    expect((await ui.find({ key: 'model-search' }))?.props).toMatchObject({ submitLabel: surface === 'terminal' ? '' : 'Search' })
    expect(await ui.find({ key: 'model-options' })).toBeUndefined()
    expect(writes).toEqual([])
    await ui.press({ key: 'model-option-model-22' })
    expect(values.get('preferences:ui-test:full')).toEqual({ version: 1, value: 'model-22' })
    expect(await ui.find({ key: 'model-option-model-22' })).toBeUndefined()
    await ui.unmount()
  })
}

test('large catalogs remain bounded and can be browsed without knowing a model name', async ($, on) => {
  const models = Array.from({ length: 1000 }, (_, i) => ({ name: `model-${i}`, isCloud: false, isDecision: false, contextLength: 8192, efforts: [] }))
  const { writes, values } = setup(on, { ...initial, models, preferences: { ...initial.preferences, full: 'model-0' } })
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'terminal', component: 'AbovePrompt', requestId: 'large', props })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'model' })
  expect((await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('model-option-')).length).toBe(18)
  for (let i = 0; i < 3; i++) await ui.press({ key: 'model-scroll-down' })
  expect(await ui.find({ key: 'model-option-model-0' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('model-option-')).length).toBe(18)
  await ui.press({ key: 'model-scroll-up' })
  expect(writes).toEqual([])
  await ui.input({ key: 'model-search', text: 'model-' })
  expect(writes).toEqual([])
  await ui.input({ key: 'model-search', text: 'model-999' })
  expect(values.get('preferences:ui-test:full')).toEqual({ version: 1, value: 'model-999' })
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: model search filters while typing and saves only a chosen model`, async ($, on) => {
    const models = ['kimi-k3:cloud', 'kimi-k3.1-pro:cloud', 'glm-5.3:cloud'].map(name => ({ ...initial.models[0]!, name, isCloud: true }))
    const { writes, values } = setup(on, { ...initial, models, preferences: { ...initial.preferences, full: 'glm-5.3:cloud' } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'search', props })
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'model-search' })).toBeUndefined()
    await ui.press({ key: 'model' })
    await ui.input({ key: 'model-search', text: 'KIMI' })
    expect(writes).toEqual([])
    expect(await ui.find({ key: 'model-search' })).toBeDefined()
    await ui.input({ key: 'model-search', text: 'KIMI pro', kind: 'change' })
    expect((await ui.find({ key: 'model-search' }))?.props.submitLabel).toBe(surface === 'terminal' ? '' : 'Use model')
    expect(await ui.find({ key: 'model-option-kimi-k3.1-pro:cloud' })).toBeDefined()
    expect(await ui.find({ key: 'model-option-kimi-k3:cloud' })).toBeUndefined()
    expect(writes).toEqual([])
    await ui.input({ key: 'model-search', text: 'no-such-model', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: 'No models found' })).toBeDefined()
    await ui.input({ key: 'model-search', text: 'no-such-model' })
    expect(writes).toEqual([])
    await ui.input({ key: 'model-search', text: 'kimi-k3.1-pro:cloud' })
    expect(values.get('preferences:ui-test:full')).toEqual({ version: 1, value: 'kimi-k3.1-pro:cloud' })
    expect(await ui.find({ key: 'model-search' })).toBeUndefined()
    await ui.press({ key: 'model' })
    expect((await ui.find({ key: 'model-search' }))?.props).toMatchObject({ value: '' })
    expect(await ui.find({ key: 'model-option-glm-5.3:cloud' })).toBeDefined()
    await ui.unmount()
  })
}

test('/ollama opens settings without changing saved preferences or toggling closed', async ($, on) => {
  const { writes, state } = setup(on)
  const result = await $.command.run({ command: 'ollama', args: '' } as Parameters<typeof $.command.run>[0])
  expect(result.text).toBe('')
  expect(state().settingsOpen).toBe(true)
  await $.command.run({ command: 'ollama', args: '' } as Parameters<typeof $.command.run>[0])
  expect(state().settingsOpen).toBe(true)
  expect(writes).toEqual([])
})

test('context edits apply to their model without publishing chat defaults or leaking into another model', async ($, on) => {
  const f = setup(on, { ...initial, modelWindow: { model: 'first', endpoint: initial.endpoint, effective: 32768, source: 'parameters' } })
  f.http((_, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/ps')
    ? { models: [] }
    : { capabilities: ['tools'], parameters: 'num_ctx 32768', model_info: { 'test.context_length': 65536 } }) } }))
  const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: 'context-edit', props })
  await ui.press({ key: 'settings' })
    await ui.press({ key: 'advanced' })
  const key = `context-${initial.endpoint}-first`
  expect((await ui.find({ key }))?.props.value).toBe('32768')
  await ui.input({ key, text: '32768' })
  expect(f.writes).toEqual([])
  await ui.input({ key, text: '16384' })
  expect((await ui.find({ key }))?.props.value).toBe('16384')
  expect(await ui.find({ type: 'Text', text: '16384 tokens · Manual' })).toBeUndefined()
  expect(f.values.has('preference-defaults-v1')).toBe(false)
  expect(f.writes.every(value => value.startsWith('context-override-v1:'))).toBe(true)
  await ui.input({ key, text: '' })
  expect((await ui.find({ key }))?.props.value).toBe('32768')
  await ui.press({ key: 'model' })
  await ui.press({ key: 'model-option-second' })
  await ui.press({ key: 'advanced' })
  expect((await ui.find({ key: `context-${initial.endpoint}-second` }))?.props.value).not.toBe('16384')
  expect(await ui.find({ type: 'Text', text: '16384 tokens · Manual' })).toBeUndefined()
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: compact mode preserves power and hides stats from a different target`, async ($, on) => {
    const fixture = setup(on, { ...initial, activity: {
      owner: 'ui-test', hidden: false, subagents: [],
      main: { target: 'first', model: 'deepseek-v4.1-flash:1017-cloud', tokens: 800, tokensPerSecond: 43.267, running: false },
    } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'compact-identity', props })
    expect(await ui.find({ type: 'Text', text: 'DeepSeek v4.1 Flash (1017)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· 43.3 tok/s' })).toBeDefined()
    expect(await ui.find({ key: 'enabled' })).toBeUndefined()
    if (surface === 'desktop') {
      expect((await ui.find({ key: 'compact-mode' }))?.props).toMatchObject({ label: 'When to use Ollama', options: [{ value: 'never', label: 'Never' }, { value: 'subagent', label: 'Subagents Only' }, { value: 'full', label: 'Always' }] })
      await ui.select({ key: 'compact-mode', value: 'subagent' })
    }
    else {
      expect((await ui.find({ key: 'compact-mode' }))?.props.label).toBe('When to use Ollama: Always ▾')
      await ui.press({ key: 'compact-mode' })
      expect(await ui.find({ key: 'compact-mode-option-off' })).toBeUndefined()
      await ui.press({ key: 'compact-mode-option-subagent' })
    }
    expect(fixture.state().preferences.enabled).toBe(true)
    expect(fixture.state().preferences.full).toBe('first')
    expect(await ui.find({ type: 'Text', text: 'Claude' })).toBeDefined()
    expect(await ui.find({ key: 'summary-speed' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    if (surface === 'desktop') await ui.select({ key: 'mode', value: 'never' })
    else { await ui.press({ key: 'mode' }); await ui.press({ key: 'mode-option-never' }) }
    expect(await ui.find({ type: 'Text', text: 'Claude' })).toBeDefined()
    expect(await ui.find({ key: 'summary-speed' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: native Opus version and real speed appear while Ollama is off`, async ($, on) => {
    setup(on, { ...initial, preferences: { ...initial.preferences, enabled: false }, activity: {
      owner: 'ui-test', hidden: false, subagents: [],
      main: { target: '', model: 'claude-opus-5-5', tokens: 1200, tokensPerSecond: 32, running: false },
    } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'native-identity', props })
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· 32 tok/s' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: subagent rows use confirmed tokens, prioritize running work, and expand without saving preferences`, async ($, on) => {
    const fixture = setup(on, { ...initial, activity: {
      owner: 'ui-test', hidden: false,
      subagents: [
        { id: 'old', model: 'first', task: 'Old task', tokens: 10, running: false },
        { id: 'older', model: 'first', task: 'Older task', tokens: 20, running: false },
        { id: 'done', model: 'claude-opus-5-5', task: 'Completed task', tokens: 1200, running: false },
        { id: 'failed', model: 'first', task: 'Canceled task', tokens: 75, running: false, failed: true },
        { id: 'running', model: 'second', task: 'Current task', tokens: 123, running: true },
        { id: 'running2', model: 'first', task: 'Other current task', tokens: 0, running: true },
      ],
    } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: 'agents', props })
    expect(await ui.find({ key: 'subagent-old' })).toBeUndefined()
    expect(await ui.find({ key: 'subagent-older' })).toBeUndefined()
    expect(await ui.find({ key: 'subagent-done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1.2k tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '123 tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0 tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Stopped' })).toBeDefined()
    expect(await ui.find({ key: 'status-running' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '+2 done' })).toBeDefined()
    await ui.press({ key: 'subagents-toggle' })
    expect(await ui.find({ key: 'subagent-running' })).toBeUndefined()
    expect(await ui.find({ key: 'subagents-left' })).toBeUndefined()
    expect((await ui.find({ key: 'subagents-toggle' }))?.props).toMatchObject({ label: '6 subagents ▸' })
    await ui.press({ key: 'subagents-toggle' })
    expect(await ui.find({ key: 'subagent-running' })).toBeDefined()
    expect(fixture.writes).toEqual([])
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'subagent-running' })).toBeUndefined()
    await ui.unmount()
  })
}

test('/ollama off preserves explicit model choices and selecting a mode enables them again', async ($, on) => {
  const fixture = setup(on)
  await $.command.run({ command: 'ollama', args: 'off' } as Parameters<typeof $.command.run>[0])
  expect(fixture.state().preferences).toEqual({ ...initial.preferences, enabled: false })
  await $.command.run({ command: 'ollama', args: 'subagent' } as Parameters<typeof $.command.run>[0])
  expect(fixture.state().preferences).toEqual({ ...initial.preferences, mode: 'subagent' })
})

for (const status of ['pending', 'failed'] as const) {
  test(`${status} main switches show the actual native model, not the requested Ollama model`, async ($, on) => {
    setup(on, { ...initial, selection: { target: 'first', current: '', status }, activity: {
      owner: 'ui-test', hidden: false, subagents: [], main: { target: '', model: 'claude-opus-5-5', tokens: 0, running: false },
    } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface: 'desktop', component: 'AbovePrompt', requestId: `switch-${status}`, props })
    expect(await ui.find({ type: 'Text', text: `Opus 5.5 · ${status === 'pending' ? 'Switching…' : 'Switch failed'}` })).toBeDefined()
    await ui.unmount()
  })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: narrow settings keep primary controls and Done visible while advanced details stay optional`, async ($, on) => {
    const failure = 'Ollama request failed. Choose another model and try again.'
    const f = setup(on, { ...initial, notice: failure, preferences: { ...initial.preferences, enabled: false }, activity: {
      owner: 'ui-test', hidden: false, subagents: [],
      main: { target: '', model: 'claude-opus-5-5', effort: 'high', tokens: 1200, tokensPerSecond: 32, running: true },
    } })
    on('settings.read', () => ({ value: {} }))
    on('config.set', (_, e) => ({ value: e.value }))
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: `narrow-settings-${surface}`,
      props: { ...props, maxRows: 10, bodyColumns: 60 } })
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· High' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· 32 tok/s' })).toBeDefined()
    await ui.press({ key: 'settings' })
    expect((await ui.find({ key: 'settings' }))?.props.label).toBe('Done')
    expect(await ui.find({ key: 'mode' })).toBeDefined()
    expect(await ui.find({ key: 'endpoint' })).toBeUndefined()
    expect(await ui.find({ key: 'ollama-usage' })).toBeUndefined()
    await ui.press({ key: 'model' })
    expect(await ui.find({ key: 'mode' })).toBeDefined()
    expect((await ui.find({ key: 'settings' }))?.props.label).toBe('Done')
    expect(f.state().notice).toBe(failure)
    expect(await ui.find({ type: 'Text', text: failure })).toBeDefined()
    await ui.press({ key: 'model' })
    await ui.press({ key: 'advanced' })
    expect(await ui.find({ key: 'endpoint' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ollama · 0 requests · 0 input tokens · 0 output tokens' })).toBeDefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'settings-panel' })).toBeUndefined()
    expect(f.state().notice).toBe(failure)
    expect(await ui.find({ type: 'Text', text: failure })).toBeDefined()
    expect(f.writes.filter(key => key.startsWith('preferences:') || key === 'preference-defaults-v1')).toEqual([])
    await ui.unmount()
  })

  test(`${surface}: short activity area reserves space for overflow and keeps workers collapsible`, async ($, on) => {
    const f = setup(on, { ...initial, activity: {
      owner: 'ui-test', hidden: false, subagents: Array.from({ length: 7 }, (_, i) => ({ id: `worker-${i}`, model: 'second', task: `Task ${i}`, tokens: i, running: true })),
    } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: `short-workers-${surface}`,
      props: { ...props, maxRows: 6, bodyColumns: 60 } })
    expect(await ui.find({ key: 'subagent-worker-2' })).toBeDefined()
    expect(await ui.find({ key: 'subagent-worker-3' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '+4 more' })).toBeDefined()
    await ui.press({ key: 'subagents-toggle' })
    expect(await ui.find({ key: 'subagent-worker-0' })).toBeUndefined()
    expect(f.writes).toEqual([])
    await ui.unmount()
  })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: used chats retain a compact mode action without the introductory label`, async ($, on) => {
    setup(on)
    on('prompt.submit', (_, e) => ({ text: e.text }))
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: `quick-mode-${surface}`, props })
    await $.prompt.submit({ text: 'Hello', wait: false, origin: { kind: 'composer' } })
    if (surface === 'desktop') {
      expect((await ui.find({ key: 'compact-mode' }))?.props.label).toBe('')
      await ui.select({ key: 'compact-mode', value: 'never' })
    } else {
      expect((await ui.find({ key: 'compact-mode' }))?.props.label).toBe('Always ▾')
      await ui.press({ key: 'compact-mode' })
      await ui.press({ key: 'compact-mode-option-never' })
    }
    await ui.unmount()
  })

  test(`${surface}: failed model switches expose a retry that preserves the requested models`, async ($, on) => {
    const f = setup(on, { ...initial, selection: { target: 'first', current: '', status: 'failed' } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: `retry-switch-${surface}`, props })
    expect((await ui.find({ key: 'retry-switch' }))?.props.label).toBe('Retry')
    await ui.press({ key: 'retry-switch' })
    expect(f.state().preferences).toEqual(initial.preferences)
    expect(f.values.get('preferences:ui-test:mode')).toEqual({ version: 1, value: 'full' })
    expect(f.values.has('preferences:ui-test:full')).toBe(false)
    expect(f.values.has('preferences:ui-test:subagent')).toBe(false)
    await ui.unmount()
  })

  test(`${surface}: unconfirmed workers show Starting while confirmed native workers retain their identity`, async ($, on) => {
    setup(on, { ...initial, activity: { owner: 'ui-test', hidden: false, subagents: [
      { id: 'starting', model: '', confirmed: false, task: 'Starting work', tokens: 0, running: true },
      { id: 'routed', model: 'deepseek-v4.1-flash:cloud', confirmed: false, task: 'Ollama work', tokens: 0, running: true },
      { id: 'native', model: 'claude-opus-5-5', confirmed: true, task: 'Native work', tokens: 50, running: true },
    ] } })
    const ui = await $.ui.mount({ plugin: 'ollama', surface, component: 'AbovePrompt', requestId: `worker-identity-${surface}`, props })
    expect(await ui.find({ type: 'Text', text: 'Starting…' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'DeepSeek v4.1 Flash · Starting…' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    await ui.unmount()
  })
}
