import { atom, read, update } from 'claude-code'
import type { EngineInterface, TurnUsage } from 'claude-code'
import type { ActivityState, MainActivity, SubagentActivity } from '../types'

const empty = (owner: string): ActivityState => ({ owner, subagents: [], hidden: false })
const activity = atom({ plugin: 'ollama', key: 'activity' } as const, empty(''), { shape: 'activity-v1' })
const MAX_ROWS = 24

// Activity is transient and optional. State or clock failures never affect a
// response, its transport, or the host's completion lifecycle.
export async function readActivity($: EngineInterface): Promise<ActivityState> {
  let owner = ''
  try {
    owner = await $.session.id()
    const current = await read($, activity)
    return current.owner === owner && await $.session.id() === owner ? current : empty(owner)
  } catch { return empty(owner) }
}

export async function resetActivity($: EngineInterface, owner: string): Promise<void> {
  try {
    if (await $.session.id() !== owner) return
    await update($, activity, () => empty(owner))
  } catch { /* Optional display state. */ }
}

async function change($: EngineInterface, owner: string, apply: (state: ActivityState) => ActivityState, claimOnStart = false): Promise<void> {
  try {
    if (await $.session.id() !== owner) return
    await update($, activity, current => {
      if (current.owner === owner) return apply(current)
      return claimOnStart ? apply(empty(owner)) : current
    })
  } catch { /* Optional display state. */ }
}

export async function toggleActivity($: EngineInterface, owner: string): Promise<void> {
  await change($, owner, state => ({ ...state, hidden: !state.hidden }))
}

export async function startMainActivity($: EngineInterface, owner: string, main: MainActivity, fresh: boolean): Promise<void> {
  await change($, owner, state => ({ ...state, main, subagents: fresh ? state.subagents.filter(row => row.running) : state.subagents }), true)
}

export async function startAgentActivity($: EngineInterface, owner: string, row: SubagentActivity): Promise<void> {
  await change($, owner, state => ({
    ...state,
    hidden: state.hidden && state.subagents.some(agent => agent.running),
    subagents: [...state.subagents.filter(one => one.id !== row.id), row].slice(-MAX_ROWS),
  }), true)
}

export async function updateMainActivity($: EngineInterface, owner: string, main: MainActivity): Promise<void> {
  await change($, owner, state => ({ ...state, main }))
}

export async function updateAgentActivity($: EngineInterface, owner: string, id: string, apply: (row: SubagentActivity) => SubagentActivity): Promise<void> {
  await change($, owner, state => {
    const index = state.subagents.findIndex(row => row.id === id)
    if (index < 0) return state
    const before = state.subagents[index]!
    const row = apply(before)
    const subagents = state.subagents.slice()
    subagents[index] = row
    let hidden = state.hidden
    if (row.failed && !before.failed) hidden = false
    else if (before.running && !row.running && subagents.every(agent => !agent.running && !agent.failed)) hidden = true
    return { ...state, subagents, hidden }
  })
}

function validTokens(count: unknown): count is number {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
}

export async function recordOllamaUsage($: EngineInterface, owner: string, usage: TurnUsage | null | undefined): Promise<void> {
  // Anthropic-compatible usage splits input into uncached, cache-read and
  // cache-write tokens. Missing usage is unknown, never a measured zero.
  const counts = [usage?.input_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0]
  const input = counts.every(validTokens) ? counts.reduce((total, count) => total + count, 0) : undefined
  const output = validTokens(usage?.output_tokens) ? usage.output_tokens : undefined
  await change($, owner, state => {
    const previous = state.ollama ?? { requests: 0, inputTokens: 0, outputTokens: 0 }
    return { ...state, ollama: {
      requests: previous.requests + 1,
      inputTokens: previous.inputTokens !== undefined && input !== undefined ? previous.inputTokens + input : undefined,
      outputTokens: previous.outputTokens !== undefined && output !== undefined ? previous.outputTokens + output : undefined,
    } }
  })
}

export async function activityTime($: EngineInterface): Promise<number | undefined> {
  try { const now = await $.clock.now(); return Number.isFinite(now) ? now : undefined } catch { return undefined }
}
