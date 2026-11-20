import type { EngineInterface, Hook } from 'claude-code'
import type { Thinking } from '../types'
import { getPreferences, readView, updateView } from './runtime'
import { getConnection, prepareRequest, OllamaConnectionError, OllamaRequestError } from './ollama'
import { invalidateStaleConnection } from './discovery'
import type { Connection } from './ollama'
import { toOllamaBody, wholeRequest, withoutUnsignedThinking } from './route'
import { captureWindow, releaseWindow } from './window'
import { isOllamaModel, rememberNativeModel, resolveNativeModel } from './models'
import { cancelInferenceSelection } from './selection'
import { activityTime, recordOllamaUsage, startAgentActivity, startMainActivity, updateAgentActivity, updateMainActivity } from './activity'

type Body = Parameters<typeof toOllamaBody>[0]
type Run = {
  sessionId: string
  connection?: Connection
  model: string
  effort?: Thinking
  nativeModel: string
  failed: boolean
  failure?: string
  noticeRevision?: number
  previousNotice?: string
  previousConnectionIssue?: string
  worker?: boolean
  captured: boolean
  accepted: boolean
  lastRequest?: Body
  output?: number
  measuredOutput?: number
  duration?: number
  actualModel?: string
  activityFailed?: boolean
  activityEffort?: Thinking
}
const turns = new Map<string, Run>()
const agents = new Map<string, Run>()
const inFlight = new Map<string, Run>()
const history = new Map<string, Body>()
const noticeRevisions = new Map<string, number>()
const MAIN = 'main'
const CHOOSE_NATIVE = 'Choose a Claude model with /model for native requests.'
const INVALID_CONNECTION = 'Could not read the Ollama connection settings. Check the address in Settings → Advanced.'

async function fail($: EngineInterface, run: Pick<Run, 'model' | 'failed' | 'failure'> & Partial<Run>, phase: string, reason: string, status?: number) {
  const firstFailure = !run.failed
  run.failed = true
  const detail = status === 429 ? 'Rate limit reached. Try again later or choose another model.'
    : status === 401 || status === 403 ? 'Ollama authorization failed. Check sign-in.'
    : status === 404 && phase === 'preparation' ? 'Ollama could not find this model. Check the model in Settings.'
    : status === 413 ? 'The request is too large. Shorten the conversation and try again.'
    : status !== undefined && status >= 500 ? 'Ollama is unavailable. Try again later.'
    : reason
  run.failure = phase === 'connection' ? detail
    : `Ollama ${phase} failed${status ? ` (HTTP ${status})` : ''}: ${detail} Change model with /model or Ollama settings, then start a new turn.`
  const model = run.model.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
  if (phase === 'connection' && run.connection) invalidateStaleConnection(run.connection.base, false)
  try { $.ui.log(`Ollama failure: ${JSON.stringify({ model, phase, ...(status ? { status } : {}), reason: detail })}`, { to: 'debug' }) } catch { /* Diagnostics cannot change delivery. */ }
  // The transcript belongs to the chat that launched the run, even if the
  // user has since changed models or a newer turn owns the status bar.
  if (firstFailure) {
    try {
      if (!run.sessionId || run.sessionId === await $.session.id()) {
        const role = run.worker ? 'subagent' : 'request'
        $.ui.log(`Ollama ${role} failed (${model}${status ? `, HTTP ${status}` : ''}). ${detail}`, { to: 'transcript' })
      }
    } catch { /* Keep the original failure when the host cannot display a notice. */ }
  }
  if (firstFailure && run.sessionId && run.noticeRevision !== undefined) {
    const owner = run.sessionId
    const role = run.worker ? 'subagent' : 'full'
    const effort = run.worker ? 'subagentEffort' : 'fullEffort'
    try {
      const preferences = await getPreferences($)
      if (owner === await $.session.id() && (noticeRevisions.get(owner) ?? 0) === run.noticeRevision &&
          preferences.enabled && (run.worker || preferences.mode === 'full') && preferences[role] === run.model && preferences[effort] === run.effort) {
        await updateView($, current => {
          if (current.owner !== owner || (noticeRevisions.get(owner) ?? 0) !== run.noticeRevision ||
              current.notice !== run.previousNotice || !current.preferences.enabled || (!run.worker && current.preferences.mode !== 'full') ||
              current.preferences[role] !== run.model || current.preferences[effort] !== run.effort || current.selection?.status === 'pending') return current
          if (phase === 'connection') {
            if (!run.connection) return { ...current, notice: detail }
            if (current.endpoint && current.endpoint !== run.connection.base) return current
            return { ...current, connected: false, connectionIssue: detail, notice: '' }
          }
          return { ...current, notice: `Ollama ${model} · ${phase}${status ? ` · HTTP ${status}` : ''}: ${detail} Change model with /model or Ollama settings.` }
        })
      }
    } catch { /* A notice must not replace or hide the original request failure. */ }
  }
  return { deny: run.failure }
}

