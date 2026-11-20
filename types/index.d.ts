export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Thinking = Effort | 'off' | 'on'
export type Mode = 'full' | 'subagent'

export type Preferences = {
  enabled: boolean
  mode: Mode
  full: string
  subagent: string
  fullEffort?: Thinking
  subagentEffort?: Thinking
}

export type OllamaModel = {
  name: string
  isCloud: boolean
  contextLength: number
  maximumContext?: number
  parameterContext?: number
  efforts: Thinking[]
  defaultEffort?: Thinking
  isDecision: boolean
}

export type ModelWindow = { model?: string; endpoint?: string; maximum?: number; detected?: number; effective?: number; override?: number; source: 'cloud' | 'running' | 'parameters' | 'manual' | 'unknown' }

export type OpenMenu = { key: string; query?: string } | null

export type MainActivity = { model: string; target: string; effort?: Thinking; tokens: number; tokensPerSecond?: number; running: boolean }
export type SubagentActivity = { id: string; model: string; confirmed?: boolean; task: string; tokens: number; running: boolean; failed?: boolean }
export type OllamaUsage = { requests: number; inputTokens?: number; outputTokens?: number }
export type ActivityState = { owner: string; main?: MainActivity; subagents: SubagentActivity[]; hidden: boolean; ollama?: OllamaUsage }

export type ViewState = {
  owner?: string
  activity?: ActivityState
  selection?: { target: string; current: string; status: 'pending' | 'failed' }
  preferences: Preferences
  models: OllamaModel[]
  connected: boolean
  connectionIssue?: string
  endpoint: string
  settingsOpen: boolean
  openMenu?: OpenMenu
  modelWindow?: ModelWindow
  notice: string
}

// The native mod contract is self-contained: no imports from runtime modules.
declare module 'claude-code' {
  interface PluginState {
    'ollama': {
      view: Shaped<ViewState>
      activity: Shaped<ActivityState>
      appearance: Shaped<{ isDark: boolean }>
      windowOwner: Shaped<{ previous?: string; written?: string }>
    }
  }
}
