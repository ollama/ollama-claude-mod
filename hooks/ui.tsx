import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { ActivityState, Mode, ModelWindow, OpenMenu, SubagentActivity, Thinking, ViewState } from '../types'
import { activityElements, displayName, setPulse, shownSubagents, tokenCount } from './activity-view'
import { pickerMenu } from './menu'
import type { Menu } from './menu'
import { modelChoices, modelLabel } from './catalog'
import { resolveNativeModel } from './models'

export type UIState = ViewState & { activity?: ActivityState; isDark?: boolean; showResponseSpeed?: boolean }

export type UIActions = {
  setMode: (mode: Mode | 'never') => Promise<void>
  setModel: (model: string) => Promise<void>
  setEffort: (effort: Thinking | undefined) => Promise<void>
  setShowResponseSpeed: (show: boolean) => Promise<void>
  toggleSettings: () => Promise<void>
  toggleSubagents: () => Promise<void>
  setOpenMenu: (open: OpenMenu) => Promise<void>
  setEndpoint: (endpoint: string) => Promise<void>
  setContext: (value: string) => Promise<void>
  refresh: () => Promise<void>
}

// Desktop measures box widths in character cells. This matches its 28 px control height.
const settingsButtonColumns = 3.75

const effortLabels: Record<Thinking, string> = {
  off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max',
}

export const modeLabels: Record<Mode | 'never', string> = { full: 'Full', subagent: 'Subagents', never: 'Off' }
const modeOptions = Object.entries(modeLabels).map(([value, label]) => ({ value, label }))

const contextPresets = [65_536, 131_072, 262_144, 524_288, 1_048_576]

function contextLengthLabel(tokens: number): string {
  for (const [size, unit] of [[1_048_576, 'M'], [1_000_000, 'M'], [1024, 'K'], [1000, 'K']] as const) {
    if (tokens % size === 0) return `${tokens / size}${unit}`
  }
  return tokens.toLocaleString('en-US')
}

function contextLengthOptions(window: ModelWindow | undefined, automatic: number | undefined) {
  const limit = window?.detected ?? window?.maximum ?? Infinity
  const sizes = new Set(contextPresets.filter(size => size <= limit))
  if (window?.defaultContext && window.defaultContext <= limit) sizes.add(window.defaultContext)
  if (automatic) sizes.add(automatic)
  if (window?.override) sizes.add(window.override)
  const options = [...sizes].sort((a, b) => a - b).map(size => {
    const label = contextLengthLabel(size)
    if (size === automatic && size === window?.defaultContext) return { value: String(size), label: `${label} (Default)` }
    if (size === window?.override && window.effective && window.effective < size) {
      return { value: String(size), label: `${label} (using ${contextLengthLabel(window.effective)})` }
    }
    return { value: String(size), label }
  })
  if (automatic === undefined) options.unshift({ value: 'auto', label: 'Auto' })
  return options
}

function workerName(row: SubagentActivity): string {
  const name = row.model ? displayName(row.model) : ''
  if (row.confirmed !== false) return name || 'Subagent'
  return row.running ? `${name ? name + ' · ' : ''}Starting…` : name || 'Subagent'
}

