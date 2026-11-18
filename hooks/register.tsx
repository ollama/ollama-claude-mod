import type { EngineInterface, Register } from 'claude-code'
import { loadPreferences, savePreferences } from './settings'
import type { Preferences } from './settings'
import { getConnection, saveConnection } from './ollama'
import { loadModels, syncNativePicker } from './discovery'
import { copyChatPreferences, getPreferences, notice, preferenceOwner, readView, rememberClear, updateView } from './runtime'
import { modeLabels, renderUI } from './ui'
import { executionComplete, executionFetch, executionSpawn, executionStep } from './execution'
import { modelSwitched, preserveNativeStartup, refreshModelCatalog, rememberNativeModel } from './models'
import { cancelSelection, confirmSelection, isOwnSelection, scheduleSelection, selectModel } from './selection'
import { refreshConfiguredWindow, resetWindows, saveModelWindow } from './window'
import { composeRoutingContext, submitRoutingContext, refreshQueuedRoutingContext } from './context'
import { readActivity, resetActivity, toggleActivity } from './activity'
import { readAppearance, refreshAppearance } from './appearance'
import { stopPulse } from './activity-view'
import { dismissSummary, readSummary } from './summary'

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not save this change. Try again.'
}

let refreshVersion = 0
let preferenceRevision = 0
let refreshedSession = ''

async function refresh($: EngineInterface, requested = false, ifStale = false): Promise<void> {
  const version = ++refreshVersion
  const revision = preferenceRevision
  const owner = await $.session.id()
  refreshedSession = owner
  try {
    const preferences = await getPreferences($)
    const connection = await getConnection($)
    if (version !== refreshVersion || await $.session.id() !== owner) return
    await updateView($, current => ({ ...current, ...(revision === preferenceRevision ? { preferences } : {}), endpoint: connection.base }))
    const discovery = await loadModels($, connection, !ifStale)
    const { models, connected } = discovery
    if (version !== refreshVersion || await $.session.id() !== owner) return
    await updateView($, current => ({ ...current, models, connected, notice: requested && !connected ? 'Cannot reach Ollama. Check its address and sign-in.' : '' }))
    if (!ifStale) await refreshConfiguredWindow($).catch(() => undefined)
    // Publish identity before exposing native rows so an immediate selection
    // cannot mistake an Ollama model for the native fallback.
    try {
      await refreshModelCatalog($, models, discovery.complete)
      if (version !== refreshVersion || await $.session.id() !== owner) return
      await syncNativePicker($, connection, discovery)
    } catch (error) {
      if (version === refreshVersion && await $.session.id() === owner) await notice($, message(error))
    }
  } catch (error) {
    if (version !== refreshVersion || await $.session.id() !== owner) return
    await updateView($, current => ({ ...current, connected: false, notice: requested ? message(error) : current.notice }))
  }
}

async function persist($: EngineInterface, patch: Partial<Preferences>, owner?: string): Promise<void> {
  preferenceRevision++
  const sessionId = owner ?? await $.session.id()
  const savedOwner = await preferenceOwner($, sessionId)
  try {
    const preferences = await savePreferences($, savedOwner, patch)
    if (await $.session.id() === sessionId) {
      await updateView($, current => ({ ...current, preferences, notice: '' }))
      scheduleSelection($, sessionId)
      void refreshConfiguredWindow($).catch(() => undefined)
    }
  } catch (error) {
    // A chat save can succeed before publishing its new-chat default fails.
    // Show what execution will actually read, alongside the save warning.
    const preferences = await loadPreferences($, savedOwner).catch(() => undefined)
    if (preferences && await $.session.id() === sessionId) await updateView($, current => ({ ...current, preferences }))
    throw error
  }
}

async function change<K extends keyof Preferences>($: EngineInterface, field: K, value: Preferences[K], owner: string): Promise<void> {
  try { await persist($, { [field]: value }, owner) }
  catch (error) { if (await $.session.id() === owner) await notice($, message(error)) }
}

