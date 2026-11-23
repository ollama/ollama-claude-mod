import type { EngineInterface, RenderInput } from 'claude-code'
import type { OpenMenu } from '../types'

export type Menu = {
  key: string
  label?: string
  value: string
  options: { value: string; label: string }[]
  searchable?: boolean
  onSelect: (value: string) => Promise<void>
}

function matches(option: Menu['options'][number], query: string): boolean {
  const text = `${option.label} ${option.value}`.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every(term => text.includes(term))
}

function soleMatch(options: Menu['options'], query: string) {
  const id = query.trim().toLowerCase()
  if (!id) return undefined
  if (options.length === 1) return options[0]
  const exact = options.filter(option => option.value.toLowerCase() === id)
  return exact.length === 1 ? exact[0] : undefined
}

export function pickerMenu($: EngineInterface, e: RenderInput<'AbovePrompt'>, open: OpenMenu | undefined, menu: Menu, setOpen: (open: OpenMenu) => Promise<void>) {
  const { Box, Button, Input, Text } = $.ui.resolve(e)
  const { key, label, value, onSelect } = menu
  const selectedLabel = menu.options.find(one => one.value === value)?.label ?? value
  const title = [label, selectedLabel].filter(Boolean).join(': ')
  const isOpen = open?.key === key
  const query = isOpen ? open.query ?? '' : ''
  const options = isOpen && query.trim() ? menu.options.filter(one => matches(one, query)) : menu.options
  const rowGap = menu.searchable && e.surface === 'desktop' ? 1 : 0
  const rowHeight = 1 + rowGap
  // Ordinary catalogs stay mounted. For large catalogs, spacers preserve the
  // full scroll height while the host moves through a bounded set of buttons.
  const virtual = isOpen && menu.searchable && options.length > 128
  const viewport = Math.ceil((e.props.scroll?.bodyRows || e.props.maxRows) / rowHeight)
  const offset = Math.floor((e.props.scroll?.offset ?? 0) / rowHeight)
  const overscan = 16
  const first = virtual ? Math.max(0, Math.min(offset - overscan, options.length - viewport - overscan)) : 0
  const end = virtual ? Math.min(options.length, first + viewport + 2 * overscan) : options.length
  const pick = (choice: string) => async () => {
    await setOpen(null)
    await onSelect(choice)
  }
  const button = (one: Menu['options'][number]) => (
    <Button key={`${key}-option-${one.value}`} plain label={`${one.value === value ? '✓ ' : '  '}${one.label}`} onPress={pick(one.value)} />
  )
  return (
    <Box key={`${key}-menu`} flexDirection="column" alignItems="flex-start">
      <Button key={key} plain={e.surface === 'desktop' ? undefined : true} label={`${title}${isOpen ? ' ▴' : ' ▾'}`}
        onPress={() => setOpen(isOpen ? null : { key })} />
      {isOpen ? (
        <Box key={`${key}-list`} flexDirection="column" flexShrink={0} paddingX={1} paddingTop={rowGap} rowGap={rowGap}>
          {menu.searchable ? <Input key={`${key}-search`} placeholder="Search models" value={query} autoFocus submitLabel={e.surface === 'terminal' ? '' : undefined}
            onInput={query => setOpen({ key, query })}
            onSubmit={text => {
              const found = menu.options.filter(one => matches(one, text))
              const choice = soleMatch(found, text)
              return choice ? pick(choice.value)() : setOpen({ key, query: text })
            }} /> : null}
          {options.length === 0 ? <Text dimColor>No models found</Text> : virtual ? (
            <Box key={`${key}-results`} flexDirection="column" alignItems="flex-start" flexShrink={0}>
              {first > 0 ? <Box key="before" height={first * rowHeight} flexShrink={0} /> : null}
              {options.slice(first, end).map(one => (
                <Box key={`row-${one.value}`} height={rowHeight} flexShrink={0}>{button(one)}</Box>
              ))}
              {end < options.length ? <Box key="after" height={(options.length - end) * rowHeight} flexShrink={0} /> : null}
            </Box>
          ) : options.map(button)}
        </Box>
      ) : null}
    </Box>
  )
}