function historyKey(run: Run, loop: string): string {
  return JSON.stringify([run.sessionId, loop])
}

const TEMPLATE_PREFIX = 'request-template-v1:'
const MAX_TEMPLATE_BYTES = 256_000
const MAX_TEMPLATES = 8

function templateKey(run: Run, loop: string): string {
  return `${TEMPLATE_PREFIX}${historyKey(run, loop)}`
}

function template(value: unknown): Body | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const saved = value as Record<string, unknown>
  if (saved.version !== 1 || Object.keys(saved).some(key => !['version', 'system', 'tools'].includes(key))) return undefined
  if (typeof saved.system !== 'string' && !Array.isArray(saved.system)) return undefined
  if (saved.tools !== undefined && !Array.isArray(saved.tools)) return undefined
  if (new TextEncoder().encode(JSON.stringify(saved)).byteLength > MAX_TEMPLATE_BYTES) return undefined
  const blocks = [...(Array.isArray(saved.system) ? saved.system : []), ...(Array.isArray(saved.tools) ? saved.tools : [])]
  if (blocks.some(block => !block || typeof block !== 'object' || Array.isArray(block))) return undefined
  return { system: saved.system as Body['system'], ...(saved.tools !== undefined ? { tools: saved.tools as Body['tools'] } : {}) }
}

async function saveTemplate($: EngineInterface, run: Run, loop: string, body: Body): Promise<void> {
  try {
    const value = { version: 1, system: body.system, tools: body.tools }
    if (!template(value)) return
    const key = templateKey(run, loop)
    const keys = (await $.store.keys()).filter(one => one.startsWith(TEMPLATE_PREFIX) && one !== key)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TEMPLATES + 1))) await $.store.delete(old)
    await $.store.set(key, value)
  } catch { /* A cache failure never changes delivery or recovery. */ }
}

function remember($: EngineInterface, run: Run, loop: string, body: Body): void {
  run.lastRequest = body
  history.set(historyKey(run, loop), body)
  // Cache only the exact system/tool template, never messages or HTTP headers.
  // Do not hold an accepted native stream open for optional disk persistence.
  void saveTemplate($, run, loop, body)
}

async function forwardNative($: EngineInterface, run: Run, loop: string, e: Parameters<Hook<'http.fetch'>>[1], next: Parameters<Hook<'http.fetch'>>[2], body: Body) {
  // The native engine resolves aliases when starting a step; raw HTTP cannot.
  if (typeof e.init?.body === 'string' && JSON.parse(e.init.body).model === 'default') return { deny: CHOOSE_NATIVE }
  const result = await next(e)
  if (result.value?.ok) {
    if ((body.thread === undefined || body.thread.type === 'create') && body.system !== undefined) remember($, run, loop, { ...body, thread: undefined })
  }
  return result
}

async function snapshot($: EngineInterface, nativeModel: string, worker: boolean): Promise<Run> {
  const sessionId = await $.session.id()
  const preferences = await getPreferences($)
  nativeModel = await resolveNativeModel($, nativeModel)
  // A /clear during the store read must not pair one chat's settings with
  // another chat's history. Stop this step if the owner changed.
  if (sessionId !== await $.session.id()) throw new Error('Chat changed while capturing the run.')
  const enabled = preferences.enabled && (worker || preferences.mode === 'full')
  const model = enabled ? preferences[worker ? 'subagent' : 'full'] : ''
  const effort = worker ? preferences.subagentEffort : preferences.fullEffort
  const view = await readView($).catch(() => undefined)
  const run: Run = { sessionId, nativeModel, model, effort, failed: false, captured: false, accepted: false, worker, previousNotice: view?.notice,
    previousConnectionIssue: view?.connectionIssue, noticeRevision: noticeRevisions.get(sessionId) ?? 0 }
  if (model) {
    try {
      run.connection = { ...await getConnection($) }
      if (sessionId !== await $.session.id()) throw new Error('Chat changed while capturing the connection.')
      await captureWindow($, run, run.connection, model).catch(() => undefined)
    }
    catch { await fail($, run, 'connection', INVALID_CONNECTION) }
  }
  return run
}