export async function renderUI($: EngineInterface, e: RenderInput<'AbovePrompt'>, state: UIState, actions: UIActions) {
  const els = $.ui.resolve(e)
  const { Box, Button, Input, Select, Text } = els
  const { preferences, showResponseSpeed = false } = state
  const model = preferences.model
  const effort = preferences.mode === 'full' ? preferences.fullEffort : preferences.subagentEffort
  const models = state.settingsOpen ? modelChoices(state.models, model) : []
  const selected = (state.settingsOpen ? models : state.models).find(one => one.name === model)
  const options = models.map(one => ({ value: one.name, label: modelLabel(one) }))
  // Keep unavailable saved models visible without changing the user's choice.
  if (model && !selected) options.unshift({ value: model, label: `${model} (unavailable)` })
  if (!model) options.unshift({ value: '', label: 'Choose model' })
  const efforts = selected?.efforts ?? []
  const currentEffort = effort && efforts.includes(effort) ? effort : selected?.defaultEffort
  const isTerminal = e.surface === 'terminal'
  const isDesktop = e.surface === 'desktop'
  const closeIcon = isDesktop ? '✕' : '×'
  const settingsIcon = state.settingsOpen ? closeIcon : '⋯'
  const settingsName = state.settingsOpen ? 'Close Ollama settings' : 'Open Ollama settings'
  const menuKey = state.openMenu?.key
  const advanced = menuKey === 'advanced'
  const openRow = (menuKey === 'model' || isTerminal && (menuKey === 'compact-mode' || menuKey === 'effort')) ? menuKey : undefined
  const stackedFields = e.props.bodyColumns < 52
  const settingsGap = isDesktop ? 'sm' : isTerminal ? 0 : 0.5
  const field = (label: string, control: (inlineLabel?: string) => RenderElement, expanded = false) => {
    if (!isDesktop) return control(label)
    return <Box key={label} flexDirection={stackedFields ? 'column' : 'row'}
      alignItems={stackedFields || expanded ? 'flex-start' : 'center'} columnGap="md" rowGap="xs">
      <Box width={stackedFields ? undefined : 15} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Box flexDirection="column" alignItems="flex-start" width={stackedFields ? '100%' : undefined} minWidth={0} flexShrink={1}>
        {control()}
      </Box>
    </Box>
  }
  const picker = (menu: Menu) => isTerminal || menu.searchable
    ? pickerMenu($, e, state.openMenu, menu, actions.setOpenMenu)
    : <Select key={menu.key} label={menu.label} value={menu.value} options={menu.options} onSelect={menu.onSelect} />
  const window = state.modelWindow?.model === model && state.modelWindow.endpoint === state.endpoint ? state.modelWindow : undefined
  const automaticContext = window?.detected ?? window?.defaultContext ?? (window?.override === undefined ? window?.effective : undefined)
  const contextValue = String(window?.override ?? automaticContext ?? 'auto')
  const target = state.selection?.current ?? (preferences.enabled && preferences.mode === 'full' ? preferences.model : '')
  const native = !target
  // A late response belongs to its captured target. Never present it as the
  // newly selected model (especially after switching back to Claude).
  const main = state.activity?.main?.target === target ? state.activity.main : undefined
  const isClaude = native || !!main?.model && /^(claude|opus|sonnet|haiku)/i.test(main.model)
  let modelId = main?.model || target
  if (preferences.enabled && native && (!modelId || modelId === 'default')) {
    modelId = await $.session.model().then(model => resolveNativeModel($, model)).catch(() => '')
  }
  const title = displayName(native && modelId === 'default' ? '' : modelId)
  const switchStatus = state.selection && (state.selection.status === 'pending' ? 'Switching…' : 'Switch failed')
  const summary = [preferences.enabled ? title : undefined, switchStatus].filter(Boolean).join(' · ')
  const notice = state.notice || (preferences.enabled || state.settingsOpen ? state.connectionIssue : undefined)
  const rows = preferences.enabled ? state.activity?.subagents ?? [] : []
  const hidden = state.activity?.hidden ?? false
  const countLabel = `${rows.length} ${rows.length === 1 ? 'subagent' : 'subagents'}`
  const shown = hidden ? [] : shownSubagents(rows, Math.max(1, Math.min(5, e.props.maxRows - 2)))
  const remaining = !hidden && shown.length < rows.length ? rows.filter(row => !shown.includes(row)) : []
  const usage = state.activity?.ollama ?? { requests: 0, inputTokens: 0, outputTokens: 0 }
  const usageLabel = [
    `${usage.requests.toLocaleString('en-US')} ${usage.requests === 1 ? 'request' : 'requests'}`,
    ...(usage.inputTokens !== undefined ? [`${usage.inputTokens.toLocaleString('en-US')} input tokens`] : []),
    ...(usage.outputTokens !== undefined ? [`${usage.outputTokens.toLocaleString('en-US')} output tokens`] : []),
  ].join(' · ')
  const visuals = activityElements($, e, state.isDark ?? false)
  const mainEffort = main?.effort ?? (!native && target === model ? currentEffort : undefined)
  const summaryEffort = mainEffort === 'on' || mainEffort === 'off'
    ? `Thinking ${mainEffort}` : mainEffort ? effortLabels[mainEffort] : undefined
  const bar = (
    <Box key="ollama-bar" flexDirection="column" paddingX={1} rowGap={isTerminal ? 0 : 0.5}>
      <Box key="summary" flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={1}>
        <Box flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          {summary ? <Text key="summary-status" weight="bold" color={isClaude ? 'claude' : undefined} wrap="truncate-end">{summary}</Text> : null}
          {preferences.enabled && summaryEffort ? <Text key="summary-effort" dimColor wrap="truncate-end">{summaryEffort}</Text> : null}
          {showResponseSpeed && main?.tokensPerSecond !== undefined && Number.isFinite(main.tokensPerSecond)
            ? <Text key="summary-speed" dimColor tabular wrap="truncate-end">{`${summary ? '· ' : ''}${Math.round(main.tokensPerSecond * 10) / 10} tok/s`}</Text> : null}
          {rows.length > 0 ? <Button key="subagents-toggle" plain dimColor
            label={`${countLabel} ${hidden ? '▾' : '▴'}`}
            onPress={actions.toggleSubagents} /> : null}
        </Box>
        {picker({ key: 'compact-mode', label: '', value: preferences.enabled ? preferences.mode : 'never',
          options: modeOptions, onSelect: value => actions.setMode(value as Mode | 'never') })}
        {state.selection?.status === 'failed' ? <Button key="retry-switch" plain label="Retry" onPress={() => actions.setMode(preferences.enabled ? preferences.mode : 'never')} /> : null}
        {isDesktop ? (
          <Box key="settings-control" flexDirection="row" alignItems="center" columnGap={0} flexShrink={0}>
            <Box width={settingsButtonColumns} flexShrink={0} alignItems="center" justifyContent="center">
              <Text dimColor>{settingsIcon}</Text>
            </Box>
            {/* Desktop paints the button's rounded corners beyond the height of this row. */}
            <Box width={settingsButtonColumns} marginLeft={-settingsButtonColumns} flexShrink={0} alignItems="stretch" overflow="visible">
              <Button key="settings" plain dimColor label={`\u2003\u2003${settingsName}`} onPress={actions.toggleSettings} />
            </Box>
          </Box>
        ) : (
          <Button key="settings" plain dimColor label={settingsName} onPress={actions.toggleSettings}>
            {settingsIcon}
          </Button>
        )}
      </Box>
      {notice ? <Text key="notice">{notice}</Text> : null}
      {shown.map(row => <Box key={`subagent-${row.id}`} flexDirection="row" alignItems="center" columnGap={2} paddingLeft={isDesktop ? 2 : 1}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          {!isDesktop ? <Text dimColor>↳</Text> : null}
          <Box flexShrink={1} minWidth={0}><Text weight="medium" color={/^(claude|opus|sonnet|haiku)/i.test(row.model) ? 'claude' : undefined} wrap="truncate-end">{workerName(row)}</Text></Box>
          <Box flexShrink={1000} minWidth={0}><Text dimColor wrap="truncate-end">{`· ${row.task}`}</Text></Box>
          {isDesktop && (row.failed || row.running && row.confirmed !== false) ? <Text dimColor={!row.failed}
            color={row.failed ? 'warning' : undefined}>{row.failed ? 'Stopped' : 'Running'}</Text> : null}
        </Box>
        <Box flexShrink={0}><Text key={`tokens-${row.id}`} dimColor tabular>{`${tokenCount(row.tokens)} tokens`}</Text></Box>
        {!isDesktop ? <Box width={row.failed ? 7 : 3} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="flex-end">
          {row.running ? visuals.dots(`dots-${row.id}`) : row.failed
            ? <Text key={`status-${row.id}`} color="warning">Stopped</Text>
            : <Text key={`status-${row.id}`} color="success">✓</Text>}
        </Box> : null}
      </Box>)}
      {remaining.length > 0 ? <Box key="subagents-left" flexDirection="row" columnGap={1} paddingLeft={isDesktop ? 2 : 1}>
        {!isDesktop ? <Text dimColor>↳</Text> : null}
        <Text dimColor>{`+${remaining.length} ${!isDesktop && remaining.every(row => !row.running && !row.failed) ? 'done' : 'more'}`}</Text>
      </Box> : null}
      {state.settingsOpen ? (
        <Box key="settings-panel" flexDirection="column" paddingTop={isDesktop ? 'md' : undefined} rowGap={settingsGap}>
          {!openRow || openRow === 'model' ? field('Model', label => picker({ key: 'model', label, value: model,
            options, searchable: true, onSelect: actions.setModel }), openRow === 'model') : null}
          {efforts.length > 0 && (!openRow || openRow === 'effort') ? field('Effort', label => picker({ key: 'effort', label, value: currentEffort ?? '',
            options: efforts.map(value => ({ value, label: effortLabels[value] })),
            onSelect: value => actions.setEffort(value === selected?.defaultEffort ? undefined : value as Thinking) })) : null}
          {!openRow ? (
            // Offset Desktop's button padding to line the text up with the field labels.
            <Box alignSelf="flex-start" marginLeft={isDesktop ? -1.25 : undefined}>
              <Button key="advanced" plain dimColor label={advanced ? 'Advanced ▴' : 'Advanced ▾'}
                onPress={() => actions.setOpenMenu(advanced ? null : { key: 'advanced' })} />
            </Box>
          ) : null}
          {advanced ? <Box key="settings-details" flexDirection="column" rowGap={settingsGap}>
            {model ? field('Context length', label => <Select key={`context-${state.endpoint}-${model}`} label={label} value={contextValue}
              options={contextLengthOptions(window, automaticContext)}
              onSelect={value => {
                const setting = value === String(automaticContext) ? 'auto' : value
                if (setting !== String(window?.override ?? 'auto')) return actions.setContext(setting)
              }} />) : null}
            {field('Ollama address', label => <Box key="connection" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
              <Input key="endpoint" label={label} value={state.endpoint} placeholder="http://localhost:11434" submitLabel={isTerminal ? '' : 'Save'} onSubmit={actions.setEndpoint} />
              {state.connected ? <Text key="connection-status" dimColor>Connected</Text>
                : <Button key="refresh" plain label="Refresh" onPress={actions.refresh} />}
            </Box>)}
            {field('Response speed', label => <Select key="show-response-speed" label={label} value={showResponseSpeed ? 'on' : 'off'}
              options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
              onSelect={value => actions.setShowResponseSpeed(value === 'on')} />)}
            {field('Ollama usage', () => <Text key="ollama-usage" dimColor wrap={isDesktop ? undefined : 'truncate-end'}>
              {isDesktop ? usageLabel : `Ollama · ${usageLabel}`}
            </Text>)}
          </Box> : null}
        </Box>
      ) : null}
    </Box>
  )
  setPulse($, e.requestId, visuals.keys, state.isDark ?? false)
  return bar
}
