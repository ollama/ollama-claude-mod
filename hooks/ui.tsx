import type { EngineInterface, RenderInput } from 'claude-code'
import type { ActivityState, Mode, OpenMenu, SubagentActivity, Thinking, ViewState } from '../types'
import { activityElements, displayName, setPulse, shownSubagents, tokenCount } from './activity-view'
import { pickerMenu } from './menu'
import type { Menu } from './menu'
import { modelChoices, modelLabel } from './catalog'

export type UIState = ViewState & { activity?: ActivityState; isDark?: boolean; showMode?: boolean }

export type UIActions = {
  setMode: (mode: Mode | 'never') => Promise<void>
  setModel: (model: string) => Promise<void>
  setEffort: (effort: Thinking | undefined) => Promise<void>
  toggleSettings: () => Promise<void>
  toggleSubagents: () => Promise<void>
  setOpenMenu: (open: OpenMenu) => Promise<void>
  setEndpoint: (endpoint: string) => Promise<void>
  setContext: (value: string) => Promise<void>
  refresh: () => Promise<void>
}

const effortLabels: Record<Thinking, string> = {
  off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
}

export const modeLabels: Record<Mode, string> = { full: 'Always', subagent: 'Subagents Only' }
const modeOptions = Object.entries({ never: 'Never', subagent: modeLabels.subagent, full: modeLabels.full }).map(([value, label]) => ({ value, label }))

function workerName(row: SubagentActivity): string {
  const name = row.model ? displayName(row.model) : ''
  if (row.confirmed !== false) return name || 'Subagent'
  return row.running ? `${name ? name + ' · ' : ''}Starting…` : name || 'Subagent'
}

