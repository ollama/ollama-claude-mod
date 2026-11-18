import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { parseShow } from '../hooks/route'
import { captureWindow, readModelWindow, releaseWindow, resetWindows, saveModelWindow } from '../hooks/window'

const local = { base: 'http://localhost:11434', key: '' }
const cloud = { base: 'https://ollama.com', key: '' }
function fixture(initial?: string) {
  let value = initial
  let running: number | undefined
  let unavailable = false
  const store = new Map<string, unknown>()
  let state: unknown
  let version = 0
  let disableCompact = false
  let wait: Promise<void> | undefined
  let reached: (() => void) | undefined
  const engine = {
    session: { id: async () => 'window-test' },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) }, delete: async (key: string) => { store.delete(key) } },
    state: { get: async () => ({ value: state, version }), set: async (_ref: unknown, value: unknown) => { state = value; return { isSet: true, version: ++version } } },
    env: { get: async (key: string) => key === 'DISABLE_COMPACT' ? disableCompact ? 'true' : undefined : value, set: async (_key: string, next: string | undefined) => { value = next; return {} } },
    http: { fetch: async (url: string) => {
      reached?.()
      if (wait) await wait
      if (unavailable) throw new Error('offline')
      return { ok: true, status: 200, text: JSON.stringify(url.endsWith('/api/ps') ? { models: running ? [{ name: 'large:latest', context_length: running }] : [] } : { capabilities: ['tools'], model_info: { 'architecture.context_length': 1048576 } }) }
    } },
  } as unknown as EngineInterface
  return { engine, value: () => value, external: (next: string) => { value = next }, running: (next: number) => { running = next }, offline: () => { unavailable = true }, disableCompact: () => { disableCompact = true },
    owner: (previous: string | undefined, written: string) => { state = { shape: 'context-owner-v1', value: { previous, written } } },
    pause: () => {
      let release!: () => void
      const entered = new Promise<void>(resolve => { reached = resolve })
      wait = new Promise<void>(resolve => { release = resolve })
      return { entered, release: () => { wait = undefined; reached = undefined; release() } }
    } }
}

test('local training maximum stays unknown until an allocation is reported; cloud uses its maximum', async () => {
  const f = fixture()
  expect(await readModelWindow(f.engine, local, 'large')).toMatchObject({ maximum: 1048576, source: 'unknown' })
  f.running(32768)
  expect(await readModelWindow(f.engine, local, 'large')).toMatchObject({ maximum: 1048576, effective: 32768, source: 'running' })
  expect(await readModelWindow(f.engine, cloud, 'large')).toMatchObject({ maximum: 1048576, effective: 1048576, source: 'cloud' })
})

test('manual windows are endpoint/model scoped, bounded by known maximum, and reset without metadata', async () => {
  const f = fixture()
  expect((await saveModelWindow(f.engine, local, 'large', '65536')).effective).toBe(65536)
  expect((await readModelWindow(f.engine, cloud, 'large')).override).toBe(undefined)
  expect((await readModelWindow(f.engine, local, 'different')).override).toBe(undefined)
  for (const value of ['0', '1.5', '9007199254740992', '1048577']) {
    let failed = false
    try { await saveModelWindow(f.engine, local, 'large', value) } catch { failed = true }
    expect(failed).toBe(true)
  }
  f.offline()
  expect((await readModelWindow(f.engine, local, 'large')).effective).toBe(65536)
  expect(await saveModelWindow(f.engine, local, 'large', 'auto')).toMatchObject({ source: 'unknown' })
})

test('overlapping workers retain the smaller captured limit and restore an explicit user cap', async () => {
  const f = fixture('500000')
  await resetWindows(f.engine)
  const older = {}, newer = {}
  await saveModelWindow(f.engine, local, 'large', '32768')
  await captureWindow(f.engine, older, local, 'large')
  await saveModelWindow(f.engine, local, 'large', '1048576')
  await captureWindow(f.engine, newer, local, 'large')
  expect(f.value()).toBe('32768')
  await releaseWindow(f.engine, older)
  expect(f.value()).toBe('500000')
  await releaseWindow(f.engine, newer)
  expect(f.value()).toBe('500000')
  await resetWindows(f.engine)
})

test('release restores an unset environment and preserves another writer taking ownership', async () => {
  const f = fixture()
  await resetWindows(f.engine)
  const run = {}
  await captureWindow(f.engine, run, cloud, 'large')
  expect(f.value()).toBe('1048576')
  await releaseWindow(f.engine, run)
  expect(f.value()).toBe(undefined)
  const later = {}
  await captureWindow(f.engine, later, cloud, 'large')
  f.external('16384')
  await releaseWindow(f.engine, later)
  expect(f.value()).toBe('16384')
  await resetWindows(f.engine)
})


test('disabled native compaction leaves the user runtime cap untouched', async () => {
  const f = fixture('262144')
  await resetWindows(f.engine)
  f.disableCompact()
  const run = {}
  await saveModelWindow(f.engine, local, 'large', '32768')
  await captureWindow(f.engine, run, local, 'large')
  expect(f.value()).toBe('262144')
  await resetWindows(f.engine)
})


test('a local cloud proxy reports its real maximum and a local override cannot enlarge the allocation', async () => {
  const f = fixture()
  expect((await readModelWindow(f.engine, local, 'model:cloud')).effective).toBe(1048576)
  f.running(32768)
  let failed = false
  try { await saveModelWindow(f.engine, local, 'large', '65536') } catch { failed = true }
  expect(failed).toBe(true)
  expect((await readModelWindow(f.engine, local, 'large')).effective).toBe(32768)
})


test('metadata arriving after a run ends cannot reapply its window; concurrent overrides keep save order', async () => {
  const f = fixture()
  await resetWindows(f.engine)
  const held = f.pause()
  const run = {}
  const capture = captureWindow(f.engine, run, cloud, 'large')
  await held.entered
  await releaseWindow(f.engine, run)
  held.release()
  await capture
  expect(f.value()).toBe(undefined)

  const saving = f.pause()
  const first = saveModelWindow(f.engine, local, 'large', '32768')
  await saving.entered
  const second = saveModelWindow(f.engine, local, 'large', '65536')
  saving.release()
  await Promise.all([first, second])
  expect((await readModelWindow(f.engine, local, 'large')).override).toBe(65536)
  await resetWindows(f.engine)
})

test('reload recovers only an environment value the prior activation still owns', async () => {
  const f = fixture('32768')
  f.owner(undefined, '32768')
  await resetWindows(f.engine, true)
  expect(f.value()).toBe(undefined)
  f.external('65536')
  f.owner('131072', '32768')
  await resetWindows(f.engine, true)
  expect(f.value()).toBe('65536')
})


test('model context metadata follows the declared architecture rather than vision metadata', () => {
  const model_info = { 'general.architecture': 'text', 'vision.context_length': 512, 'text.context_length': 65536 }
  expect(parseShow(JSON.stringify({ model_info })).contextLength).toBe(65536)
  expect(parseShow(JSON.stringify({ model_info: { 'vision.context_length': 512, 'text.context_length': 65536 } })).contextLength).toBe(0)
})
