import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ModelWindow } from '../types'
import { getConnection, runningContext, showModel } from './ollama'
import type { Connection } from './ollama'
import { readCachedModels } from './discovery'
import { getPreferences, updateView } from './runtime'

type Owner = { previous?: string; written?: string }
const ownerState = atom({ plugin: 'ollama', key: 'windowOwner' } as const, {} as Owner, { shape: 'context-owner-v1' })
const active = new Map<object, number>()
const released = new WeakSet<object>()
const saves = new Map<string, Promise<unknown>>()
let configured: number | undefined
let previous: string | undefined
let written: string | undefined
let owns = false
let initialized = false
let queue = Promise.resolve()
let revision = 0
let generation = 0

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function overrideKey(connection: Connection, model: string): string {
  return `context-override-v1:${encodeURIComponent(JSON.stringify([connection.base, model]))}`
}

export async function readModelWindow($: EngineInterface, connection: Connection, model: string): Promise<ModelWindow> {
  if (!model) return { model, endpoint: connection.base, source: 'unknown' }
  const [metadata, allocation, saved] = await Promise.all([
    showModel($, connection, model).catch(async () => (await readCachedModels($, connection)).find(item => item.name === model)),
    connection.base === 'https://ollama.com' ? undefined : runningContext($, connection, model).catch(() => undefined),
    $.store.get(overrideKey(connection, model)).catch(() => undefined),
  ])
  const maximum = positive(metadata?.maximumContext) ? metadata.maximumContext : metadata?.isCloud && positive(metadata.contextLength) ? metadata.contextLength : undefined
  const detected = metadata?.isCloud ? maximum : positive(allocation) ? allocation : metadata?.parameterContext
  const capacity = detected && maximum ? Math.min(detected, maximum) : detected
  const override = positive(saved) && (!maximum || saved <= maximum) ? saved : undefined
  const result: ModelWindow = { model, endpoint: connection.base, ...(maximum ? { maximum } : {}), ...(capacity ? { detected: capacity } : {}), source: 'unknown' }
  if (override) return { ...result, override, effective: capacity ? Math.min(override, capacity) : override, source: 'manual' }
  if (capacity) return { ...result, effective: capacity, source: metadata?.isCloud ? 'cloud' : positive(allocation) ? 'running' : 'parameters' }
  return result
}

async function writeModelWindow($: EngineInterface, connection: Connection, model: string, value: string): Promise<ModelWindow> {
  if (!model) throw new Error('Choose an Ollama model first.')
  const text = value.trim()
  if (!text || text.toLowerCase() === 'auto') await $.store.delete(overrideKey(connection, model))
  else {
    const number = /^\d+$/.test(text) ? Number(text) : 0
    if (!positive(number)) throw new Error('Context must be a positive whole number of tokens, or auto.')
    const current = await readModelWindow($, connection, model)
    if (current.maximum && number > current.maximum) throw new Error(`Context cannot exceed the model maximum of ${current.maximum} tokens.`)
    if (current.detected && number > current.detected) throw new Error(`Context cannot exceed the reported capacity of ${current.detected} tokens. Change the Ollama allocation first.`)
    await $.store.set(overrideKey(connection, model), number)
  }
  return readModelWindow($, connection, model)
}


export async function saveModelWindow($: EngineInterface, connection: Connection, model: string, value: string): Promise<ModelWindow> {
  const key = overrideKey(connection, model)
  const operation = (saves.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => writeModelWindow($, connection, model, value))
  saves.set(key, operation)
  try { return await operation }
  finally { if (saves.get(key) === operation) saves.delete(key) }
}

// The host has one runtime cap. A captured worker retains its limit until it
// completes, even when the configured model changes during its execution.
async function apply($: EngineInterface): Promise<void> {
  const current = await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  if (!initialized) {
    const record = await read($, ownerState).catch(() => undefined)
    if (record?.written && record.written === current) {
      previous = record.previous
      written = record.written
      owns = true
    }
    initialized = true
  }
  if (owns && current !== written) {
    // Another writer took over. Its value becomes the baseline, never ours to
    // restore, and its explicit cap remains part of the minimum below.
    owns = false
    written = undefined
  }
  if (!owns) previous = current
  const disabled = /^(1|true|yes|on)$/i.test(await $.env.get('DISABLE_COMPACT') ?? '')
  const limits = disabled ? [] : [...active.values(), ...(configured ? [configured] : [])]
  const baseline = previous === undefined ? undefined : Number(previous)
  if (limits.length && positive(baseline)) limits.push(baseline)
  const target = limits.length ? String(Math.min(...limits)) : previous
  if (target !== current) {
    const result = await $.env.set('CLAUDE_CODE_MAX_CONTEXT_TOKENS', target)
    if ('deny' in result) return
  } else if (!owns || limits.length) return
  if (!limits.length) {
    owns = false
    written = undefined
    await update($, ownerState, () => ({}))
  } else {
    owns = true
    written = target
    await update($, ownerState, () => ({ ...(previous !== undefined ? { previous } : {}), written }))
  }
}
function sync($: EngineInterface): Promise<void> {
  const operation = queue.catch(() => undefined).then(() => apply($))
  queue = operation.catch(() => undefined)
  return operation
}

export async function captureWindow($: EngineInterface, run: object, connection: Connection, model: string): Promise<void> {
  const captured = generation
  const limit = await readModelWindow($, connection, model)
  if (captured !== generation || released.has(run)) return
  if (limit.effective) active.set(run, limit.effective)
  await sync($)
}
export async function releaseWindow($: EngineInterface, run: object): Promise<void> {
  released.add(run)
  active.delete(run)
  await sync($)
}
export async function refreshConfiguredWindow($: EngineInterface): Promise<ModelWindow | undefined> {
  const version = ++revision
  const owner = await $.session.id()
  const preferences = await getPreferences($)
  const window = await readModelWindow($, await getConnection($), preferences.model)
  if (version !== revision || owner !== await $.session.id()) return window
  configured = preferences.enabled ? window.effective : undefined
  await sync($)
  if (version === revision && owner === await $.session.id()) await updateView($, current => ({ ...current, modelWindow: window }))
  return window
}

export async function resetWindows($: EngineInterface, recover = false): Promise<void> {
  ++revision
  ++generation
  configured = undefined
  active.clear()
  await queue
  if (recover && !owns) {
    const record = await read($, ownerState)
    if (record?.written && record.written === await $.env.get('CLAUDE_CODE_MAX_CONTEXT_TOKENS')) {
      previous = record.previous
      written = record.written
      owns = true
    }
  }
  await sync($)
}
