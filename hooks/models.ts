import type { ClassicHookInputs, EngineInterface, Settings } from 'claude-code'
import type { OllamaModel, Preferences } from '../types'
import { getPreferences, preferenceOwner, readView, updateView } from './runtime'
import { savePreference, savePreferences } from './settings'
import { canonicalModel, modelRow } from './catalog'
import type { PickerRow } from './catalog'
import { readCachedModels } from './discovery'
import { getConnection } from './ollama'

const CATALOG_FIELD = 'ollama.modelCatalog'
const CATALOG_STORE = 'model-catalog-v1'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function catalogRows(value: unknown): PickerRow[] {
  return Array.isArray(value) ? value.filter((row): row is PickerRow => object(row) && typeof row.model === 'string' && row.model.trim() !== '' && typeof row.label === 'string' && typeof row.description === 'string') : []
}

function catalog(settings: Settings): PickerRow[] {
  if (!object(settings.pluginConfigs)) return []
  const rows: PickerRow[] = []
  for (const [name, config] of Object.entries(settings.pluginConfigs)) {
    if (name !== 'ollama' && !name.startsWith('ollama@')) continue
    if (!object(config) || !object(config.options) || typeof config.options.modelCatalog !== 'string') continue
    try { rows.push(...catalogRows(JSON.parse(config.options.modelCatalog))) }
    catch { /* A damaged internal catalog adds no rows. */ }
  }
  return [...new Map(rows.map(row => [row.model, row])).values()]
}

async function clearCatalogWarning($: EngineInterface): Promise<void> {
  const warning = (await readView($)).notice
  if (typeof warning !== 'string') return
  const original = warning.replace(/^ollama: /, '').replace(/ \(\$\.config\.list names them\)$/, '')
  const unbound = '$.config.list is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on'
  if (original !== '$.config.set: no /config row with key ollama.modelCatalog' && original !== 'no /config row with key ollama.modelCatalog' && original !== unbound) return
  await updateView($, current => current.notice === warning ? { ...current, notice: '' } : current)
}

// This internal catalog identifies Ollama selections. The setup script adds
// native picker rows because the picker reads raw settings, not settings.read.
export async function refreshModelCatalog($: EngineInterface, models: OllamaModel[], complete = true): Promise<void> {
  const configured = catalog(await $.settings.read({ source: 'user' }))
  const previous = [...catalogRows(await $.store.get(CATALOG_STORE)), ...configured]
  const incoming = models.filter(model => !model.isDecision).map(modelRow)
  const rows = [...new Map([...(complete ? [] : previous), ...incoming].map(row => [row.model, row])).values()]
    .sort((a, b) => a.model.localeCompare(b.model))
  const value = JSON.stringify(rows)
  // The host may omit this optional /config row when two marketplace IDs load
  // the same plugin. Publish durable identity before attempting that registry.
  await $.store.set(CATALOG_STORE, rows)
  if (JSON.stringify(configured) === value) {
    await clearCatalogWarning($)
    return
  }
  try {
    // Desktop may open /model before a session is bound. Its optional config
    // registry is unavailable then and emits a host warning before rejection.
    const desktop = await $.env.get('CLAUDE_CODE_ENTRYPOINT') === 'claude-desktop'
    // Hidden rows and rows missing from one marketplace activation are absent
    // here. Do not invoke set: the host displays its lookup error before catch.
    if (desktop || !(await $.config.list()).some(row => row.key === CATALOG_FIELD)) {
      const saved = catalogRows(await $.store.get(CATALOG_STORE))
      if (!rows.every(row => saved.some(item => item.model === row.model))) throw new Error('Could not preserve Ollama model identity without its config row.')
      await clearCatalogWarning($)
      return
    }
    const result = await $.config.set({ key: CATALOG_FIELD, value })
    if ('deny' in result) throw new Error(result.deny)
    await clearCatalogWarning($)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (reason.includes('no /config row with key ollama.modelCatalog')) {
      const saved = catalogRows(await $.store.get(CATALOG_STORE))
      if (rows.every(row => saved.some(item => item.model === row.model))) {
        await clearCatalogWarning($)
        return
      }
    }
    try { $.ui.log(`Ollama model catalog: ${reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)}`, { to: 'debug' }) } catch { /* Diagnostics cannot replace the original error. */ }
    throw error
  }
}

export async function isOllamaModel($: EngineInterface, candidate: string): Promise<boolean> {
  if (!candidate) return false
  const tag = canonicalModel(candidate)
  const matches = (name: string) => canonicalModel(name) === tag
  const preferences = await getPreferences($)
  if (matches(preferences.model)) return true
  if (catalogRows(await $.store.get(CATALOG_STORE)).some(row => matches(row.model))) return true
  const state = await readView($)
  if (state.models.some(model => !model.isDecision && matches(model.name))) return true
  for (const source of ['policy', 'flag', 'user'] as const) {
    if (catalog(await $.settings.read({ source })).some(row => matches(row.model))) return true
  }
  try { return (await readCachedModels($, await getConnection($))).some(model => matches(model.name)) }
  catch { return false } // Optional cached identity must not break native routing.
}

export async function isCurrentMainSwitch($: EngineInterface, e: ClassicHookInputs['PostModelSwitch']): Promise<boolean> {
  return !e.agent_id && e.session_id === await $.session.id() && e.to_model === await $.session.model()
}

export async function modelSwitched($: EngineInterface, e: ClassicHookInputs['PostModelSwitch']): Promise<Preferences | undefined> {
  if (!['command', 'picker', 'sdk'].includes(e.source) || !await isCurrentMainSwitch($, e)) return undefined
  const sessionId = e.session_id
  const owner = await preferenceOwner($, sessionId)
  const selected = e.requested_model ?? e.to_model
  const ollama = await isOllamaModel($, selected) ? selected : await isOllamaModel($, e.to_model) ? e.to_model : undefined
  if (!await isCurrentMainSwitch($, e)) return undefined
  if (ollama) {
    return savePreferences($, owner, { model: ollama, mode: 'full', enabled: true })
  }
  const preferences = await getPreferences($)
  if (!await isCurrentMainSwitch($, e)) return undefined
  return preferences.mode === 'full' ? savePreference($, owner, 'enabled', false) : savePreference($, owner, 'mode', preferences.mode)
}
