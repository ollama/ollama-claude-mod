import type { OllamaModel } from '../types'

export const CLOUD_CATALOG = 'https://ollama.com/api/tags'

export type PickerRow = { model: string; label: string; description: string }

export function isChatModel(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes('tools') && !capabilities.includes('decision')
}

export function isCloudModel(name: string, remoteHost?: string): boolean {
  return Boolean(remoteHost) || /[:-]cloud$/.test(name)
}

export function modelRow(model: Pick<OllamaModel, 'name' | 'isCloud'>): PickerRow {
  return { model: model.name, label: `Ollama · ${model.name}`, description: model.isCloud ? 'Ollama Cloud' : 'Local Ollama' }
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
