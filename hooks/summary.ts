import type { EngineInterface } from 'claude-code'
import { getConnection } from './ollama'
import { getPreferences, readView, updateView } from './runtime'
import type { ViewState } from '../types'

type Summary = { owner: string; key: string; settings: string; visible: boolean }

// Remember what this conversation has already used, separately from its
// preferences. A new/cleared chat starts visible; resuming keeps it dismissed.
export async function readSummary($: EngineInterface, state?: ViewState): Promise<Summary> {
  const owner = await $.session.id()
  const preferences = state?.preferences ?? await getPreferences($)
  const endpoint = state ? state.endpoint : (await getConnection($)).base
  const view = state ?? await readView($)
  const model = preferences.model
  const window = view.modelWindow
  const override = window?.model === model && window.endpoint === endpoint ? window.override : undefined
  const settings = JSON.stringify([
    preferences.enabled, preferences.mode, model,
    preferences.fullEffort, preferences.subagentEffort, endpoint, override,
  ])
  const key = `settings-summary-v1:${encodeURIComponent(owner)}`
  return { owner, key, settings, visible: await $.store.get(key) !== settings }
}

export async function dismissSummary($: EngineInterface, summary: Summary): Promise<void> {
  if (!summary.visible) return
  // Capture before submission: a setting changed while it was being accepted
  // must remain visible, rather than being dismissed by the older message.
  await $.store.set(summary.key, summary.settings)
  if (await $.session.id() === summary.owner) {
    await updateView($, current => ({ ...current, openMenu: current.openMenu?.key === 'compact-mode' ? null : current.openMenu }))
  }
}
