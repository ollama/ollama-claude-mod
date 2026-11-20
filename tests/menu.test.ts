import { expect, test } from 'claude-code/testing'
import type { EngineInterface, Hook, RenderInput } from 'claude-code'
import type { OpenMenu } from '../types'
import { clearPickerWindows, pickerMenu, scrollPicker } from '../hooks/menu'

test('person wheel and keyboard deltas browse a bounded window through the complete catalog', async () => {
  let open: OpenMenu = { key: 'model', first: 0 }
  let invalidated = 0
  const engine = {
    session: { id: async () => 'scroll-chat' },
    state: { get: async () => ({ value: { shape: 'view-v1', value: { owner: 'scroll-chat', openMenu: open } }, version: 0 }) },
    ui: { resolve: () => ({ Box: 'Box', Button: 'Button', Input: 'Input', Text: 'Text' }), invalidate: () => { invalidated++ } },
  } as unknown as EngineInterface
  const render = () => pickerMenu(engine, { surface: 'terminal', component: 'AbovePrompt', requestId: 'wheel-test', props: { maxRows: 16, bodyColumns: 80, scroll: { offset: 0 } } } as RenderInput<'AbovePrompt'>, open,
    { key: 'model', label: 'Model', value: 'model-0', searchable: true, options: Array.from({ length: 1000 }, (_, i) => ({ value: `model-${i}`, label: `Model ${i}` })), onSelect: async () => {} },
    async value => { open = value })
  const offsets: number[] = []
  const next = (async (e: { offset: number }) => { offsets.push(e.offset); return {} }) as unknown as Parameters<Hook<'ui.scroll'>>[2]
  const event = { component: 'AbovePrompt', requestId: 'wheel-test', offset: 0, by: 1, bodyRows: 16, contentRows: 20, origin: { kind: 'person' }, pointer: { row: 8, column: 5 } } as Parameters<Hook<'ui.scroll'>>[1]
  render()
  for (let i = 0; i < 12; i++) { await scrollPicker(engine, event, next); render() }
  expect(open?.first).toBe(12)
  expect(offsets.every(offset => offset === 0)).toBe(true)
  await scrollPicker(engine, { ...event, by: 10000, pointer: undefined }, next)
  expect(open?.first).toBe(986)
  render()
  await scrollPicker(engine, { ...event, by: -10000, pointer: undefined }, next)
  expect(open?.first).toBe(0)
  expect(invalidated).toBe(14)
  render()
  await scrollPicker(engine, { ...event, by: -1 }, next)
  expect(invalidated).toBe(14)
  await scrollPicker(engine, { ...event, pointer: { row: 0, column: 5 } }, next)
  expect(open?.first).toBe(0)
  render()
  await scrollPicker(engine, { ...event, by: 100, origin: { kind: 'plugin', name: 'ollama' } }, next)
  expect(open?.first).toBe(0)
  open = null
  await scrollPicker(engine, event, next)
  expect(open).toBe(null)
  clearPickerWindows('terminal')
})
