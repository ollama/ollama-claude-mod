import type { ClassicHookInputs, EngineInterface, Settings } from 'claude-code'
import type { OllamaModel, Preferences } from '../types'
import { getPreferences, preferenceOwner, readView } from './runtime'
import { savePreference, savePreferences } from './settings'
import { modelRow } from './catalog'
import type { PickerRow } from './catalog'

const CATALOG_FIELD = 'ollama.modelCatalog'
const NATIVE_GLOBAL = 'native-model-v1:last'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function catalog(settings: Settings): PickerRow[] {
  if (!object(settings.pluginConfigs)) return []
  for (const [name, config] of Object.entries(settings.pluginConfigs)) {
    if (name !== 'ollama' && !name.startsWith('ollama@')) continue
    if (!object(config) || !object(config.options) || typeof config.options.modelCatalog !== 'string') continue
    try {
      const rows: unknown = JSON.parse(config.options.modelCatalog)
      if (Array.isArray(rows)) return rows.filter((row): row is PickerRow => object(row) && typeof row.model === 'string' && row.model.trim() !== '' && typeof row.label === 'string' && typeof row.description === 'string')
    } catch { /* A damaged internal catalog adds no rows. */ }
  }
  return []
}

// This internal catalog identifies Ollama selections. The setup script adds
// native picker rows because the picker reads raw settings, not settings.read.
export async function refreshModelCatalog($: EngineInterface, models: OllamaModel[], complete = true): Promise<void> {
  const previous = catalog(await $.settings.read({ source: 'user' }))
  const incoming = models.filter(model => !model.isDecision).map(modelRow)
  const rows = [...new Map([...(complete ? [] : previous), ...incoming].map(row => [row.model, row])).values()]
    .sort((a, b) => a.model.localeCompare(b.model))
  const value = JSON.stringify(rows)
  if (JSON.stringify(previous) === value) return
  const result = await $.config.set({ key: CATALOG_FIELD, value })
  if ('deny' in result) throw new Error(result.deny)
}

export async function isOllamaModel($: EngineInterface, candidate: string): Promise<boolean> {
  if (!candidate) return false
  const preferences = await getPreferences($)
  if (candidate === preferences.full || candidate === preferences.subagent) return true
  const state = await readView($)
  if (state.models.some(model => !model.isDecision && model.name === candidate)) return true
  for (const source of ['policy', 'flag', 'user'] as const) {
    if (catalog(await $.settings.read({ source })).some(row => row.model === candidate)) return true
  }
  return false
}

// Keep the actual native model separately from the picker selection. A model
// chosen from Ollama's rows must never become its own failure fallback.
export async function resolveNativeModel($: EngineInterface, candidate: string): Promise<string> {
  const owner = await preferenceOwner($, await $.session.id())
  const key = `native-model-v1:${encodeURIComponent(owner)}`
  if (candidate && !await isOllamaModel($, candidate)) return candidate
  for (const saved of [await $.store.get(key), await $.store.get(NATIVE_GLOBAL)]) {
    if (typeof saved === 'string' && saved && !await isOllamaModel($, saved)) return saved
  }
  return 'default'
}

export async function rememberNativeModel($: EngineInterface, candidate: string, publish = false, rawSessionId?: string): Promise<void> {
  const sessionId = rawSessionId ?? await $.session.id()
  if (sessionId !== await $.session.id()) return
  if (!candidate || await isOllamaModel($, candidate)) return
  const owner = await preferenceOwner($, sessionId)
  if (sessionId !== await $.session.id()) return
  await $.store.set(`native-model-v1:${encodeURIComponent(owner)}`, candidate)
  if (sessionId !== await $.session.id()) return
  const shouldPublish = publish || await $.store.get(NATIVE_GLOBAL) === undefined
  if (shouldPublish && sessionId === await $.session.id()) await $.store.set(NATIVE_GLOBAL, candidate)
}

export async function preserveNativeStartup($: EngineInterface): Promise<void> {
  const current = await $.session.model()
  if (!await isOllamaModel($, current)) return
  const native = await resolveNativeModel($, current)
  const result = await $.process.run(['node', `${$.plugin.root}/scripts/model-picker.mjs`, 'startup', '--native-model', native, '--catalog-stdin'], {
    stdin: JSON.stringify({ models: [{ name: current, isCloud: current.endsWith(':cloud'), isDecision: false }], complete: false }),
    timeoutMs: 10000,
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Could not preserve the startup model.')
}

export async function modelSwitched($: EngineInterface, e: ClassicHookInputs['PostModelSwitch']): Promise<Preferences | undefined> {
  if (e.agent_id) return undefined
  const sessionId = e.session_id
  if (sessionId !== await $.session.id()) return undefined
  const owner = await preferenceOwner($, sessionId)
  const explicit = ['command', 'picker', 'sdk'].includes(e.source)
  await rememberNativeModel($, e.from_model, explicit, sessionId)
  const selected = e.requested_model ?? e.to_model
  const ollama = await isOllamaModel($, selected) || await isOllamaModel($, e.to_model)
  if (sessionId !== await $.session.id()) return undefined
  if (!ollama) await rememberNativeModel($, e.to_model, explicit, sessionId)
  if (!explicit) return undefined
  if (sessionId !== await $.session.id()) return undefined
  if (ollama) {
    const name = await isOllamaModel($, selected) ? selected : e.to_model
    if (sessionId !== await $.session.id()) return undefined
    return savePreferences($, owner, { full: name, mode: 'full', enabled: true })
  }
  const preferences = await getPreferences($)
  if (sessionId !== await $.session.id()) return undefined
  return preferences.mode === 'full' ? savePreference($, owner, 'enabled', false) : savePreference($, owner, 'mode', preferences.mode)
}
