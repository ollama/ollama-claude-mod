import type { EngineInterface, RenderInput } from 'claude-code'
import type { SubagentActivity } from '../types'
import { claudeSvg, dotCells, dotsSvg, iconImage, llamaSvg, PULSE_FRAMES } from './icons'

export { displayName } from './catalog'

export function tokenCount(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

// Reserve one row for overflow. Keep failures and running work visible first.
export function shownSubagents(rows: SubagentActivity[], limit = 5): SubagentActivity[] {
  if (rows.length <= limit) return rows
  const available = Math.max(0, limit - 1)
  const failed = rows.filter(row => row.failed).slice(0, available)
  const running = rows.filter(row => row.running && !row.failed).slice(0, available - failed.length)
  const slots = available - failed.length - running.length
  const done = slots > 0 ? rows.filter(row => !row.running && !row.failed).slice(-slots) : []
  const visible = [...failed, ...running, ...done]
  return rows.filter(row => visible.includes(row))
}

type Pulse = { frame: number; keys: string[]; isDark: boolean; timer?: { cancel: () => void } }
const pulses = new Map<string, Pulse>()

export function stopPulse(requestId?: string) {
  for (const [site, pulse] of pulses) {
    if (requestId !== undefined && site !== requestId) continue
    try { pulse.timer?.cancel() } catch { /* Optional animation. */ }
    pulses.delete(site)
  }
}

export function setPulse($: EngineInterface, requestId: string, keys: string[], isDark: boolean) {
  if (keys.length === 0) { stopPulse(requestId); return }
  const pulse = pulses.get(requestId) ?? { frame: 0, keys, isDark }
  pulse.keys = keys
  pulse.isDark = isDark
  pulses.set(requestId, pulse)
  try {
    pulse.timer ??= $.clock.every(200, async () => {
      try {
        pulse.frame = (pulse.frame + 1) % PULSE_FRAMES
        const cells = dotCells(pulse.frame, pulse.isDark)
        const results = await Promise.all(pulse.keys.map(key => $.ui.blit({ requestId, key, cells })))
        if (results.every(one => one.deny)) stopPulse(requestId)
      } catch { stopPulse(requestId) }
    })
  } catch { stopPulse(requestId) }
}

export function activityElements($: EngineInterface, e: RenderInput<'AbovePrompt'>, isDark: boolean) {
  const els = $.ui.resolve(e)
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
  const Image = e.surface === 'terminal' && 'Image' in els ? els.Image : undefined
  const Raster = e.surface === 'terminal' && 'Raster' in els ? els.Raster : undefined
  const keys: string[] = []
  return {
    keys,
    logo: (isClaude: boolean, size: number) => Svg
      ? <Svg source={isClaude ? claudeSvg() : llamaSvg()} alt={isClaude ? 'Claude' : 'Ollama'} width={size} height={size} />
      : Image ? <Image source={iconImage(isClaude ? 'claude' : 'llama')} columns={2} rows={1} alt={isClaude ? '✻' : '🦙'} /> : null,
    dots: (key: string) => {
      if (Raster) {
        keys.push(key)
        return <Raster key={key} columns={3} rows={1} cells={dotCells(pulses.get(e.requestId)?.frame ?? 0, isDark)} />
      }
      return Svg ? <Svg source={dotsSvg()} alt="working" width={18} height={6} /> : <els.Text dimColor>…</els.Text>
    },
  }
}
