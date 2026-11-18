import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

const appearance = atom({ plugin: 'ollama', key: 'appearance' } as const, { isDark: true }, { shape: 'appearance-v1' })

export async function refreshAppearance($: EngineInterface): Promise<void> {
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  // Auto follows the terminal background, which the mod API cannot read.
  await update($, appearance, () => ({ isDark: !String(theme).startsWith('light') }))
}

export async function readAppearance($: EngineInterface): Promise<{ isDark: boolean }> {
  return read($, appearance)
}
