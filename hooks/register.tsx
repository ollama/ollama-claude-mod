import type { EngineInterface, Register } from 'claude-code'
import { loadPreferences, savePreferences } from './settings'
import type { Preferences } from './settings'
import { getConnection, saveConnection } from './ollama'
import { loadModels, syncNativePicker } from './discovery'
import { copyChatPreferences, getPreferences, notice, preferenceOwner, readView, rememberClear, updateView } from './runtime'
import { modeLabels, renderUI } from './ui'
import { executionComplete, executionFetch, executionSpawn, executionStep, recordWorkerResponse } from './execution'
import { isCurrentMainSwitch, modelSwitched, refreshModelCatalog } from './models'
import { refreshConfiguredWindow, resetWindows, saveModelWindow } from './window'
import { composeRoutingContext, submitRoutingContext, refreshQueuedRoutingContext } from './context'
import { clearFinishedAgents, readActivity, resetActivity, toggleActivity } from './activity'
import { readAppearance, refreshAppearance } from './appearance'
import { stopPulse } from './activity-view'
import { connectionAddress } from './route'

const SHOW_RESPONSE_SPEED = 'show-response-speed'

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
    await updateView($, current => ({ ...current, ...(revision === preferenceRevision ? { preferences } : {}),
      ...(current.endpoint !== connection.base ? { connected: false, connectionIssue: undefined, notice: '' } : {}), endpoint: connection.base }))
    const discovery = await loadModels($, connection, !ifStale)
    const { models, connected, connectionIssue } = discovery
    if (version !== refreshVersion || await $.session.id() !== owner) return
    await updateView($, current => ({ ...current, models, connected, connectionIssue, notice: requested ? '' : current.notice }))
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
    await updateView($, current => ({ ...current, connected: false, connectionIssue: message(error), notice: requested ? '' : current.notice }))
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
    await updateView($, current => current.endpoint === base && current.preferences.model === model
      ? { ...current, modelWindow, notice: '' } : current)
    await refreshConfiguredWindow($)
  } catch (error) { if (await $.session.id() === owner) await notice($, message(error)) }
}

// The launcher already configures Claude's provider and model. Match its host
// marker and endpoint so other managed providers can still use the mod.
async function usesOllamaLauncher($: EngineInterface): Promise<boolean> {
  if (await $.env.get('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST') !== '1') return false
  const provider = await $.env.get('ANTHROPIC_BASE_URL')
  if (!provider) return false
  const host = await $.env.get('OLLAMA_HOST')
  try { return connectionAddress(provider) === connectionAddress(host ?? '') }
  catch { return false }
}

