import type { EngineInterface, Hook, RenderInput, RenderSurface } from 'claude-code'
import { readView } from './runtime'
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

function soleMatch(options: Menu['options'], query: string) {
  const id = query.trim().toLowerCase()
  if (!id) return undefined
  if (options.length === 1) return options[0]
  const exact = options.filter(option => option.value.toLowerCase() === id)
  return exact.length === 1 ? exact[0] : undefined
}

type ScrollWindow = { surface: RenderSurface; offset: number; columns: number; key: string; query: string; first: number; rows: number; count: number; setOpen: (open: OpenMenu) => Promise<void> }
const windows = new Map<string, ScrollWindow>()

export function clearPickerWindows(surface?: RenderSurface): void {
  for (const [id, window] of windows) if (!surface || window.surface === surface) windows.delete(id)
}

export async function scrollPicker($: EngineInterface, e: Parameters<Hook<'ui.scroll'>>[1], next: Parameters<Hook<'ui.scroll'>>[2]) {
  const window = windows.get(e.requestId)
  if (e.component !== 'AbovePrompt' || e.origin.kind !== 'person' || !window) return next(e)
  if (e.pointer) {
    const row = e.pointer.row + window.offset
    const footer = window.count > window.rows ? 1 : 0
    const end = e.contentRows - footer
    if (e.pointer.column < 0 || e.pointer.column >= window.columns || row < end - Math.min(window.rows, window.count) || row >= end) return next(e)
  }
  const current = (await readView($)).openMenu
  if (windows.get(e.requestId) !== window || current?.key !== window.key || (current.query ?? '') !== window.query) return next(e)
  const first = Math.max(0, Math.min(window.first + Math.trunc(e.by), window.count - window.rows))
  if (first === window.first) return {}
  window.first = first
  await window.setOpen({ key: window.key, query: window.query, first })
  $.ui.invalidate('ui.render')
  // Pin the band while its model rows move. This also handles wheel events
  // at the host's scroll boundary, so catalogs never need paging buttons.
  return next({ ...e, offset: 0 })
}

// Keep real result buttons within the tree limit; person-origin scrolling
// slides over the full filtered catalog, even when its name is not known.
export function pickerMenu($: EngineInterface, e: RenderInput<'AbovePrompt'>, open: OpenMenu | undefined, menu: Menu, setOpen: (open: OpenMenu) => Promise<void>) {
  const { Box, Button, Input, Text } = $.ui.resolve(e)
  const { key, label, value, onSelect } = menu
  const isOpen = open?.key === key
  const query = isOpen ? open.query ?? '' : ''
  const options = menu.options.filter(one => matches(one, query))
  const selected = options.findIndex(one => one.value === value)
  // Small overscan keeps the native band scrollable for arrow/Page keys.
  const rows = Math.max(3, Math.min(24, e.props.maxRows - 2))
  const first = Math.max(0, Math.min(isOpen && open.first >= 0 ? open.first : selected - Math.floor(rows / 2), options.length - rows))
  const shown = menu.searchable ? options.slice(first, first + rows) : options
  if (isOpen && menu.searchable) windows.set(e.requestId, { surface: e.surface, offset: e.props.scroll?.offset ?? 0, columns: e.props.bodyColumns, key, query, first, rows, count: options.length, setOpen })
  else if (windows.get(e.requestId)?.key === key) windows.delete(e.requestId)
  while (windows.size > 16) windows.delete(windows.keys().next().value!)
  const move = (by: number) => setOpen({ key, query, first: Math.max(0, Math.min(first + by, options.length - rows)) })
  const pick = (choice: string) => async () => {
    await setOpen(null)
    await onSelect(choice)
  }
  return (
    <Box key={`${key}-menu`} flexDirection="column" alignItems="flex-start">
      <Button key={key} plain label={`${label ? `${label}: ` : ''}${menu.options.find(one => one.value === value)?.label ?? value}${isOpen ? ' ▴' : ' ▾'}`}
        onPress={() => setOpen(isOpen ? null : { key, first: -1 })} />
      {isOpen ? (
        <Box flexDirection="column" paddingX={1}>
          {menu.searchable ? <Input key={`${key}-search`} placeholder="Search models" value={query} autoFocus submitLabel={e.surface === 'terminal' ? '' : soleMatch(options, query) ? 'Use model' : 'Search'}
            onInput={query => setOpen({ key, query, first: 0 })}
            onSubmit={text => {
              const found = menu.options.filter(one => matches(one, text))
              const choice = soleMatch(found, text)
              return choice ? pick(choice.value)() : setOpen({ key, query: text, first: 0 })
            }} /> : null}
          {options.length === 0 ? <Text dimColor>No models found</Text> : shown.map(one => (
            <Button key={`${key}-option-${one.value}`} plain label={`${one.value === value ? '✓ ' : '  '}${one.label}`} onPress={pick(one.value)} />
          ))}
          {menu.searchable && options.length > rows ? <Box key={`${key}-position`} flexDirection="row" columnGap={1}>
            <Text dimColor>{`${first + 1}–${first + shown.length} of ${options.length}`}</Text>
            <Button key={`${key}-scroll-up`} plain hotkey="k" label="↑" onPress={() => move(-1)} />
            <Button key={`${key}-scroll-down`} plain hotkey="j" label="↓" onPress={() => move(1)} />
          </Box> : null}
        </Box>
      ) : null}
    </Box>
  )
}