export function renderUI($: EngineInterface, e: RenderInput<'AbovePrompt'>, state: UIState, actions: UIActions) {
  const els = $.ui.resolve(e)
  const { Box, Button, Input, Select, Text } = els
  const { preferences } = state
  const model = preferences[preferences.mode]
  const effort = preferences.mode === 'full' ? preferences.fullEffort : preferences.subagentEffort
  const models = state.settingsOpen ? modelChoices(state.models, model) : []
  const selected = models.find(one => one.name === model)
  const options = models.map(one => ({ value: one.name, label: modelLabel(one) }))
  // Keep unavailable saved models visible without changing the user's choice.
  if (model && !selected) options.unshift({ value: model, label: `${model} (unavailable)` })
  if (!model) options.unshift({ value: '', label: 'Choose model' })
  const efforts = selected?.efforts ?? []
  const isTerminal = e.surface === 'terminal'
  const advanced = state.openMenu?.key === 'advanced'
  const openRow = !advanced && (isTerminal || state.openMenu?.key === 'model') ? state.openMenu?.key : undefined
  const picker = (menu: Menu) => isTerminal || menu.searchable
    ? pickerMenu($, e, state.openMenu, menu, actions.setOpenMenu)
    : <Select key={menu.key} label={menu.label} value={menu.value} options={menu.options} onSelect={menu.onSelect} />
  const window = state.modelWindow?.model === model && state.modelWindow.endpoint === state.endpoint ? state.modelWindow : undefined
  const contextValue = window?.effective ? String(window.effective) : ''
  const usagePicker = (key: string, label = 'When to use Ollama') => picker({ key, label, value: preferences.enabled ? preferences.mode : 'never',
    options: modeOptions, onSelect: value => actions.setMode(value as Mode | 'never') })
  const target = state.selection?.current ?? (preferences.enabled && preferences.mode === 'full' ? preferences.full : '')
  const native = !target
  // A late response belongs to its captured target. Never present it as the
  // newly selected model (especially after switching back to Claude).
  const main = state.activity?.main?.target === target ? state.activity.main : undefined
  const isClaude = native || !!main?.model && /^(claude|opus|sonnet|haiku)/i.test(main.model)
  const title = native ? (main?.model ? displayName(main.model) : 'Claude') : main?.model || target ? displayName(main?.model || target) : 'Choose model'
  const summary = `${title}${state.selection ? state.selection.status === 'pending' ? ' · Switching…' : ' · Switch failed' : ''}${preferences.enabled && !state.connected ? ' · Not connected' : ''}`
  const rows = preferences.enabled ? state.activity?.subagents ?? [] : []
  const hidden = state.activity?.hidden ?? false
  const showRows = !hidden && !state.settingsOpen
  const succeeded = rows.length > 0 && rows.every(row => !row.running && !row.failed)
  const shown = showRows ? shownSubagents(rows, Math.max(1, Math.min(5, e.props.maxRows - 2))) : []
  const remaining = showRows && shown.length < rows.length ? rows.filter(row => !shown.includes(row)) : []
  const usage = state.activity?.ollama ?? { requests: 0, inputTokens: 0, outputTokens: 0 }
  const usageLabel = [
    'Ollama',
    `${usage.requests.toLocaleString('en-US')} ${usage.requests === 1 ? 'request' : 'requests'}`,
    ...(usage.inputTokens !== undefined ? [`${usage.inputTokens.toLocaleString('en-US')} input tokens`] : []),
    ...(usage.outputTokens !== undefined ? [`${usage.outputTokens.toLocaleString('en-US')} output tokens`] : []),
  ].join(' · ')
  const visuals = activityElements($, e, state.isDark ?? false)
  const mainEffort = main?.effort ?? (!native ? preferences.fullEffort : undefined)
  const summaryEffort = mainEffort === 'on' || mainEffort === 'off'
    ? `Thinking ${mainEffort}` : mainEffort ? effortLabels[mainEffort] : undefined
  const bar = (
    <Box key="ollama-bar" flexDirection="column" paddingX={1} rowGap={isTerminal ? 0 : 0.5}>
      <Box key="summary" flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={1}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          <Text key="summary-status" weight="bold" color={isClaude ? 'claude' : undefined} wrap="truncate-end">{summary}</Text>
          {summaryEffort ? <Text key="summary-effort" dimColor wrap="truncate-end">{`· ${summaryEffort}`}</Text> : null}
          {main?.tokensPerSecond !== undefined && Number.isFinite(main.tokensPerSecond)
            ? <Text key="summary-speed" dimColor tabular wrap="truncate-end">{`· ${Math.round(main.tokensPerSecond * 10) / 10} tok/s`}</Text> : null}
        </Box>
        {!state.settingsOpen && rows.length > 0 ? <Button key="subagents-toggle" plain dimColor
          label={`${rows.length} ${rows.length === 1 ? 'subagent' : 'subagents'}${succeeded ? ' ✓' : ''} ${hidden ? '▸' : '▾'}`} onPress={actions.toggleSubagents} /> : null}
        {!state.settingsOpen ? usagePicker('compact-mode', state.showMode === false ? '' : undefined) : null}
        {state.selection?.status === 'failed' ? <Button key="retry-switch" plain label="Retry" onPress={() => actions.setMode(preferences.enabled ? preferences.mode : 'never')} /> : null}
        <Button key="settings" plain dimColor label={state.settingsOpen ? 'Done' : 'Settings'} onPress={actions.toggleSettings} />
      </Box>
      {state.notice ? <Text key="notice">{state.notice}</Text> : null}
      {shown.map(row => <Box key={`subagent-${row.id}`} flexDirection="row" alignItems="center" columnGap={2} paddingLeft={1}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor>↳</Text>
          <Box flexShrink={1} minWidth={0}><Text weight="medium" color={/^(claude|opus|sonnet|haiku)/i.test(row.model) ? 'claude' : undefined} wrap="truncate-end">{workerName(row)}</Text></Box>
          <Box flexShrink={1000} minWidth={0}><Text dimColor wrap="truncate-end">{`· ${row.task}`}</Text></Box>
        </Box>
        <Box flexShrink={0}><Text key={`tokens-${row.id}`} dimColor tabular>{`${tokenCount(row.tokens)} tokens`}</Text></Box>
        <Box width={row.failed ? 7 : 3} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="flex-end">
          {row.running ? visuals.dots(`dots-${row.id}`) : row.failed
            ? <Text key={`status-${row.id}`} color="warning">Stopped</Text>
            : <Text key={`status-${row.id}`} color="success">✓</Text>}
        </Box>
      </Box>)}
      {remaining.length > 0 ? <Box key="subagents-left" flexDirection="row" columnGap={1} paddingLeft={1}>
        <Text dimColor>↳</Text><Text dimColor>{`+${remaining.length} ${remaining.every(row => !row.running && !row.failed) ? 'done' : 'more'}`}</Text>
      </Box> : null}
      {state.settingsOpen ? (
        <Box key="settings-panel" flexDirection="column" rowGap={isTerminal ? 0 : 0.5}>
          <Box key="controls" flexDirection="row" flexWrap="wrap" alignItems="flex-start" columnGap={2} rowGap={1}>
            {usagePicker('mode')}
          </Box>
          {!openRow || openRow === 'model' ? picker({ key: 'model', label: 'Model', value: model, options, searchable: true, onSelect: actions.setModel }) : null}
          {efforts.length > 0 && (!openRow || openRow === 'effort') ? picker({ key: 'effort', label: 'Effort', value: effort && efforts.includes(effort) ? effort : '',
            options: [{ value: '', label: 'Default' }, ...efforts.map(value => ({ value, label: effortLabels[value] }))],
            onSelect: value => actions.setEffort(value ? value as Thinking : undefined) }) : null}
          {!openRow ? <Button key="advanced" plain dimColor label={`Advanced ${advanced ? '▾' : '▸'}`}
            onPress={() => actions.setOpenMenu(advanced ? null : { key: 'advanced', first: 0 })} /> : null}
          {advanced ? <Box key="settings-details" flexDirection="column" rowGap={isTerminal ? 0 : 0.5}>
            {model ? <Input key={`context-${state.endpoint}-${model}`} label="Context length" value={contextValue} submitLabel={isTerminal ? '' : 'Save'}
              onSubmit={value => value.trim() === contextValue ? undefined : actions.setContext(value)} /> : null}
            <Text key="ollama-usage" dimColor wrap="truncate-end">{usageLabel}</Text>
            <Box key="connection" flexDirection="row" alignItems="center" columnGap={1}>
              <Input key="endpoint" label="Ollama address" value={state.endpoint} placeholder="http://localhost:11434" submitLabel={isTerminal ? '' : 'Save'} onSubmit={actions.setEndpoint} />
              {state.connected ? <Text key="connection-status" dimColor>Connected</Text>
                : <Button key="refresh" plain label="Refresh" onPress={actions.refresh} />}
            </Box>
          </Box> : null}
        </Box>
      ) : null}
    </Box>
  )
  setPulse($, e.requestId, visuals.keys, state.isDark ?? false)
  return bar
}
