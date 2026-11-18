import type { EngineInterface, Hook, HttpInit } from 'claude-code'
import type { Thinking } from '../types'
import { getPreferences } from './runtime'
import { getConnection, prepareRequest } from './ollama'
import type { Connection } from './ollama'
import { toOllamaBody, wholeRequest, withoutUnsignedThinking } from './route'
import { captureWindow, releaseWindow } from './window'
import { isOllamaModel, rememberNativeModel, resolveNativeModel } from './models'
import { activityTime, recordOllamaUsage, startAgentActivity, startMainActivity, updateAgentActivity, updateMainActivity } from './activity'

type Body = Parameters<typeof toOllamaBody>[0]
type Run = {
  sessionId: string
  connection?: Connection
  model: string
  effort?: Thinking
  nativeModel: string
  failed: boolean
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
const MAIN = 'main'
const CHOOSE_NATIVE = 'Choose a Claude model once with /model so Ollama can fall back to it.'

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
  if (run.failed) await releaseWindow($, run).catch(() => undefined)
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
  // another chat's history. This step stays native if the owner changed.
  if (sessionId !== await $.session.id()) throw new Error('Chat changed while capturing the run.')
  const enabled = preferences.enabled && (worker || preferences.mode === 'full')
  const model = enabled ? (preferences.mode === 'full' ? preferences.full : preferences.subagent) : ''
  const effort = preferences.mode === 'full' ? preferences.fullEffort : preferences.subagentEffort
  const run: Run = { sessionId, nativeModel, model, effort, failed: false, captured: false, accepted: false }
  if (model) {
    try {
      run.connection = { ...await getConnection($) }
      if (sessionId !== await $.session.id()) throw new Error('Chat changed while capturing the connection.')
      await captureWindow($, run, run.connection, model).catch(() => undefined)
    }
    catch { run.failed = true }
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
  const run = await snapshot($, nativeModel, true).catch(() => undefined)
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
    await startAgentActivity($, run.sessionId, { id: started.agentId, model: started.model, task: (e.description || e.prompt).replace(/\s+/g, ' ').trim().slice(0, 160), tokens: 0, running: true })
  }
  else if (run) await releaseWindow($, run).catch(() => undefined)
  return started
}

