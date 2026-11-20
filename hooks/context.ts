import type { EngineInterface, Hook } from 'claude-code'
import { getPreferences } from './runtime'

const PREFIX = 'ollama routing: '
const LEGACY_PREFIX = 'ollama-chat routing: '
const NOTE = /(^|\n)ollama(?:-chat)? routing: [^\n]*/g
const SECTION = {
  id: 'ollama:routing',
  scope: 'session',
  text: [
    '# Ollama routing',
    'The ollama plugin can route this conversation and native Agent subagents to Ollama. The Agent tool still lists Claude model aliases: these choose the native startup model, not necessarily the model used after plugin routing.',
    'Use the native Agent tool normally. Omit its model argument unless a specific native model is wanted.',
  ].join('\n\n'),
} as const

async function routingNote($: EngineInterface): Promise<string> {
  try {
    const owner = await $.session.id()
    const preferences = await getPreferences($)
    if (owner !== await $.session.id()) return `${PREFIX}Settings changed with the chat; the current target is not confirmed.`
    if (!preferences.enabled) return `${PREFIX}Off for new work; use native Claude Code models.`
    const worker = JSON.stringify(preferences.subagent)
    const intent = preferences.mode === 'full'
      ? `Full; configured targets ${JSON.stringify(preferences.full)} for this conversation and ${worker} for native subagents`
      : `Subagents; this conversation stays native, configured target ${worker} for native subagents`
    return `${PREFIX}${intent}. Use the native Agent tool; its model aliases select the native startup model, and omitting model inherits routing.`
  } catch {
    return `${PREFIX}Current settings could not be read; do not assume an Ollama target or successful routing.`
  }
}

export async function composeRoutingContext($: EngineInterface, e: Parameters<Hook<'prompt.compose'>>[1], next: Parameters<Hook<'prompt.compose'>>[2]) {
  const composed = await next(e)
  if (!e.tools.includes('Agent')) return composed
  return { ...composed, sections: [...composed.sections.filter(section => section.id !== SECTION.id && section.id !== 'ollama-chat:routing'), SECTION] }
}

export async function submitRoutingContext($: EngineInterface, e: Parameters<Hook<'prompt.submit'>>[1], next: Parameters<Hook<'prompt.submit'>>[2]) {
  const context = (e.context ?? []).filter(text => !text.startsWith(PREFIX) && !text.startsWith(LEGACY_PREFIX))
  return next({ ...e, context: [...context, await routingNote($)] })
}

// A prompt typed during a turn is stored later. Refresh only our own note at
// that point so a setting changed while it waited is not described as current.
export async function refreshQueuedRoutingContext($: EngineInterface, e: Parameters<Hook<'session.append'>>[1], next: Parameters<Hook<'session.append'>>[2]) {
  if (e.door !== 'hook-context' || !e.message.content.some(block => typeof block.text === 'string' && /(^|\n)ollama(?:-chat)? routing: /.test(block.text))) return next(e)
  const note = await routingNote($)
  const content = e.message.content.map(block => typeof block.text === 'string' ? { ...block, text: block.text.replace(NOTE, (_, lineBreak) => `${lineBreak}${note}`) } : block)
  return next({ ...e, message: { ...e.message, content } })
}
