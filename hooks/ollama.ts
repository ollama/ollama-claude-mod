import type { EngineInterface, HttpInit } from 'claude-code'
import type { OllamaModel, Thinking } from '../types'
import { connectionAddress, parseShow, shortName, toOllamaBody } from './route'
import { CLOUD_CATALOG, cloudModels, isChatModel, isCloudModel, mergeModels } from './catalog'

export type Connection = Readonly<{ base: string; key: string }>
const CONNECTION_KEY = 'connection-v1'

export class OllamaRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

export class OllamaConnectionError extends Error {
  constructor(readonly endpoint: string) {
    const host = new URL(endpoint).host
    super(endpoint === 'https://ollama.com'
      ? `Can't reach ${host}. Check your internet connection and try again.`
      : `Can't reach Ollama at ${host}. Check that Ollama is running and that the address in Settings → Advanced is correct.`)
  }
}

export async function getConnection($: EngineInterface): Promise<Connection> {
  const saved = await $.store.get(CONNECTION_KEY)
  if (saved !== undefined && (typeof saved !== 'string' || !saved)) {
    throw new Error('The saved Ollama address is invalid. Enter the address in Settings → Advanced.')
  }
  const base = connectionAddress(saved ?? await $.env.get('OLLAMA_HOST') ?? '')
  // Existing cloud credentials are read from the environment only. They are
  // never copied into a chat record or sent to a custom endpoint.
  const key = base === 'https://ollama.com' ? await $.env.get('OLLAMA_API_KEY') ?? '' : ''
  return Object.freeze({ base, key })
}

export async function saveConnection($: EngineInterface, value: string): Promise<void> {
  const base = connectionAddress(value)
  await $.store.set(CONNECTION_KEY, base)
}

function headers(connection: Connection): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(connection.base === 'https://ollama.com' && connection.key ? { authorization: `Bearer ${connection.key}` } : {}),
  }
}

async function readModel($: EngineInterface, connection: Connection, name: string): Promise<OllamaModel | undefined> {
  const model = connection.base === 'https://ollama.com' ? shortName(name) : name
  const response = await $.http.fetch(`${connection.base}/api/show`, {
    method: 'POST', headers: headers(connection), body: JSON.stringify({ model }),
  }).catch(() => { throw new OllamaConnectionError(connection.base) })
  if (!response.ok) throw new OllamaRequestError('Ollama could not load this model.', response.status)
  const shown = JSON.parse(response.text) as { capabilities?: string[]; remote_host?: string }
  if (!Array.isArray(shown.capabilities)) throw new Error('Ollama returned invalid model capabilities.')
  if (!isChatModel(shown.capabilities)) return undefined
  const parsed = parseShow(response.text)
  const cloud = connection.base === 'https://ollama.com' || isCloudModel(name, shown.remote_host)
  return { name, ...parsed, contextLength: cloud ? parsed.contextLength : parsed.parameterContext ?? 0, maximumContext: parsed.contextLength || undefined, isCloud: cloud, isDecision: false }
}

export async function showModel($: EngineInterface, connection: Connection, name: string): Promise<OllamaModel> {
  const model = await readModel($, connection, name)
  if (!model) throw new Error('Choose an Ollama chat model that supports tools.')
  return model
}

export type Discovery = { models: OllamaModel[]; complete: boolean; connected: boolean; connectionIssue?: string }

export async function discoverModels($: EngineInterface, connection: Connection): Promise<Discovery> {
  const direct = connection.base === 'https://ollama.com'
  const catalog = direct ? undefined : $.http.fetch(CLOUD_CATALOG)
    .then(response => response.ok ? cloudModels(response.text) : undefined).catch(() => undefined)
  const response = await $.http.fetch(`${connection.base}/api/tags`, { headers: headers(connection) }).catch(() => undefined)
  let cloud = catalog ? await catalog : undefined
  let local: string[] = []
  let connected = false
  try {
    if (response?.ok) {
      const result = JSON.parse(response.text) as { models?: { name?: string }[] }
      if (!Array.isArray(result.models) || result.models.some(model => !model || typeof model.name !== 'string' || !model.name.trim())) throw new Error('Invalid model list')
      if (direct) cloud = cloudModels(response.text)
      else local = result.models.map(model => model.name!)
      connected = true
    }
  } catch { /* A partial catalog can add models, but must not remove any. */ }
  if (!connected) {
    const connectionIssue = !response ? new OllamaConnectionError(connection.base).message
      : response.status === 401 || response.status === 403 ? 'Ollama refused access to the model list. Check your Ollama sign-in.'
      : 'Could not read the Ollama model list. Check the address in Settings → Advanced.'
    return { models: cloud ?? [], complete: false, connected: false, connectionIssue }
  }
  let complete = cloud !== undefined
  cloud ??= []
  const names = [...new Set([...local, ...cloud.map(model => model.name)])]
  const models: OllamaModel[] = []
  // Limit concurrent discovery requests; never pull or download a model here.
  for (let index = 0; index < names.length; index += 4) {
    const batch = await Promise.all(names.slice(index, index + 4).map(name => readModel($, connection, name).catch(() => {
      // Public cloud rows remain valid when the daemon cannot show them yet.
      if (!cloud.some(model => model.name === name)) complete = false
      return undefined
    })))
    models.push(...batch.filter((model): model is OllamaModel => model !== undefined))
  }
  return { models: mergeModels(models, cloud), complete, connected }
}

export async function prepareRequest(
  $: EngineInterface,
  body: Parameters<typeof toOllamaBody>[0],
  model: string,
  effort: Thinking | undefined,
  connection: Connection,
): Promise<{ url: string; init: HttpInit; effectiveEffort?: Thinking }> {
  if (!model.trim()) throw new Error('Choose an Ollama model.')
  const capabilities = await showModel($, connection, model)
  // Omit an unsupported override so Ollama resolves its own model default.
  const supportedEffort = effort !== undefined && capabilities.efforts.includes(effort) ? effort : undefined
  // Ollama gives an explicit thinking switch precedence over named effort.
  // Clear Claude's switch in this copy; the original remains intact for native requests.
  const request = {
    ...body,
    thinking: undefined,
    output_config: supportedEffort && !['on', 'off'].includes(supportedEffort) ? { effort: supportedEffort } : undefined,
  }
  return {
    url: `${connection.base}/v1/messages`,
    effectiveEffort: supportedEffort ?? capabilities.defaultEffort,
    init: {
      method: 'POST',
      headers: { ...headers(connection), 'anthropic-version': '2023-06-01' },
      body: toOllamaBody(request, connection.base === 'https://ollama.com' ? shortName(model) : model, supportedEffort),
    },
  }
}

// Running local allocations, unlike model_info, describe the context actually
// reserved by Ollama. Failure or an unloaded model leaves allocation unknown.
export async function runningContext($: EngineInterface, connection: Connection, name: string): Promise<number | undefined> {
  const response = await $.http.fetch(`${connection.base}/api/ps`, { headers: headers(connection) })
  if (!response.ok) return undefined
  const result = JSON.parse(response.text) as { models?: { name?: string; model?: string; context_length?: number }[] }
  const normalized = (value: string) => value.includes(':') ? value : `${value}:latest`
  const model = result.models?.find(model => [model.name, model.model].some(value => value && normalized(value) === normalized(name)))
  const length = model?.context_length
  return Number.isSafeInteger(length) && length! > 0 ? length : undefined
}
