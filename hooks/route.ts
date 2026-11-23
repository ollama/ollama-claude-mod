import type { Effort, OllamaModel, Thinking } from '../types'

const EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Reads OLLAMA_HOST as Ollama's envconfig.ConnectableHost does: scheme and
// port are optional, the default port follows the scheme, a path is dropped,
// and an unspecified bind address means this computer.
export function ollamaHost(value = ''): string {
  const raw = value.trim()
  if (raw === 'ollama.com') {
    return 'https://ollama.com:443'
  }
  const hasScheme = raw.includes('://')
  const [scheme = 'http', rest = ''] = hasScheme ? raw.split('://', 2) : ['http', raw]
  const defaultPort = !hasScheme ? '11434' : scheme === 'https' ? '443' : scheme === 'http' ? '80' : '11434'
  const hostport = rest.split('/')[0] ?? ''
  const match = /^(\[[^\]]*\]|[^:]*):(\d+)$/.exec(hostport)
  const bare = match?.[1] ?? (hostport || '127.0.0.1')
  // An IPv6 address given without brackets, which a URL needs around it.
  const host = bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare
  const connectable = host === '0.0.0.0' ? '127.0.0.1' : host === '::' || host === '[::]' ? '[::1]' : host

  return `${scheme}://${connectable}:${match?.[2] ?? defaultPort}`
}

export function connectionAddress(value: string): string {
  const url = new URL(ollamaHost(value))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS Ollama address without credentials.')
  }
  return url.origin
}

type Show = { parameters?: string; model_info?: Record<string, unknown>; thinking?: { values?: unknown[]; default?: unknown } }

function parseThinking(value: unknown): Thinking | undefined {
  if (value === false) return 'off'
  if (value === true) return 'on'
  return EFFORT_LEVELS.find(level => level === value)
}

// /api/show names the context length after the model's architecture, as in
// `kimi-k3.context_length`. Its thinking.values hold the model's effort names,
// and false and true where the model can turn thinking off and on.
export function parseShow(text: string): Pick<OllamaModel, 'contextLength' | 'parameterContext' | 'efforts' | 'defaultEffort'> {
  const show = JSON.parse(text) as Show
  const info = show.model_info ?? {}
  const architecture = info['general.architecture']
  const lengths = Object.entries(info).filter(([key]) => key.endsWith('.context_length'))
  const length = typeof architecture === 'string' ? info[`${architecture}.context_length`] : lengths.length === 1 ? lengths[0]?.[1] : undefined
  const efforts = (show.thinking?.values ?? []).map(parseThinking).filter((value): value is Thinking => value !== undefined)
  const defaultEffort = parseThinking(show.thinking?.default)

  const parameter = /^\s*num_ctx\s+(\d+)\s*$/m.exec(show.parameters ?? '')
  const parameterContext = parameter ? Number(parameter[1]) : undefined
  return {
    contextLength: Number.isSafeInteger(length) && Number(length) > 0 ? Number(length) : 0,
    ...(parameterContext && Number.isSafeInteger(parameterContext) ? { parameterContext } : {}),
    efforts,
    ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  }
}

type Block = { type: string; text?: string; signature?: string; id?: string; tool_use_id?: string; input_schema?: unknown; allowed_domains?: string[]; blocked_domains?: string[]; cache_control?: { ttl?: string; scope?: string } }
type Message = { role: string; content: string | Block[] }
type Body = {
  model?: string
  system?: string | Block[]
  thread?: { type?: string }
  tools?: Block[]
  messages?: Message[]
}

// A continuation usually omits the system prompt and tools. ToolSearch can
// supply an updated tool list, which replaces the cached list. Ollama keeps
// no thread, so rebuild the history with the reply and incoming messages.
export function wholeRequest(before: Body, request: Body, reply: Message | undefined): Body {
  const added = request.messages ?? []
  const replied = reply !== undefined && added[0]?.role !== 'assistant' ? [reply] : []

  return { ...request, system: before.system, tools: request.tools ?? before.tools, thread: undefined, messages: [...(before.messages ?? []), ...replied, ...added] }
}

// Workflow agents publish the assistant reply one row at a time. Pair its
// tool calls with this continuation before attaching it to the saved request.
export function workflowContinuation(before: Body | undefined, rows: (Block[] | undefined)[], request: Body): Body | undefined {
  const added = request.messages ?? []
  if (!before?.messages?.length || rows.includes(undefined) || added[0]?.role !== 'user' ||
      added.some(message => message.role !== 'user' && message.role !== 'system')) return undefined

  const content = rows.flatMap(row => row ?? [])
  if (!content.length) return undefined
  const calls = content.filter(block => block.type === 'tool_use').map(block => block.id)
  const results = added.flatMap(message => message.role === 'user' && Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_result') : [])
  const pending = new Set(calls)
  if (calls.length !== results.length) return undefined
  if (results.some(block => typeof block.tool_use_id !== 'string' || !pending.delete(block.tool_use_id))) return undefined
  return wholeRequest(before, request, { role: 'assistant', content })
}

export function toOllamaBody(body: Body, model: string, thinking?: Thinking): string {
  // Ollama 0.40.16 supports web search; other server tools need Anthropic.
  const tools = body.tools?.filter(tool => tool.input_schema !== undefined || tool.type.startsWith('web_search'))
  // This leading billing block changes each turn and would invalidate the
  // whole Ollama cache prefix. Keep the rest of the system prompt intact.
  const system = Array.isArray(body.system) ? body.system.filter(block => !block.text?.startsWith('x-anthropic-billing-header:')) : body.system
  // Ollama's explicit thinking switch takes precedence over named effort.
  const switched = thinking === 'off' ? { thinking: { type: 'disabled' } } : thinking === 'on' ? { thinking: { type: 'enabled' } } : {}

  return JSON.stringify({ ...body, model, tools, system, ...switched })
}

// Claude rejects unsigned thinking and empty assistant turns in the history.
// Return undefined when the original request can pass through unchanged.
export function withoutUnsignedThinking(body: Body): string | undefined {
  let isChanged = false
  const messages = body.messages?.flatMap(message => {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      return [message]
    }
    const content = message.content.filter(block => !(block.type === 'thinking' && !block.signature))
    if (content.length === message.content.length) return [message]
    isChanged = true
    return content.length ? [{ ...message, content }] : []
  })

  return isChanged ? JSON.stringify({ ...body, messages }) : undefined
}

export function shortName(model: string): string {
  return model ? model.replace(/[:-]cloud$/, '') : 'Claude'
}