export async function executionSpawn($: Parameters<Hook<'agent.spawn'>>[0], e: Parameters<Hook<'agent.spawn'>>[1], next: Parameters<Hook<'agent.spawn'>>[2]) {
  // An active worker keeps its snapshot. A completed worker's next invocation
  // captures settings again, even when the host reuses its agent id.
  if (e.resume && agents.has(e.resume.agentId)) return next(e)
  // Keep the native spawn and its tools, permissions and transcript. Inherited
  // model names must refer to the parent's original native model, not our step
  // override. Explicit Agent model selections remain the native baseline.
  const parent = e.parentAgentId ? agents.get(e.parentAgentId) : inFlight.get(MAIN)
  const nativeModel = e.model ?? parent?.nativeModel ?? e.parentModel
  const run = await snapshot($, nativeModel, true)
  // Agent tools dispatch after the parent step finishes, when inFlight may
  // already be empty. Never inherit an Ollama picker selection as the native
  // startup model; the worker's own steps apply its selected Ollama model.
  let started: Awaited<ReturnType<typeof next>>
  try { started = await next(!e.resume && e.model === undefined && run ? { ...e, model: run.nativeModel } : e) }
  catch (error) {
    if (run) await releaseWindow($, run).catch(() => undefined)
    throw error
  }
  if (started.agentId && run && !agents.has(started.agentId)) {
    agents.set(started.agentId, run)
    await startAgentActivity($, run.sessionId, { id: started.agentId, model: run.model || '', confirmed: false, task: (e.description || e.prompt).replace(/\s+/g, ' ').trim().slice(0, 160), tokens: 0, running: true })
  }
  else if (run) await releaseWindow($, run).catch(() => undefined)
  return started
}

async function* observeFirstOutput(stream: ReturnType<Parameters<Hook<'turn.step'>>[2]>, start: () => void) {
  for await (const chunk of stream) {
    const output = (chunk.kind === 'text' || chunk.kind === 'thinking') ? chunk.text
      : chunk.kind === 'tool' ? chunk.name : chunk.kind === 'input' ? chunk.json : undefined
    if (output) {
      start()
      yield chunk
      return yield* stream
    }
    yield chunk
  }
  return await stream.result
}

