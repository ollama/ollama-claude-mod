import type { EngineInterface, RenderInput } from 'claude-code'
import type { OpenMenu } from '../types'

export type Menu = {
  key: string
  label: string
  value: string
  options: { value: string; label: string }[]
  searchable?: boolean
  onSelect: (value: string) => Promise<void>
}

function matches(option: Menu['options'][number], query: string): boolean {
  const text = `${option.label} ${option.value}`.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every(term => text.includes(term))
}

const MAX_OPTIONS = 64

// Native Select owns keyboard navigation and scrolling on every surface.
// Search still covers the entire catalog; only the rendered choices are bounded.
export function pickerMenu($: EngineInterface, e: RenderInput<'AbovePrompt'>, open: OpenMenu | undefined, menu: Menu, setOpen: (open: OpenMenu) => Promise<void>) {
  const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
  const { key, label, value, onSelect } = menu
  const isOpen = open?.key === key
  const query = isOpen ? open.query ?? '' : ''
  const options = menu.options.filter(one => matches(one, query))
  const selected = options.findIndex(one => one.value === value)
  const first = Math.max(0, Math.min(selected - Math.floor(MAX_OPTIONS / 2), options.length - MAX_OPTIONS))
  const shown = options.slice(first, first + MAX_OPTIONS)
  const pick = (choice: string) => async () => {
    await setOpen(null)
    await onSelect(choice)
  }
  return (
    <Box key={`${key}-menu`} flexDirection="column" alignItems="flex-start">
      <Button key={key} plain label={`${label ? `${label}: ` : ''}${menu.options.find(one => one.value === value)?.label ?? value}${isOpen ? ' ▴' : ' ▾'}`}
        onPress={() => setOpen(isOpen ? null : { key, first: 0 })} />
      {isOpen ? (
        <Box flexDirection="column" paddingX={1}>
          {menu.searchable ? <Input key={`${key}-search`} placeholder="Search models" value={query} autoFocus submitLabel="Choose"
            onInput={query => setOpen({ key, query, first: 0 })}
            onSubmit={text => {
              const found = menu.options.filter(one => matches(one, text))
              const exact = found.filter(one => one.value.toLowerCase() === text.trim().toLowerCase())
              const choice = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined
              if (choice) return pick(choice.value)()
            }} /> : null}
          {options.length === 0 ? <Text dimColor>No models found</Text> : menu.searchable ? (
            <Select key={`${key}-options`} label="Model" value={shown.some(one => one.value === value) ? value : undefined}
              options={shown.map(one => ({ value: one.value, label: `${one.value === value ? '✓ ' : ''}${one.label}` }))}
              onSelect={choice => pick(choice)()} />
          ) : options.map(one => (
            <Button key={`${key}-option-${one.value}`} plain label={`${one.value === value ? '✓ ' : '  '}${one.label}`} onPress={pick(one.value)} />
          ))}
          {options.length > shown.length ? <Text dimColor>{`Showing ${shown.length} of ${options.length} models. Search to narrow the list.`}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}
