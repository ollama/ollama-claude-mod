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

function matches(label: string, query: string): boolean {
  return query.toLowerCase().trim().split(/\s+/).every(term => label.toLowerCase().includes(term))
}

// Native controls keep search and paging local to the open picker.
export function pickerMenu($: EngineInterface, e: RenderInput<'AbovePrompt'>, open: OpenMenu | undefined, menu: Menu, setOpen: (open: OpenMenu) => Promise<void>) {
  const { Box, Button, Input, Text } = $.ui.resolve(e)
  const { key, label, value, onSelect } = menu
  const isOpen = open?.key === key
  const query = isOpen ? open.query ?? '' : ''
  const options = menu.options.filter(one => matches(one.label, query))
  const rows = Math.max(1, Math.min(6, e.props.maxRows - (menu.searchable ? 6 : 5)))
  const selected = options.findIndex(one => one.value === value)
  const first = Math.max(0, Math.min(isOpen && open.first >= 0 ? open.first : selected - Math.floor(rows / 2), Math.max(0, options.length - rows)))
  const end = Math.min(first + rows, options.length)
  const pick = (choice: string) => async () => {
    await setOpen(null)
    await onSelect(choice)
  }
  return (
    <Box key={`${key}-menu`} flexDirection="column" alignItems="flex-start">
      <Button key={key} plain label={`${label}: ${menu.options.find(one => one.value === value)?.label ?? value}${isOpen ? ' ▴' : ' ▾'}`}
        onPress={() => setOpen(isOpen ? null : { key, first: -1 })} />
      {isOpen ? (
        <Box flexDirection="column" paddingX={1}>
          {menu.searchable ? <Input key={`${key}-search`} placeholder="Search models" value={query} autoFocus submitLabel="Choose"
            onInput={query => setOpen({ key, query, first: 0 })}
            onSubmit={text => {
              const choice = menu.options.find(one => matches(one.label, text))
              if (choice) return pick(choice.value)()
            }} /> : null}
          {options.length === 0 ? <Text dimColor>No models found</Text> : null}
          {first > 0 ? <Button key={`${key}-up`} plain dimColor label={`▲ ${first} more`} onPress={() => setOpen({ key, query, first: Math.max(0, first - rows) })} /> : null}
          {options.slice(first, end).map(one => (
            <Button key={`${key}-option-${one.value}`} plain label={`${one.value === value ? '✓ ' : '  '}${one.label}`} onPress={pick(one.value)} />
          ))}
          {end < options.length ? <Button key={`${key}-down`} plain dimColor label={`▼ ${options.length - end} more`} onPress={() => setOpen({ key, query, first: end })} /> : null}
        </Box>
      ) : null}
    </Box>
  )
}
