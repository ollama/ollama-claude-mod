import type { Effort, Thinking } from '../types'

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

type Show = { parameters?: string; model_info?: Record<string, unknown>; thinking?: { values?: unknown[] } }

// /api/show names the context length after the model's architecture, as in
// `kimi-k3.context_length`. Its thinking.values hold the model's effort names,
// and false and true where the model can turn thinking off and on.
export function parseShow(text: string): { contextLength: number; parameterContext?: number; efforts: Thinking[] } {
  const show = JSON.parse(text) as Show
  const info = show.model_info ?? {}
  const architecture = info['general.architecture']
  const lengths = Object.entries(info).filter(([key]) => key.endsWith('.context_length'))
  const length = typeof architecture === 'string' ? info[`${architecture}.context_length`] : lengths.length === 1 ? lengths[0]?.[1] : undefined
  const efforts = (show.thinking?.values ?? []).flatMap((value): Thinking[] =>
    value === false ? ['off'] : value === true ? ['on'] : EFFORT_LEVELS.includes(value as Effort) ? [value as Effort] : [],
  )

  const parameter = /^\s*num_ctx\s+(\d+)\s*$/m.exec(show.parameters ?? '')
  const parameterContext = parameter ? Number(parameter[1]) : undefined
  return { contextLength: Number.isSafeInteger(length) && Number(length) > 0 ? Number(length) : 0, ...(parameterContext && Number.isSafeInteger(parameterContext) ? { parameterContext } : {}), efforts }
}

type Block = { type: string; text?: string; signature?: string; input_schema?: unknown; allowed_domains?: string[]; blocked_domains?: string[]; cache_control?: { ttl?: string; scope?: string } }
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

// Ollama's thinking blocks carry no signature, and the Anthropic API rejects
// an unsigned thinking block. Undefined when nothing needs to change.
export function withoutUnsignedThinking(body: Body): string | undefined {
  let isChanged = false
  const messages = body.messages?.map(message => {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      return message
    }
    const content = message.content.filter(block => !(block.type === 'thinking' && !block.signature))
    isChanged ||= content.length !== message.content.length

    return { ...message, content }
  })

  return isChanged ? JSON.stringify({ ...body, messages }) : undefined
}

export function shortName(model: string): string {
  return model ? model.replace(/[:-]cloud$/, '') : 'Claude'
}