export async function* executionStep($: Parameters<Hook<'turn.step'>>[0], e: Parameters<Hook<'turn.step'>>[1], next: Parameters<Hook<'turn.step'>>[2]) {
  // A queued native /model command produces its own host result. Cancel it
  // before inference so that result cannot replace this turn's error/output.
  if (!e.agentId) cancelInferenceSelection($)
  const loop = e.agentId ?? MAIN
  let run = e.agentId ? agents.get(e.agentId) : turns.get(e.turnId)
  if (!run && !e.agentId) {
    const owner = await $.session.id()
    noticeRevisions.set(owner, (noticeRevisions.get(owner) ?? 0) + 1)
    run = await snapshot($, e.model, false)
    if (run) turns.set(e.turnId, run)
  }
  if (!run) return yield* next(e)
  // The host resolves aliases and explicit /model changes before our override.
  if (!run.captured) {
    run.nativeModel = await resolveNativeModel($, e.model).catch(() => run.nativeModel)
    run.captured = true
    if (!e.agentId && e.model === run.nativeModel && e.model !== 'default') {
      await rememberNativeModel($, e.model).catch(() => undefined)
    }
  }
  const routed = Boolean(run.model)
  // Native steps may select a fallback of their own. Only replace an Ollama
  // selection; Off and the native main chat must respect the host's choice.
  if (!routed && e.model !== run.nativeModel && e.model !== run.model && !await isOllamaModel($, e.model).catch(() => true)) {
    run.nativeModel = e.model
  }
  const model = routed ? run.model : run.nativeModel
  const effort = routed && run.effort !== 'on' && run.effort !== 'off' ? run.effort : undefined
  run.accepted = false
  inFlight.set(loop, run)
  const activityRun = run
  run.activityEffort = !routed && typeof e.effort === 'string' ? e.effort : undefined
  const main = (running: boolean) => ({ model: activityRun.actualModel ?? model, target: activityRun.model, effort: activityRun.activityEffort, tokens: activityRun.output ?? 0, ...(activityRun.duration ? { tokensPerSecond: (activityRun.measuredOutput ?? 0) * 1000 / activityRun.duration } : {}), running })
  if (!e.agentId) await startMainActivity($, run.sessionId, main(true))
  else await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, model, running: true, failed: undefined }))
  let firstOutput: Promise<number | undefined> | undefined
  let delivered = false
  try {
    // No catch/retry around this stream: an error after delivery may follow a
    // tool call. Retrying here could execute it twice.
    const stream = next({ ...e, model, ...(effort ? { effort } : {}) })
    const result = e.agentId ? yield* stream : yield* observeFirstOutput(stream, () => { firstOutput = activityTime($) })
    delivered = true
    const ended = firstOutput && await activityTime($)
    const began = await firstOutput
    if (run.accepted && !run.failed) await recordOllamaUsage($, run.sessionId, result.usage)
    run.actualModel = result.usage?.model ?? model
    if (run.failed && routed) run.activityEffort = undefined
    const output = result.usage?.output_tokens
    if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
      run.output = (run.output ?? 0) + output
      if (began !== undefined && ended !== undefined && ended > began) {
        run.measuredOutput = (run.measuredOutput ?? 0) + output
        run.duration = (run.duration ?? 0) + ended - began
      }
    }
    if (e.agentId) await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, model: run.actualModel!, confirmed: true, tokens: run.output ?? 0 }))
    else await updateMainActivity($, run.sessionId, main(true))
    return result
  } catch (error) {
    if (run.accepted && !run.failed && !next.signal?.aborted) await fail($, run, 'stream', 'The response was interrupted before it finished.')
    throw error
  } finally {
    if (!delivered) {
      run.activityFailed = true
      if (e.agentId) await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, running: false, failed: true }))
      else await updateMainActivity($, run.sessionId, main(false))
    }
    if (inFlight.get(loop) === run) inFlight.delete(loop)
  }
}

export async function executionComplete($: Parameters<Hook<'turn.complete'>>[0], e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]) {
  let completed = false
  const run = e.agentId ? agents.get(e.agentId) : turns.get(e.turnId)
  try {
    if (run?.model && !run.failed && !e.isAborted) {
      if (e.reason === 'error') await fail($, run, 'response', 'Claude Code reported an API error before the answer finished.')
      if (e.reason === 'refusal') await fail($, run, 'refusal', 'The model declined the request.')
    }
    const result = await next(e)
    completed = true
    return result
  }
  finally {
    if (e.agentId) {
      if (run) {
        await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, running: false, failed: run.failed || run.activityFailed || !completed || e.isAborted || e.reason !== 'answer' }))
        await releaseWindow($, run).catch(() => undefined)
        history.delete(historyKey(run, e.agentId))
        void $.store.delete(templateKey(run, e.agentId)).catch(() => undefined)
      }
      agents.delete(e.agentId)
      inFlight.delete(e.agentId)
    } else {
      if (run) {
        await updateMainActivity($, run.sessionId, { model: run.actualModel ?? (run.model || run.nativeModel), target: run.model, effort: run.activityEffort, tokens: run.output ?? 0, ...(run.duration ? { tokensPerSecond: (run.measuredOutput ?? 0) * 1000 / run.duration } : {}), running: false })
        await releaseWindow($, run).catch(() => undefined)
      }
      turns.delete(e.turnId)
      // A background worker owns its own snapshot and survives this cleanup.
      inFlight.delete(MAIN)
    }
  }
}

function header(headers: Record<string, string> | undefined, name: string): string {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? ''
}

function nativeBody(body: Body, model: string): string {
  const native = { ...body, model }
  return withoutUnsignedThinking(native) ?? JSON.stringify(native)
}

