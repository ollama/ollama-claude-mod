import type { EngineInterface } from 'claude-code'
import type { Thinking, Preferences } from '../types'
export type { Mode, Preferences } from '../types'

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  enabled: false,
  mode: 'full',
  full: 'kimi-k3.1-pro:cloud',
  subagent: 'deepseek-v4.1-flash:cloud',
})

const fields = ['enabled', 'mode', 'full', 'subagent', 'fullEffort', 'subagentEffort'] as const
const thinking: readonly Thinking[] = ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max']
const pending = new Map<string, Promise<void>>()
const DEFAULTS_KEY = 'preference-defaults-v1'

function key(sessionId: string): string {
  if (!sessionId) throw new Error('Chat preferences require a chat ID.')
  return `preferences:${encodeURIComponent(sessionId)}`
}

// Chat operations serialize locally; explicit saves also serialize publication
// of the whole default configuration. Every caller rereads durable values.
async function lock(id: string): Promise<() => void> {
  const previous = pending.get(id)
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  pending.set(id, next)
  await previous
  return () => {
    release()
    if (pending.get(id) === next) pending.delete(id)
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validField(field: keyof Preferences, value: unknown): boolean {
  if (field === 'enabled') return typeof value === 'boolean'
  if (field === 'mode') return value === 'full' || value === 'subagent'
  if (field === 'full' || field === 'subagent') return typeof value === 'string'
  return value === undefined || thinking.includes(value as Thinking)
}

function preferences(value: unknown): Preferences {
  const record: Record<string, unknown> | undefined = object(value) ? { full: '', subagent: '', ...value } : undefined
  if (!record || Object.keys(record).some(field => !fields.includes(field as keyof Preferences)) ||
      fields.some(field => !validField(field, record[field]))) {
    throw new Error('Chat preferences are malformed; the saved values were left unchanged.')
  }
  return record as Preferences
}

function blankModel(field: keyof Preferences, value: unknown): boolean {
  return (field === 'full' || field === 'subagent') && typeof value === 'string' && !value.trim()
}

function fillModels(saved: Preferences, defaults: Preferences): Preferences {
  return { ...saved, full: saved.full.trim() || defaults.full, subagent: saved.subagent.trim() || defaults.subagent }
}

function envelope(value: unknown): Record<string, unknown> {
  if (!object(value) || value.version !== 1 || Object.keys(value).some(field => field !== 'version' && field !== 'value') || !('value' in value)) {
    throw new Error('Chat preferences have an invalid or unsupported version; the saved values were left unchanged.')
  }
  return value
}

// Read every field before initializing anything, so damaged or orphaned records
// cannot be silently replaced by defaults. Store failures propagate to the UI.
async function readStored($: EngineInterface, sessionId: string): Promise<Preferences | undefined> {
  const base = key(sessionId)
  const saved = await $.store.get(base)
  const result = saved === undefined ? undefined : preferences(envelope(saved).value)
  for (const field of fields) {
    const savedField = await $.store.get(`${base}:${field}`)
    if (savedField === undefined) continue
    const value = envelope(savedField).value
    const decoded = value === null && (field === 'fullEffort' || field === 'subagentEffort') ? undefined : value
    if (!result || !validField(field, decoded)) {
      throw new Error('Chat preferences are malformed; the saved values were left unchanged.')
    }
    if (!blankModel(field, decoded)) Object.assign(result, { [field]: decoded })
  }
  if (result && (!result.full.trim() || !result.subagent.trim())) {
    // Freeze the missing role for this chat. Explicit per-field edits still win.
    const repaired = fillModels(result, await readDefaults($))
    await $.store.set(base, { version: 1, value: repaired })
    return repaired
  }
  return result
}

async function readDefaults($: EngineInterface): Promise<Preferences> {
  try {
    const saved = await $.store.get(DEFAULTS_KEY)
    return saved === undefined ? { ...DEFAULT_PREFERENCES } : fillModels(preferences(envelope(saved).value), DEFAULT_PREFERENCES)
  } catch {
    throw new Error('Could not read saved defaults for new chats. The saved values were left unchanged.')
  }
}

export async function loadPreferences($: EngineInterface, sessionId: string, defaults?: Preferences): Promise<Preferences> {
  const release = await lock(`chat:${key(sessionId)}`)
  try {
    const saved = await readStored($, sessionId)
    if (saved) return saved
    const initial = defaults === undefined ? await readDefaults($) : fillModels(preferences(defaults), DEFAULT_PREFERENCES)
    await $.store.set(key(sessionId), { version: 1, value: initial })
    return { ...initial }
  } finally {
    release()
  }
}

export async function savePreference<K extends keyof Preferences>($: EngineInterface, sessionId: string, field: K, value: Preferences[K]): Promise<Preferences> {
  return savePreferences($, sessionId, { [field]: value } as Partial<Preferences>)
}

export async function savePreferences($: EngineInterface, sessionId: string, patch: Partial<Preferences>): Promise<Preferences> {
  if (!object(patch) || Object.keys(patch).length === 0 || Object.keys(patch).some(field => !fields.includes(field as keyof Preferences))) {
    throw new Error('Invalid chat preference changes.')
  }
  // Capture and validate the complete edit before waiting or writing anything.
  const edits = fields.filter(field => Object.hasOwn(patch, field)).map(field => ({ field, value: patch[field] }))
  if (edits.some(({ field, value }) => !validField(field, value) || blankModel(field, value))) throw new Error('Invalid chat preference changes.')
  const chatKey = key(sessionId)
  const releaseDefaults = await lock('defaults')
  const releaseChat = await lock(`chat:${chatKey}`)
  try {
    // Validate the default record before any write: damaged values are never
    // replaced, even when this existing chat does not need them for seeding.
    const defaults = await readDefaults($)
    let saved = await readStored($, sessionId)
    if (!saved) {
      saved = defaults
      await $.store.set(chatKey, { version: 1, value: saved })
    }
    // Preserve unrelated field records, including edits from another process.
    // A patch is not a storage transaction: never roll back successful fields.
    let written = 0
    try {
      for (const { field, value } of edits) {
        await $.store.set(`${chatKey}:${field}`, { version: 1, value: value === undefined ? null : value })
        written++
      }
    } catch (error) {
      if (written > 0) throw new Error('Some chat changes were saved, but the remaining changes failed. Defaults are unchanged. Reload this chat and try again.')
      throw error
    }
    // Re-read rather than publishing an optimistic merge; unrelated durable
    // field edits must be included and damaged records must not be hidden.
    let result: Preferences | undefined
    try { result = await readStored($, sessionId) }
    catch { throw new Error('Chat changes were saved, but could not be read back. Defaults are unchanged. Reload this chat and try again.') }
    if (!result) throw new Error('Chat changes were saved, but the chat record is now missing. Defaults are unchanged. Reload this chat and try again.')
    try {
      await $.store.set(DEFAULTS_KEY, { version: 1, value: result })
    } catch {
      throw new Error('Saved this chat, but could not update defaults for new chats. Previous defaults are unchanged; try saving again.')
    }
    return result
  } finally {
    releaseChat()
    releaseDefaults()
  }
}

export async function copyPreferences($: EngineInterface, sourceId: string, targetId: string): Promise<Preferences> {
  // Never hold both locks: clear/branch can overlap with edits to the source.
  const source = await loadPreferences($, sourceId)
  return loadPreferences($, targetId, source)
}
