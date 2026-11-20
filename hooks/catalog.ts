import type { OllamaModel } from '../types'

export const CLOUD_CATALOG = 'https://ollama.com/api/tags'

export type PickerRow = { model: string; label: string; description: string }

export function isChatModel(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes('tools') && !capabilities.includes('decision')
}

export function isCloudModel(name: string, remoteHost?: string): boolean {
  return Boolean(remoteHost) || /[:-]cloud$/.test(name)
}

// Bare names and :latest identify the same Ollama tag. No other suffix is
// removed: versions, sizes, quantizations and local/cloud are distinct models.
export function canonicalModel(name: string): string {
  return name.replace(/:latest-cloud$/, ':cloud').replace(/:latest$/, '')
}

export function modelLabel(model: Pick<OllamaModel, 'name' | 'isCloud'>): string {
  const name = model.name.replace(/(?::cloud|-cloud)$/, '').replace(/:latest$/, '')
  const label = name.replace(/^kimi-k(\d[\w.-]*)$/i, (_, version: string) => `Kimi K${version.replace(/-pro$/, ' Pro')}`)
    .replace(/^deepseek-v(\d[\w.-]*)$/i, (_, version: string) => `DeepSeek V${version.replace(/-flash$/, ' Flash')}`)
    .replace(/^glm-(\d[\w.-]*)$/i, (_, version: string) => `GLM ${version.replace(/-flash$/, ' Flash')}`)
  return `${label}${model.isCloud ? ' · Cloud' : ''}`
}

function recommendation(name: string): number {
  const canonical = canonicalModel(name)
  if (canonical === 'kimi-k3.1-pro:cloud') return 0
  if (canonical === 'deepseek-v4.1-flash:cloud') return 1
  return 2
}

export function compareModels(a: { name: string }, b: { name: string }): number {
  return recommendation(a.name) - recommendation(b.name) || a.name.localeCompare(b.name)
}

export function modelChoices<T extends Pick<OllamaModel, 'name' | 'isCloud' | 'isDecision'>>(models: T[], selected?: string | readonly string[]): T[] {
  const selectedNames = new Set(typeof selected === 'string' ? [selected] : selected)
  const groups = new Map<string, T[]>()
  for (const model of models) {
    if (model.isDecision) continue
    const key = `${model.isCloud}:${canonicalModel(model.name)}`
    groups.set(key, [...(groups.get(key) ?? []), model])
  }
  return [...groups.values()].flatMap(group => {
    const retained = group.filter(model => selectedNames.has(model.name))
    return retained.length ? retained : [group.reduce((a, b) => a.name.length <= b.name.length ? a : b)]
  }).sort(compareModels)
}

export function modelRow(model: Pick<OllamaModel, 'name' | 'isCloud'>): PickerRow {
  return { model: model.name, label: `Ollama · ${modelLabel(model)}`, description: model.isCloud ? 'Ollama Cloud' : 'Local Ollama' }
}

export function cloudModels(text: string): OllamaModel[] {
  const data = JSON.parse(text) as { models?: { name?: string; capabilities?: string[]; details?: { context_length?: number } }[] }
  if (!Array.isArray(data.models) || data.models.some(model => !model || typeof model.name !== 'string' || !model.name.trim() || !Array.isArray(model.capabilities))) throw new Error('Ollama returned an invalid cloud model list.')
  return data.models.flatMap(model => {
    if (!model.name?.trim() || !isChatModel(model.capabilities)) return []
    const name = isCloudModel(model.name) ? model.name : `${model.name}${model.name.includes(':') ? '-cloud' : ':cloud'}`
    const length = model.details?.context_length
    return [{ name, isCloud: true, isDecision: false, contextLength: Number.isSafeInteger(length) && length! > 0 ? length! : 0, efforts: [] }]
  })
}

export function mergeModels(local: OllamaModel[], cloud: OllamaModel[]): OllamaModel[] {
  return [...new Map([...cloud, ...local].map(model => [model.name, model])).values()].sort((a, b) => a.name.localeCompare(b.name))
}
