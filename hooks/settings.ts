import type { EngineInterface } from 'claude-code'
import type { Mode, Thinking, Preferences } from '../types'
export type { Mode, Preferences } from '../types'

const modeDefaults: Record<Mode, string> = { subagent: 'inkling-2-small:cloud', full: 'kimi-k3.1-pro:cloud' }

// A null model follows the mode. A string is the user's choice, even when it matches a preset.
type SavedPreferences = Omit<Preferences, 'model'> & { model: string | null }
const initial: SavedPreferences = { enabled: true, mode: 'subagent', model: null }

function effectivePreferences(saved: SavedPreferences): Preferences {
  return { ...saved, model: saved.model ?? modeDefaults[saved.mode] }
}

export const DEFAULT_PREFERENCES: Preferences = Object.freeze(effectivePreferences(initial))

type StoredPreferences = SavedPreferences & { full?: string; subagent?: string }
type PreferenceRecord = { version: 1 | 2; value: StoredPreferences }
const fields = ['enabled', 'mode', 'model', 'fullEffort', 'subagentEffort'] as const
const storedFields = [...fields, 'full', 'subagent'] as const
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

function validField(field: string, value: unknown, baseVersion?: 1 | 2): boolean {
  if (field === 'enabled') return typeof value === 'boolean'
  if (field === 'mode') return value === 'full' || value === 'subagent'
  if (field === 'model') return typeof value === 'string' || (baseVersion === 2 && value === null)
  if (field === 'full' || field === 'subagent') return baseVersion !== 2 && typeof value === 'string'
  return (field === 'fullEffort' || field === 'subagentEffort') && (value === undefined || thinking.includes(value as Thinking))
}

function preferenceRecord(raw: unknown): PreferenceRecord {
  const { value, version } = envelope(raw, true)
  const record = version === 1 && object(value) ? { model: '', ...value } : value
  if (!object(record) || !['enabled', 'mode', 'model'].every(field => Object.hasOwn(record, field)) ||
      Object.entries(record).some(([field, value]) => !validField(field, value, version))) {
    throw new Error('Chat preferences are malformed; the saved values were left unchanged.')
  }
  const model = typeof record.model === 'string' ? record.model.trim() || null : null
  return { version, value: { ...record, model } as StoredPreferences }
}

function chatPreferences({ full, subagent, ...saved }: StoredPreferences): SavedPreferences {
  // The old two-model picker showed the choice for the chat's last active mode, even when Off.
  const lastChoice = saved.mode === 'full' ? full : subagent
  return { ...saved, model: saved.model || lastChoice?.trim() || full?.trim() || subagent?.trim() || null }
}

function envelope(value: unknown, allowV2 = false): { version: 1 | 2; value: unknown } {
  if (!object(value) || (value.version !== 1 && !(allowV2 && value.version === 2)) ||
      Object.keys(value).some(field => field !== 'version' && field !== 'value') || !('value' in value)) {
    throw new Error('Chat preferences have an invalid or unsupported version; the saved values were left unchanged.')
  }
  return { version: value.version, value: value.value }
}

// Read every field before initializing anything, so damaged or orphaned records
// cannot be silently replaced by defaults. Store failures propagate to the UI.
async function readStored($: EngineInterface, sessionId: string): Promise<SavedPreferences | undefined> {
  const base = key(sessionId)
  const saved = await $.store.get(base)
  const record = saved === undefined ? undefined : preferenceRecord(saved)
  const migrateRoles = record?.version === 1 && !record.value.model
  for (const field of !record || migrateRoles ? storedFields : fields) {
    const savedField = await $.store.get(`${base}:${field}`)
    if (savedField === undefined) continue
    const value = envelope(savedField).value
    const decoded = value === null && (field === 'fullEffort' || field === 'subagentEffort') ? undefined : value
    if (!record || !validField(field, decoded)) {
      throw new Error('Chat preferences are malformed; the saved values were left unchanged.')
    }
    const edit = typeof decoded === 'string' ? decoded.trim() : decoded
    if (edit !== '') Object.assign(record.value, { [field]: edit })
  }
  if (!record) return undefined
  const preferences = chatPreferences(record.value)
  if (migrateRoles) {
    // Freeze the old pick before a mode change. A concurrent :model edit
    // still wins because field records take precedence over this base record.
    await $.store.set(base, { version: 2, value: preferences })
  }
  return preferences
}

async function readDefaults($: EngineInterface): Promise<SavedPreferences> {
  try {
    const saved = await $.store.get(DEFAULTS_KEY)
    if (saved === undefined) return { ...initial }
    return chatPreferences(preferenceRecord(saved).value)
  } catch {
    throw new Error('Could not read saved defaults for new chats. The saved values were left unchanged.')
  }
}

async function loadSaved($: EngineInterface, sessionId: string, defaults?: SavedPreferences): Promise<SavedPreferences> {
  const release = await lock(`chat:${key(sessionId)}`)
  try {
    const saved = await readStored($, sessionId)
    if (saved) return saved
    const seed = defaults === undefined ? await readDefaults($) : preferenceRecord({ version: 2, value: defaults }).value
    await $.store.set(key(sessionId), { version: 2, value: seed })
    return seed
  } finally {
    release()
  }
}

export async function loadPreferences($: EngineInterface, sessionId: string, defaults?: Preferences): Promise<Preferences> {
  return effectivePreferences(await loadSaved($, sessionId, defaults))
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
  if (edits.some(({ field, value }) => !validField(field, value) || field === 'model' && typeof value === 'string' && !value.trim())) throw new Error('Invalid chat preference changes.')
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
      await $.store.set(chatKey, { version: 2, value: saved })
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
    let result: SavedPreferences | undefined
    try { result = await readStored($, sessionId) }
    catch { throw new Error('Chat changes were saved, but could not be read back. Defaults are unchanged. Reload this chat and try again.') }
    if (!result) throw new Error('Chat changes were saved, but the chat record is now missing. Defaults are unchanged. Reload this chat and try again.')
    try {
      await $.store.set(DEFAULTS_KEY, { version: 2, value: result })
    } catch {
      throw new Error('Saved this chat, but could not update defaults for new chats. Previous defaults are unchanged; try saving again.')
    }
    return effectivePreferences(result)
  } finally {
    releaseChat()
    releaseDefaults()
  }
}

export async function copyPreferences($: EngineInterface, sourceId: string, targetId: string): Promise<Preferences> {
  // Never hold both locks: clear/branch can overlap with edits to the source.
  const source = await loadSaved($, sourceId)
  return effectivePreferences(await loadSaved($, targetId, source))
}
