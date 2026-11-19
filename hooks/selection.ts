import type { ClassicHookInputs, EngineInterface, Hook, Timer } from 'claude-code'
import { getPreferences, notice, updateView } from './runtime'
import { isOllamaModel, rememberNativeModel, resolveNativeModel } from './models'
import { getConnection, showModel } from './ollama'
import { refreshConfiguredWindow } from './window'

type Selection = { owner: string; revision: number; target: string; accepted: boolean }
type Request = { owner: string; revision: number }
let revision = 0
let timer: Timer | undefined
let active: Selection | undefined
let running = false
let requested: Request | undefined
let manualCommand = false

export function cancelSelection(): void {
  revision++
  timer?.cancel()
  timer = undefined
  requested = undefined
}

export function cancelInferenceSelection($: EngineInterface): void {
  cancelSelection()
  void updateView($, state => state.selection?.status === 'pending' ? { ...state, selection: undefined } : state).catch(() => undefined)
}

// Defer the native switch until the command/start hook returns: the host
// refuses nested commands while either hook holds the session.
export function scheduleSelection($: EngineInterface, owner: string, ifIdle = false): void {
  if (ifIdle && requested?.owner === owner) return
  cancelSelection()
  requested = { owner, revision }
  arm($, requested)
}

function arm($: EngineInterface, request: Request): void {
  timer = $.clock.after(100, () => { void reconcile($, request) })
}

async function reconcile($: EngineInterface, request: Request): Promise<void> {
  if (running || request !== requested) return
  const { owner, revision: version } = request
  running = true
  try {
    if (owner !== await $.session.id() || version !== revision) return
    const preferences = await getPreferences($)
    const current = await $.session.model()
    const target = preferences.enabled && preferences.mode === 'full'
      ? preferences.full
      : await resolveNativeModel($, current)
    if (!target || owner !== await $.session.id() || version !== revision) return
    if (target === current) {
      await updateView($, state => ({ ...state, selection: undefined }))
      return
    }
    const displayed = await isOllamaModel($, current) ? current : ''
    if (owner !== await $.session.id() || version !== revision) return
    await updateView($, state => ({ ...state, selection: { target, current: displayed, status: 'pending' } }))
    await rememberNativeModel($, current)
    // Native /model checks the context synchronously. Set the real window
    // first, including cached cloud metadata while the connection warms up.
    if (preferences.enabled && preferences.mode === 'full') {
      // A native /model command accepts unknown names and emits a success row.
      // Do not publish that success when Ollama cannot actually use the model.
      await showModel($, await getConnection($), target)
      await refreshConfiguredWindow($).catch(() => undefined)
    }
    if (owner !== await $.session.id() || version !== revision) return
    active = { owner, revision: version, target, accepted: false }
    const result = await $.command.run({ command: 'model', args: target })
    if (owner !== await $.session.id() || version !== revision) return
    const selected = await $.session.model()
    const matches = target === 'default' ? !await isOllamaModel($, selected) : selected === target
    if (result.exitCode || !matches) throw new Error('The host did not select the requested model.')
    await updateView($, state => ({ ...state, selection: undefined, notice: '' }))
  } catch {
    if (owner === await $.session.id() && version === revision) {
      const current = await $.session.model()
      const displayed = await isOllamaModel($, current) ? current : ''
      if (owner !== await $.session.id() || version !== revision) return
      await updateView($, state => ({ ...state, selection: { target: state.selection?.target ?? '', current: displayed, status: 'failed' } })).catch(() => undefined)
      await notice($, 'The model switch did not finish. Choose a model with /model or select the use setting again to retry.').catch(() => undefined)
    }
  } finally {
    active = undefined
    running = false
    // A newer click may have arrived while the native command was queued.
    if (requested === request) requested = undefined
    if (requested) arm($, requested)
  }
}

// Manual model changes supersede a queued toggle. Timer-issued commands can
// skip this plugin's command hooks; PreModelSwitch also guards that native path.
export async function selectModel($: EngineInterface, e: Parameters<Hook<'command.run'>>[1], next: Parameters<Hook<'command.run'>>[2]) {
  if (e.origin.kind !== 'plugin' || e.origin.name !== 'ollama') {
    // Opening the picker is not a new choice. Only its selected model or an
    // explicit argument supersedes an already queued switch.
    if (e.args.trim()) {
      cancelSelection()
      await updateView($, state => ({ ...state, selection: undefined }))
    }
    manualCommand = true
    try { return await next(e) }
    finally { manualCommand = false }
  }
  const selection = active
  const owner = await $.session.id()
  if (!selection || selection !== active || selection.revision !== revision || selection.owner !== owner || e.args.trim() !== selection.target) {
    return { text: '', isTextDisplayOnly: true as const }
  }
  selection.accepted = true
  return next(e)
}

export function isOwnSelection(e: ClassicHookInputs['PreModelSwitch'] | ClassicHookInputs['PostModelSwitch']): boolean {
  return Boolean(active?.accepted && active.revision === revision && active.owner === e.session_id && !e.agent_id &&
    (e.requested_model === active.target || e.to_model === active.target || active.target === 'default' && e.requested_model === null))
}

export async function confirmSelection($: EngineInterface, e: Parameters<Hook<'classic.PreModelSwitch'>>[1], next: Parameters<Hook<'classic.PreModelSwitch'>>[2]) {
  const result = await next(e)
  const selection = active
  if (manualCommand || !selection || e.agent_id || e.source !== 'command' ||
    !(e.requested_model === selection.target || e.to_model === selection.target || selection.target === 'default' && e.requested_model === null)) return result
  const owner = await $.session.id()
  if (selection !== active || selection.revision !== revision || selection.owner !== owner || selection.owner !== e.session_id) {
    return { ...result, permissionDecision: 'deny' as const }
  }
  // The person already chose this switch with the Ollama control. Keep other
  // hooks' restrictions; acknowledge only the native cache-cost confirmation.
  if (result.block || result.preventContinuation || result.permissionDecision === 'deny' || result.permissionDecision === 'ask') return result
  selection.accepted = true
  return { ...result, permissionDecision: 'allow' as const }
}
