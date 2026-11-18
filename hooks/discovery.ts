import type { EngineInterface } from 'claude-code'
import type { OllamaModel } from '../types'
import { mergeModels } from './catalog'
import { discoverModels, getConnection } from './ollama'
import type { Connection, Discovery } from './ollama'

const MAX_AGE = 5 * 60 * 1000
const RETRY_AFTER = 30 * 1000
type Cached = { at: number; discovery: Discovery }
const cached = new Map<string, Cached>()
const pending = new Map<string, Promise<Discovery>>()
let syncing = Promise.resolve()
let synchronized = ''
let conflicts = 0

function cacheKey(base: string): string {
  return `model-discovery-v1:${encodeURIComponent(base)}`
}

function savedModels(value: unknown): OllamaModel[] {
  if (!Array.isArray(value)) return []
  return value.filter((model): model is OllamaModel => model && typeof model === 'object' &&
    typeof model.name === 'string' && model.name.trim() && typeof model.isCloud === 'boolean' && model.isDecision === false &&
    Number.isSafeInteger(model.contextLength) && model.contextLength >= 0 && Array.isArray(model.efforts) &&
    model.efforts.every((effort: unknown) => ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(effort))))
}

export async function loadModels($: EngineInterface, connection: Connection, force = false): Promise<Discovery> {
  const base = connection.base
  const now = await $.clock.now()
  const previous = cached.get(base)
  // A retired model or unavailable server must not restart discovery on every click.
  const maxAge = previous?.discovery.complete ? MAX_AGE : RETRY_AFTER
  if (!force && previous && now >= previous.at && now - previous.at < maxAge) return previous.discovery
  const loading = pending.get(base)
  if (loading) return loading
  const operation = (async () => {
    const before = previous?.discovery.models ?? savedModels(await $.store.get(cacheKey(base)).catch(() => undefined))
    let discovery: Discovery
    try {
      discovery = await discoverModels($, connection)
      if (!discovery.complete) discovery.models = mergeModels(discovery.models, before)
      // Failure to save a cache must not discard a usable live catalog.
      await $.store.set(cacheKey(base), discovery.models).catch(() => undefined)
    } catch {
      discovery = { models: before, connected: false, complete: false }
    }
    cached.set(base, { at: now, discovery })
    return discovery
  })()
  pending.set(base, operation)
  try { return await operation }
  finally { if (pending.get(base) === operation) pending.delete(base) }
}

export async function syncNativePicker($: EngineInterface, connection: Connection, discovery: Discovery): Promise<void> {
  if (await $.env.get('CLAUDE_CODE_ENTRYPOINT') === 'claude-desktop') return
  const input = JSON.stringify({ models: discovery.models, complete: discovery.complete })
  const identity = JSON.stringify([connection.base, input])
  // Different refreshes may finish together. Serialize their helper processes,
  // and check the saved address again before writing installation-wide rows.
  const operation = syncing.catch(() => undefined).then(async () => {
    if (synchronized === identity) return
    if ((await getConnection($)).base !== connection.base) return
    const result = await $.process.run(['node', `${$.plugin.root}/scripts/model-picker.mjs`, 'install', '--catalog-stdin'], {
      stdin: input, timeoutMs: 10000,
    })
    if (result.exitCode === 75 && ++conflicts < 3) return
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Automatic /model setup failed. Check that Node 22.18 or newer is installed.')
    conflicts = 0
    synchronized = identity
  })
  syncing = operation.catch(() => undefined)
  await operation
}