export async function executionFetch($: Parameters<Hook<'http.fetch'>>[0], e: Parameters<Hook<'http.fetch'>>[1], next: Parameters<Hook<'http.fetch'>>[2]) {
  // Only inspect the engine's messages requests. Conversation and auxiliary
  // markers below decide which of those belong to this run.
  if (next.origin.plugin !== 'engine' || !/\/v1\/messages(?:\?|$)/.test(e.url) || typeof e.init?.body !== 'string') return next(e)
  const loop = header(e.init.headers, 'x-claude-code-agent-id') || MAIN
  const run = inFlight.get(loop)
  let body: Body
  try { body = JSON.parse(e.init.body) }
  catch { return run?.model ? fail($, run, 'preparation', 'The request body is invalid.') : next(e) }
  // WebSearch forwards optional empty arrays, but the API requires these
  // fields to be absent or nonempty. Keep every supplied domain restriction.
  let changed = false
  for (const tool of body.tools ?? []) {
    if (!tool.type?.startsWith('web_search')) continue
    for (const field of ['allowed_domains', 'blocked_domains'] as const) {
      if (Array.isArray(tool[field]) && tool[field].length === 0) {
        delete tool[field]
        changed = true
      }
    }
  }
  if (changed) e = { ...e, init: { ...e.init, body: JSON.stringify(body) } }
  const beta = header(e.init?.headers, 'anthropic-beta')
  const markedAuxiliary = beta.includes('auto-mode-classifier') || beta.includes('claude-code-side-query')
  // Native side requests can outlive the step, and may inherit an Ollama
  // picker selection even while Off. They always stay on the native client.
  if (markedAuxiliary) {
    if (body.model === 'default') return { deny: CHOOSE_NATIVE }
    try {
      if (body.model && await isOllamaModel($, body.model)) {
        const nativeModel = run?.nativeModel ?? await resolveNativeModel($, body.model)
        if (nativeModel === 'default') return { deny: CHOOSE_NATIVE }
        return next({ ...e, init: { ...e.init, body: nativeBody(body, nativeModel) } })
      }
    } catch { /* Classification failures leave the native request unchanged. */ }
    return next(e)
  }
  const tools = body.tools ?? []
  const continued = body.thread?.type !== undefined && body.thread.type !== 'create'
  const knownConversation = (Array.isArray(body.system) && body.system.some(block => block.text?.startsWith('x-anthropic-billing-header:'))) || body.thread !== undefined
  // Matching the active step's chosen model AND a conversation marker prevents
  // unrelated permission classifiers, suggestions and tool-side calls routing.
  const auxiliary = tools.length > 0 && tools.every(tool => tool.input_schema === undefined)
  if (!run) {
    if (knownConversation && !auxiliary && body.model && await isOllamaModel($, body.model)) {
      return fail($, { model: body.model, failed: false }, 'routing', 'The active run snapshot is unavailable. Start a new turn.')
    }
    return next(e)
  }
  // The native SDK can retry inside this same step after a stream breaks.
  // Once accepted, replay could repeat output or tool calls. A new tool-loop
  // step gets a fresh marker in executionStep; auxiliary requests are separate.
  if (run.model && knownConversation && !auxiliary && (run.accepted || run.failed)) return run.failed
    ? { deny: run.failure! }
    : { deny: 'The Ollama response was interrupted; this request cannot be replayed. Change model with /model or start a new turn.' }
  if (!run.model) {
    if (body.model !== run.nativeModel || auxiliary || !knownConversation) return next(e)
    const cleaned = withoutUnsignedThinking(body)
    const request = cleaned ? { ...e, init: { ...e.init, body: cleaned } } : e
    return forwardNative($, run, loop, request, next, body)
  }
  if (auxiliary || !knownConversation) {
    // Auxiliary calls keep their native destination. Restore an inherited
    // Ollama model name and remove unsigned thinking the native API rejects.
    const cleaned = body.model === run.model ? nativeBody(body, run.nativeModel) : withoutUnsignedThinking(body)
    const request = cleaned ? { ...e, init: { ...e.init, body: cleaned } } : e
    return next(request)
  }
  if (body.model !== run.model) {
    return fail($, run, 'routing', 'The conversation request did not match the selected Ollama model.')
  }
  if (next.signal.aborted) return { deny: 'Request cancelled.' }
  if (!run.connection) return fail($, run, 'connection', INVALID_CONNECTION)
  if (body.thread !== undefined && body.thread.type !== 'create' && body.thread.type !== 'continue') {
    return fail($, run, 'history', 'This conversation continuation is not supported. Start a new conversation.')
  }
  let whole: Body = { ...body, thread: undefined }
  if (continued) {
    let before = history.get(historyKey(run, loop))
    if (!before) {
      try { before = template(await $.store.get(templateKey(run, loop))) }
      catch { /* Missing or unreadable templates cannot reconstruct a request. */ }
      if (next.signal.aborted) return { deny: 'Request cancelled.' }
    }
    // With no cached system/tools we cannot safely invent a full payload.
    // Stop before sending any inference request.
    if (!before) return fail($, run, 'history', 'The conversation template is unavailable. Start a new conversation.')
    try {
      const transcript = await $.session.messages({ as: 'api', ...(loop !== MAIN ? { agentId: loop } : {}) })
      const lastAssistant = Array.isArray(transcript) ? transcript.findLastIndex(message => message.role === 'assistant') : -1
      if (next.signal.aborted) return { deny: 'Request cancelled.' }
      if (lastAssistant < 0) return fail($, run, 'history', 'The previous assistant response is unavailable. Start a new conversation.')
      const messages = Array.isArray(transcript) ? transcript : []
      const added = body.messages ?? []
      const hasDelta = added.length > 0 && JSON.stringify(messages.slice(-added.length)) === JSON.stringify(added)
      // Native tool continuations append user results and inline system
      // updates. The API transcript omits those per-send system updates. When
      // this run captured the previous request, retain it exactly and add the
      // latest assistant plus the exact incoming user/system delta.
      const userSystemDelta = added[0]?.role === 'user' && added.every(message => message.role === 'user' || message.role === 'system')
      if (run.lastRequest && userSystemDelta) {
        whole = wholeRequest(run.lastRequest, body, messages[lastAssistant])
      }
      else if (hasDelta) whole = { ...before, ...body, system: before.system, tools: body.tools ?? before.tools, thread: undefined, messages }
      else if (added.length > 0 && added.every(message => message.role === 'user')) {
        whole = wholeRequest({ ...before, messages: messages.slice(0, lastAssistant + 1) }, body, undefined)
      }
      else return fail($, run, 'history', 'This continuation cannot be reconstructed safely. Start a new conversation.')
    } catch (error) {
      if (next.signal.aborted) return { deny: 'Request cancelled.' }
      return fail($, run, 'history', 'The conversation history could not be read. Start a new conversation.')
    }
  }
  if (whole.tools?.some(tool => tool.allowed_domains?.length || tool.blocked_domains?.length)) {
    return fail($, run, 'request', 'Web search domain restrictions are not supported by this route.')
  }
  let request: Awaited<ReturnType<typeof prepareRequest>>
  try { request = await prepareRequest($, whole, run.model, run.effort, run.connection) }
  catch (error) {
    if (next.signal.aborted) return { deny: 'Request cancelled.' }
    if (error instanceof OllamaConnectionError) return fail($, run, 'connection', error.message)
    return fail($, run, 'preparation', 'The model capabilities or request could not be prepared. Check the selected model.', error instanceof OllamaRequestError ? error.status : undefined)
  }
  if (next.signal.aborted) return { deny: 'Request cancelled.' }
  let response: Awaited<ReturnType<typeof next>>
  try {
    run.activityEffort = request.effectiveEffort
    response = await next({ url: request.url, init: request.init })
  }
  catch (error) {
    if (next.signal.aborted) throw error
    return fail($, run, 'connection', new OllamaConnectionError(run.connection.base).message)
  }
  // Once headers were accepted, the native engine owns the stream. Do not catch
  // subsequent read failures or replay any output/tool effects.
  if (response.value?.ok) {
    run.accepted = true
    if (run.previousConnectionIssue && run.previousConnectionIssue === new OllamaConnectionError(run.connection.base).message) {
      const base = run.connection.base
      invalidateStaleConnection(base, true)
      await updateView($, state => state.owner === run.sessionId && state.endpoint === base && state.connectionIssue === run.previousConnectionIssue
        ? { ...state, connected: true, connectionIssue: undefined } : state).catch(() => undefined)
      run.previousConnectionIssue = undefined
    }
    remember($, run, loop, whole)
    return response
  }
  if (next.signal.aborted) return response
  if (!response.value) {
    // Preserve a host denial and prevent a retry from bypassing it.
    await fail($, run, 'host', 'The host blocked this request.')
    run.failure = response.deny ?? 'The host stopped this request. Start a new turn.'
    return response
  }
  return fail($, run, 'response', 'Ollama rejected the request.', response.value.status)
}