let launched: boolean | undefined
const isLaunched = async ($: EngineInterface) => launched ??= await usesOllamaLauncher($)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    await resetWindows($, true).catch(() => undefined)
    const started = await next(e)
    await resetActivity($, await $.session.id()).catch(() => undefined)
    await refreshAppearance($).catch(() => undefined)
    await $.command.register({ name: 'ollama', description: 'Configure Ollama for this chat', argumentHint: '[model [MODEL] | full | subagent | off | status | uninstall]', immediate: true })
    await refresh($).catch(() => undefined)
    return started
  })

  // Native /new is a clear alias. The classic lifecycle also covers a
  // replacement session that has no native session.start or command callback.
  on('classic.SessionStart', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    const result = await next(e)
    if (await $.session.id() !== refreshedSession) {
      await resetActivity($, await $.session.id()).catch(() => undefined)
      await refreshAppearance($).catch(() => undefined)
      await refresh($).catch(() => undefined)
    }
    return result
  })

  on('config.describe', { key: 'ollama.modelCatalog' }, async ($, e, next) => {
    const result = await next(e)
    return await isLaunched($) ? result : { ...result, isHidden: true }
  })
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    const result = await next(e)
    await refreshAppearance($).catch(() => undefined)
    return result
  })
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    const owner = e.session_id
    const result = await next(e)
    if (!['command', 'picker', 'sdk'].includes(e.source) || !await isCurrentMainSwitch($, e)) return result
    preferenceRevision++
    try {
      const preferences = await modelSwitched($, e)
      if (preferences && await $.session.id() === owner) await updateView($, current => ({ ...current, preferences, notice: '' }))
    } catch (error) {
      const preferences = await getPreferences($).catch(() => undefined)
      if (await $.session.id() === owner) await updateView($, current => ({ ...current, ...(preferences ? { preferences } : {}), notice: message(error) }))
    }
    await refreshConfiguredWindow($).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    stopPulse()
    if (e.reason === 'clear') rememberClear(e.sessionId)
    await resetWindows($).catch(() => undefined)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    if (!['clear', 'new', 'reset', 'branch', 'resume'].includes(e.command)) return next(e)
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
    } catch (error) { await notice($, message(error)).catch(() => undefined) }
    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    if (!e.args.trim()) await refresh($, false, true).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ollama' }, async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    try {
      const [command, ...rest] = e.args.trim().split(/\s+/)
      if (command === 'uninstall') {
        const scope = rest[0] ?? 'user'
        if (rest.length > 1 || !['user', 'project', 'local'].includes(scope)) throw new Error('Use /ollama uninstall [user|project|local].')
        if (e.origin.kind !== 'composer' || await $.env.get('CLAUDE_CODE_ENTRYPOINT') === 'claude-desktop') {
          return { text: `Open Claude Code in your terminal and enter /ollama uninstall${rest.length ? ' ' + scope : ''}.`, isTextDisplayOnly: true }
        }
        const result = await $.process.run(['node', `${$.plugin.root}/scripts/model-picker.mjs`, 'uninstall', scope], { timeoutMs: 60000 })
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Could not finish uninstalling Ollama. Try /ollama uninstall again.')
        return { text: result.stdout.trim(), isTextDisplayOnly: true }
      }
      if (!command || (command === 'model' && !rest.length)) {
        const openMenu = command === 'model' ? { key: 'model' as const } : null
        await updateView($, current => ({ ...current, settingsOpen: true, openMenu }))
        if (openMenu) void refresh($, false, true).catch(() => undefined)
        return {}
      }
      if (command === 'model') await persist($, { model: rest.join(' ') })
      else if (command === 'off' || command === 'never') await persist($, { enabled: false })
      else if (command === 'full' || command === 'subagent') {
        if (rest.length) throw new Error('Choose a model with /ollama model MODEL. Use /ollama full or /ollama subagent to switch modes.')
        await persist($, { mode: command, enabled: true })
      } else if (command !== 'status') return { text: 'Use /ollama model [MODEL], /ollama full, /ollama subagent, /ollama off, /ollama status, or /ollama uninstall.', isTextDisplayOnly: true }
      if (command !== 'status' && await $.env.get('CLAUDE_CODE_ENTRYPOINT') === 'claude-desktop') {
        return {}
      }
      const preferences = await getPreferences($)
      if (command === 'model') return { text: `Ollama model · ${preferences.model}`, isTextDisplayOnly: true }
      if (!preferences.enabled) return { text: 'Ollama off · Claude runs this chat and its subagents.', isTextDisplayOnly: true }
      return { text: `Ollama · ${modeLabels[preferences.mode]} · ${preferences.model}`, isTextDisplayOnly: true }
    } catch (error) { return { text: message(error), isTextDisplayOnly: true, exitCode: 1 } }
  })

  on('prompt.compose', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    return composeRoutingContext($, e, next)
  })
  on('prompt.submit', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    const owner = await $.session.id()
    if (owner !== refreshedSession) await refresh($).catch(() => undefined)
    const userMessage = !e.isMeta && !e.command && (['composer', 'bridge', 'sdk'].includes(e.origin.kind) || e.origin.kind === 'plugin' && e.origin.asUser)
    const view = userMessage ? await readView($).catch(() => undefined) : undefined
    const result = await submitRoutingContext($, e, next)
    if (result.drop === undefined && userMessage) {
      await clearFinishedAgents($, owner)
      if (view?.owner === owner && view.openMenu?.key === 'compact-mode') {
        await updateView($, current => current.owner === owner && current.openMenu?.key === 'compact-mode'
          ? { ...current, openMenu: null } : current).catch(() => undefined)
      }
    }
    return result
  })
  on('session.append', { door: 'hook-context' }, async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    return refreshQueuedRoutingContext($, e, next)
  })
  // Only records replies for workers this activation routed through Ollama.
  on('session.append', { door: 'response' }, recordWorkerResponse)

  on('agent.spawn', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    return executionSpawn($, e, next)
  })
  on('turn.step', async function* ($, e, next) {
    if (await isLaunched($)) return yield* next(e)
    return yield* executionStep($, e, next)
  })
  on('turn.complete', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    return executionComplete($, e, next)
  })
  on('http.fetch', async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    return executionFetch($, e, next)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await isLaunched($)) return next(e)
    if (e.props.hasSurvey) {
      stopPulse(e.requestId)
      return next(e)
    }
    const owner = await $.session.id()
    const preferences = await getPreferences($).catch(() => undefined)
    const current = await readView($)
    const activity = await readActivity($).catch(() => undefined)
    const appearance = await readAppearance($).catch(() => ({ isDark: true }))
    const showResponseSpeed = (await $.store.get(SHOW_RESPONSE_SPEED).catch(() => false)) === true
    const state = { ...current, ...(preferences ? { preferences } : {}), activity, ...appearance, showResponseSpeed }
    return renderUI($, e, state, {
      setMode: async value => {
        try { await persist($, value === 'never' ? { enabled: false } : { enabled: true, mode: value }, owner) }
        catch (error) { if (await $.session.id() === owner) await notice($, message(error)) }
      },
      setModel: value => change($, 'model', value, owner),
      setEffort: value => change($, state.preferences.mode === 'full' ? 'fullEffort' : 'subagentEffort', value, owner),
      setShowResponseSpeed: async show => {
        try {
          await $.store.set(SHOW_RESPONSE_SPEED, show)
          $.ui.invalidate('ui.render')
        } catch (error) { if (await $.session.id() === owner) await notice($, message(error)) }
      },
      toggleSettings: async () => {
        if (await $.session.id() === owner) await updateView($, current => ({ ...current, settingsOpen: !current.settingsOpen, openMenu: null }))
      },
      toggleSubagents: () => toggleActivity($, owner),
      setOpenMenu: async openMenu => {
        if (await $.session.id() !== owner) return
        const openingModel = openMenu?.key === 'model' && (await readView($)).openMenu?.key !== 'model'
        await updateView($, current => ({ ...current, openMenu }))
        if (openingModel) void refresh($, false, true).catch(() => undefined)
        if (openMenu?.key === 'advanced' && state.connected) await refreshConfiguredWindow($).catch(() => undefined)
      },
      setEndpoint: value => endpoint($, value),
      setContext: value => contextLimit($, value, owner, state.endpoint, state.preferences.model),
      refresh: () => refresh($, true),
    })
  })
}