export async function* executionStep($: Parameters<Hook<'turn.step'>>[0], e: Parameters<Hook<'turn.step'>>[1], next: Parameters<Hook<'turn.step'>>[2]) {
  const loop = e.agentId ?? MAIN
  let run = e.agentId ? agents.get(e.agentId) : turns.get(e.turnId)
  if (!run && !e.agentId) {
    run = await snapshot($, e.model, false).catch(() => undefined)
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
  const routed = Boolean(run.model && run.connection && !run.failed)
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
  run.activityEffort = routed ? run.effort ?? (typeof e.effort === 'string' ? e.effort : undefined) : typeof e.effort === 'string' ? e.effort : undefined
  const main = (running: boolean) => ({ model: activityRun.actualModel ?? model, target: activityRun.model, effort: activityRun.activityEffort, tokens: activityRun.output ?? 0, ...(activityRun.duration ? { tokensPerSecond: (activityRun.measuredOutput ?? 0) * 1000 / activityRun.duration } : {}), running })
  if (!e.agentId) await startMainActivity($, run.sessionId, main(true), e.index === 0)
  else await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, model, running: true, failed: undefined }))
  const began = await activityTime($)
  let delivered = false
  try {
    // No catch/retry around this stream: an error after delivery may follow a
    // tool call. Retrying here could execute it twice.
    const result = yield* next({ ...e, model, ...(effort ? { effort } : {}) })
    delivered = true
    const ended = await activityTime($)
    if (run.accepted && !run.failed) await recordOllamaUsage($, run.sessionId, result.usage)
    run.actualModel = result.usage?.model ?? (run.failed ? run.nativeModel : model)
    if (run.failed && routed) run.activityEffort = undefined
    const output = result.usage?.output_tokens
    if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
      run.output = (run.output ?? 0) + output
      if (began !== undefined && ended !== undefined && ended > began) {
        run.measuredOutput = (run.measuredOutput ?? 0) + output
        run.duration = (run.duration ?? 0) + ended - began
      }
    }
    if (e.agentId) await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, model: run.actualModel!, tokens: run.output ?? 0 }))
    else await updateMainActivity($, run.sessionId, main(true))
    return result
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
  try { const result = await next(e); completed = true; return result }
  finally {
    if (e.agentId) {
      const run = agents.get(e.agentId)
      if (run) {
        await updateAgentActivity($, run.sessionId, e.agentId, row => ({ ...row, running: false, failed: run.activityFailed || !completed || e.isAborted || e.reason !== 'answer' }))
        await releaseWindow($, run).catch(() => undefined)
        history.delete(historyKey(run, e.agentId))
        void $.store.delete(templateKey(run, e.agentId)).catch(() => undefined)
      }
      agents.delete(e.agentId)
      inFlight.delete(e.agentId)
    } else {
      const run = turns.get(e.turnId)
      if (run) {
        await updateMainActivity($, run.sessionId, { model: run.actualModel ?? (run.failed ? run.nativeModel : run.model || run.nativeModel), target: run.model, effort: run.activityEffort, tokens: run.output ?? 0, ...(run.duration ? { tokensPerSecond: (run.measuredOutput ?? 0) * 1000 / run.duration } : {}), running: false })
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
  catch { return next(e) }
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
  if (!run) return next(e)
  const tools = body.tools ?? []
  const continued = body.thread?.type !== undefined && body.thread.type !== 'create'
  const knownConversation = (Array.isArray(body.system) && body.system.some(block => block.text?.startsWith('x-anthropic-billing-header:'))) || (body.thread?.type === 'continue')
  // Matching the active step's chosen model AND a conversation marker prevents
  // unrelated permission classifiers, suggestions and tool-side calls routing.
  const auxiliary = tools.length > 0 && tools.every(tool => tool.input_schema === undefined)
  // The native SDK can retry inside this same step after a stream breaks.
  // Once accepted, replay could repeat output or tool calls. A new tool-loop
  // step gets a fresh marker in executionStep; auxiliary requests are separate.
  if (run.accepted && knownConversation && !auxiliary) return { deny: 'The model response was interrupted. Start a new turn to continue.' }
  if (!run.model) {
    if (body.model !== run.nativeModel || auxiliary || !knownConversation) return next(e)
    const cleaned = withoutUnsignedThinking(body)
    const request = cleaned ? { ...e, init: { ...e.init, body: cleaned } } : e
    return forwardNative($, run, loop, request, next, body)
  }
  if (body.model !== run.model || auxiliary || !knownConversation) {
    // Auxiliary calls keep their native destination. Restore an inherited
    // Ollama model name and remove unsigned thinking the native API rejects.
    const cleaned = body.model === run.model ? nativeBody(body, run.nativeModel) : withoutUnsignedThinking(body)
    const request = cleaned ? { ...e, init: { ...e.init, body: cleaned } } : e
    return body.model === run.nativeModel && !auxiliary && knownConversation ? forwardNative($, run, loop, request, next, body) : next(request)
  }
  let original = { ...e, init: { ...e.init, body: nativeBody(body, run.nativeModel) } }
  if (next.signal.aborted) return { deny: 'Request cancelled.' }
  if (run.failed || !run.connection) return forwardNative($, run, loop, original, next, body)
  let whole: Body = { ...body, thread: undefined }
  if (continued) {
    let before = history.get(historyKey(run, loop))
    if (!before) {
      try { before = template(await $.store.get(templateKey(run, loop))) }
      catch { /* Missing or unreadable cache uses the original native request. */ }
      if (next.signal.aborted) return { deny: 'Request cancelled.' }
    }
    // With no cached system/tools we cannot safely invent a full payload.
    // Try the original native request once; its server thread may be stale.
    if (!before) { run.failed = true; return forwardNative($, run, loop, original, next, body) }
    try {
      const transcript = await $.session.messages({ as: 'api', ...(loop !== MAIN ? { agentId: loop } : {}) })
      const lastAssistant = Array.isArray(transcript) ? transcript.findLastIndex(message => message.role === 'assistant') : -1
      if (next.signal.aborted) return { deny: 'Request cancelled.' }
      if (lastAssistant < 0) { run.failed = true; return forwardNative($, run, loop, original, next, body) }
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
      else { run.failed = true; return forwardNative($, run, loop, original, next, body) }
    } catch (error) {
      if (next.signal.aborted) return { deny: 'Request cancelled.' }
      run.failed = true
      return forwardNative($, run, loop, original, next, body)
    }
  }
  // A thread created on Ollama does not exist at Anthropic. Once rebuilt,
  // fallback sends that full conversation without a server thread reference.
  original = { ...e, init: { ...e.init, body: nativeBody(whole, run.nativeModel) } }
  if (whole.tools?.some(tool => tool.allowed_domains?.length || tool.blocked_domains?.length)) {
    run.failed = true
    return forwardNative($, run, loop, original, next, whole)
  }
  let request: { url: string; init: HttpInit }
  try { request = await prepareRequest($, whole, run.model, run.effort, run.connection) }
  catch (error) {
    if (next.signal.aborted) return { deny: 'Request cancelled.' }
    run.failed = true
    return forwardNative($, run, loop, original, next, whole)
  }
  if (next.signal.aborted) return { deny: 'Request cancelled.' }
  let response: Awaited<ReturnType<typeof next>>
  try {
    response = await next(request)
  }
  catch (error) {
    if (next.signal.aborted) throw error
    run.failed = true
    return forwardNative($, run, loop, original, next, whole)
  }
  // Once headers were accepted, the native engine owns the stream. Do not catch
  // subsequent read failures or replay any output/tool effects.
  if (response.value?.ok) {
    run.accepted = true
    remember($, run, loop, whole)
    return response
  }
  if (next.signal.aborted) return response
  run.failed = true
  return forwardNative($, run, loop, original, next, whole)
}
