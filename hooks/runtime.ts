import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { copyPreferences, loadPreferences, DEFAULT_PREFERENCES } from './settings'
import type { Preferences, ViewState } from '../types'
export type { ViewState } from '../types'

export const view = atom({ plugin: 'ollama', key: 'view' } as const, {
  owner: '',
  preferences: DEFAULT_PREFERENCES,
  models: [], connected: false, endpoint: '', settingsOpen: false, openMenu: null, notice: '',
} as ViewState, { shape: 'view-v1' })

let clearedSession: string | undefined

export function rememberClear(sessionId: string): void {
  clearedSession = sessionId
}

// Desktop keeps a logical chat while /clear replaces its CLI process. Persist
// an alias so that Desktop and a later CLI resume resolve the same preferences.
export async function preferenceOwner($: EngineInterface, sessionId: string): Promise<string> {
  const key = `chat-owner-v1:${encodeURIComponent(sessionId)}`
  const saved = await $.store.get(key)
  if (saved !== undefined) {
    if (typeof saved !== 'string' || !/^desktop:local_[a-f0-9-]{36}$/.test(saved)) throw new Error('The saved chat identity needs attention.')
    return saved
  }
  if (sessionId !== await $.session.id() || await $.env.get('CLAUDE_CODE_ENTRYPOINT') !== 'claude-desktop') return sessionId
  const hostId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  if (!hostId || !/^local_[a-f0-9-]{36}$/.test(hostId)) return sessionId
  const owner = `desktop:${hostId}`
  const previous = await loadPreferences($, sessionId)
  await loadPreferences($, owner, previous)
  await $.store.set(key, owner)
  return owner
}

export async function copyChatPreferences($: EngineInterface, sourceId: string, targetId: string): Promise<Preferences> {
  const source = await preferenceOwner($, sourceId)
  const target = await preferenceOwner($, targetId)
  return copyPreferences($, source, target)
}

export async function getPreferences($: EngineInterface): Promise<Preferences> {
  const sessionId = await $.session.id()
  if (clearedSession && clearedSession !== sessionId) {
    const source = clearedSession
    const preferences = await copyChatPreferences($, source, sessionId)
    if (clearedSession === source) clearedSession = undefined
    return preferences
  }
  return loadPreferences($, await preferenceOwner($, sessionId))
}

function forSession(current: ViewState, owner: string): ViewState {
  if (current.owner === owner) return current
  // Adopt an older activation's view once. A different chat always starts
  // compact, without an editor or notice left open by the previous chat.
  return { ...current, owner, ...(current.owner === undefined ? {} : {
    settingsOpen: false, openMenu: null, notice: '', modelWindow: undefined,
  }) }
}

export async function readView($: EngineInterface): Promise<ViewState> {
  const owner = await $.session.id()
  return forSession(await read($, view), owner)
}

export async function notice($: EngineInterface, message: string): Promise<void> {
  await updateView($, current => ({ ...current, notice: message }))
}

export async function updateView($: EngineInterface, change: (current: ViewState) => ViewState): Promise<void> {
  const owner = await $.session.id()
  await update($, view, current => change(forSession(current, owner)))
}
