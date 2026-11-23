import { expect, test } from 'claude-code/testing'

const prompt = { model: 'launcher-choice', promptModel: 'launcher-choice', surfaces: [], tools: ['Agent'], outputStyle: null, traits: [] }

for (const [name, host, provider] of [
  ['default server', undefined, 'http://127.0.0.1:11434'],
  ['custom server', 'https://ollama.example:9443/ollama', 'https://ollama.example:9443/ollama'],
] as const) {
  test(`the Ollama launcher owns the session when using its ${name}`, async ($, on) => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', OLLAMA_HOST: host, ANTHROPIC_BASE_URL: provider,
    }
    const effects: string[] = []
    on('env.get', (_, e) => ({ value: env[e.name] }))
    on('store.get', (_, e) => { effects.push(e.key); return { value: undefined } })
    on('store.set', (_, e) => { effects.push(e.key); return { value: undefined } })
    on('command.register', (_, e, next) => { effects.push(e.name); return next(e) })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('command.run', { command: 'ollama' }, () => ({ text: 'host command handler' }))
    const sections = [{ id: 'host', text: 'Original system prompt', scope: 'shared' as const }]
    on('prompt.compose', () => ({ sections }))
    let context: readonly string[] | undefined
    on('prompt.submit', (_, e) => { context = e.context; return { text: e.text } })
    on('http.fetch', (_, e) => {
      effects.push(e.url)
      return { value: { ok: true, status: 200, text: 'launcher response', headers: {} } }
    })

    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    expect((await $.command.run({ command: 'ollama', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text).toBe('host command handler')
    expect((await $.prompt.compose(prompt)).sections).toEqual(sections)
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' }, context: ['launcher context'] })
    expect(context).toEqual(['launcher context'])
    const ui = await $.ui.mount({ plugin: 'ollama', component: 'AbovePrompt', surface: 'terminal', requestId: 'launcher',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
    expect(await ui.find({ key: 'compact-mode' })).toBeUndefined()
    await ui.unmount()
    expect(effects).toEqual([])
  })
}

test('a different host-managed provider can still use the mod', async ($, on) => {
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST' ? '1'
    : e.name === 'ANTHROPIC_BASE_URL' ? 'https://provider.example' : undefined }))
  on('prompt.compose', () => ({ sections: [] }))
  const { sections } = await $.prompt.compose(prompt)
  expect(sections.some(section => section.text.includes('native Agent tool'))).toBe(true)
})