async function endpoint($: EngineInterface, value: string): Promise<void> {
  try {
    await saveConnection($, value)
    await refresh($, true)
  } catch (error) { await notice($, message(error)) }
}

async function contextLimit($: EngineInterface, value: string, owner: string, base: string, model: string): Promise<void> {
  if (await $.session.id() !== owner) return
  try {
    const connection = await getConnection($)
    if (connection.base !== base || await $.session.id() !== owner) return
    const modelWindow = await saveModelWindow($, connection, model, value)
    if (await $.session.id() !== owner) return
    await updateView($, current => current.endpoint === base && current.preferences[current.preferences.mode] === model
      ? { ...current, modelWindow, notice: '' } : current)
    await refreshConfiguredWindow($)
  } catch (error) { if (await $.session.id() === owner) await notice($, message(error)) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await resetWindows($, true).catch(() => undefined)
    const started = await next(e)
    await resetActivity($, await $.session.id()).catch(() => undefined)
    await refreshAppearance($).catch(() => undefined)
    await $.command.register({ name: 'ollama', description: 'Configure Ollama for this chat', argumentHint: '[full MODEL | subagent MODEL | off | status]', immediate: true })
    await refresh($).catch(() => undefined)
    await rememberNativeModel($, await $.session.model()).catch(() => undefined)
    await preserveNativeStartup($).catch(() => undefined)
    scheduleSelection($, await $.session.id())
    return started
  })

  // Native /new is a clear alias. The classic lifecycle also covers a
  // replacement session that has no native session.start or command callback.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (await $.session.id() !== refreshedSession) {
      await resetActivity($, await $.session.id()).catch(() => undefined)
      await refreshAppearance($).catch(() => undefined)
      await refresh($).catch(() => undefined)
      scheduleSelection($, await $.session.id())
    }
    return result
  })

  on('config.describe', { key: 'ollama.modelCatalog' }, async ($, e, next) => ({ ...await next(e), isHidden: true }))
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await refreshAppearance($).catch(() => undefined)
    return result
  })
  on('classic.PreModelSwitch', confirmSelection)
  on('classic.PostModelSwitch', async ($, e, next) => {
    const owner = e.session_id
    const result = await next(e)
    if (await $.session.id() !== owner) return result
    if (isOwnSelection(e)) {
      await rememberNativeModel($, e.to_model).catch(() => undefined)
      await refreshConfiguredWindow($).catch(() => undefined)
      await preserveNativeStartup($).catch(() => undefined)
      return result
    }
    cancelSelection()
    preferenceRevision++
    try {
      const preferences = await modelSwitched($, e)
      if (preferences && await $.session.id() === owner) await updateView($, current => ({ ...current, preferences, notice: '' }))
    } catch (error) {
      const preferences = await getPreferences($).catch(() => undefined)
      if (await $.session.id() === owner) await updateView($, current => ({ ...current, ...(preferences ? { preferences } : {}), notice: message(error) }))
    }
    await refreshConfiguredWindow($).catch(() => undefined)
    await preserveNativeStartup($).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    cancelSelection()
    stopPulse()
    if (e.reason === 'clear') rememberClear(e.sessionId)
    await resetWindows($).catch(() => undefined)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (!['clear', 'new', 'reset', 'branch', 'resume'].includes(e.command)) return next(e)
    cancelSelection()
    preferenceRevision++
    refreshVersion++
    const before = await $.session.id()
    const result = await next(e)
    try {
      const after = await $.session.id()
      await resetActivity($, after).catch(() => undefined)
      if (after !== before && e.command !== 'resume') await copyChatPreferences($, before, after)
      const preferences = await getPreferences($)
      await updateView($, current => ({ ...current, preferences, notice: '' }))
      if (after !== refreshedSession) await refresh($)
      scheduleSelection($, after)
    } catch (error) { await notice($, message(error)).catch(() => undefined) }
    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (!e.args.trim()) await refresh($, false, true).catch(() => undefined)
    return selectModel($, e, next)
  })

  on('command.run', { command: 'ollama' }, async ($, e) => {
    try {
      const [command, ...rest] = e.args.trim().split(/\s+/)
      if (command === 'off') await persist($, { enabled: false })
      else if (command === 'full' || command === 'subagent') {
        const selected = rest.join(' ')
        await persist($, { mode: command, enabled: true, ...(selected ? { [command]: selected } : {}) })
      } else if (command && command !== 'status') return { text: 'Use /ollama full MODEL, /ollama subagent MODEL, or /ollama off.', isTextDisplayOnly: true }
      else if (!command) {
        await updateView($, current => ({ ...current, settingsOpen: true, openMenu: null }))
        return { text: '', isTextDisplayOnly: true }
      }
      const preferences = await getPreferences($)
      return { text: preferences.enabled ? `Ollama · ${modeLabels[preferences.mode]} · ${preferences[preferences.mode] || 'Choose a model above'}` : 'Ollama off · Claude runs this chat and its subagents.', isTextDisplayOnly: true }
    } catch (error) { return { text: message(error), isTextDisplayOnly: true, exitCode: 1 } }
  })

  on('prompt.compose', ($, e, next) => composeRoutingContext($, e, next))
  on('prompt.submit', async ($, e, next) => {
    if (await $.session.id() !== refreshedSession) await refresh($).catch(() => undefined)
    const userMessage = !e.isMeta && !e.command && (['composer', 'bridge', 'sdk'].includes(e.origin.kind) || e.origin.kind === 'plugin' && e.origin.asUser)
    const summary = userMessage ? await readSummary($).catch(() => undefined) : undefined
    const result = await submitRoutingContext($, e, next)
    if (result.drop === undefined && summary) await dismissSummary($, summary).catch(() => undefined)
    return result
  })
  on('session.append', { door: 'hook-context' }, ($, e, next) => refreshQueuedRoutingContext($, e, next))

  on('agent.spawn', ($, e, next) => executionSpawn($, e, next))
  on('turn.step', async function* ($, e, next) { return yield* executionStep($, e, next) })
  on('turn.complete', ($, e, next) => executionComplete($, e, next))
  on('http.fetch', ($, e, next) => executionFetch($, e, next))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      stopPulse(e.requestId)
      return next(e)
    }
    const owner = await $.session.id()
    const preferences = await getPreferences($).catch(() => undefined)
    const current = await readView($)
    const activity = await readActivity($).catch(() => undefined)
    const appearance = await readAppearance($).catch(() => ({ isDark: true }))
    const state = { ...current, ...(preferences ? { preferences } : {}), activity, ...appearance }
    const summary = await readSummary($, state).catch(() => undefined)
    return renderUI($, e, { ...state, showMode: summary?.visible ?? true }, {
      setEnabled: value => change($, 'enabled', value, owner),
      setMode: value => change($, 'mode', value, owner),
      setModel: value => change($, state.preferences.mode, value, owner),
      setEffort: value => change($, state.preferences.mode === 'full' ? 'fullEffort' : 'subagentEffort', value, owner),
      toggleSettings: async () => {
        if (await $.session.id() === owner) await updateView($, current => ({ ...current, settingsOpen: !current.settingsOpen, openMenu: null }))
      },
      toggleSubagents: () => toggleActivity($, owner),
      setOpenMenu: async openMenu => {
        if (await $.session.id() !== owner) return
        const openingModel = openMenu?.key === 'model' && (await readView($)).openMenu?.key !== 'model'
        await updateView($, current => ({ ...current, openMenu }))
        if (openingModel) void refresh($, false, true).catch(() => undefined)
      },
      setEndpoint: value => endpoint($, value),
      setContext: value => contextLimit($, value, owner, state.endpoint, state.preferences[state.preferences.mode]),
      refresh: () => refresh($, true),
    })
  })
}
