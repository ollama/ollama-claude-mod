import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('uninstall cleans the picker after the last scope and a stale session cannot repopulate it', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ollama-uninstall-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const config = path.join(temp, 'config')
  const project = path.join(temp, 'project')
  const source = path.join(temp, 'marketplace')
  const root = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(project)
  await mkdir(path.join(source, 'scripts'), { recursive: true })
  for (const file of ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', 'hooks', 'types', 'scripts/model-picker.mjs', 'scripts/plugin-installation.mjs']) {
    await cp(path.join(root, file), path.join(source, file), { recursive: true })
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  const run = (binary, args) => execFileSync(binary, args, { cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const json = async file => JSON.parse(await readFile(file, 'utf8'))
  const id = 'ollama@ollama'
  run('claude', ['plugin', 'install', 'ollama', '--marketplace', source])
  run('claude', ['plugin', 'install', id, '--scope', 'project'])
  const registry = path.join(config, 'plugins', 'installed_plugins.json')
  const script = path.join((await json(registry)).plugins[id][0].installPath, 'scripts', 'model-picker.mjs')
  const { configure } = await import(pathToFileURL(script).href)
  const settingsPath = path.join(config, 'settings.json')
  const catalog = ['owned', 'edited'].map(name => ({ name, isCloud: false, isDecision: false }))
  await configure({ settingsPath, catalog })
  const settings = await json(settingsPath)
  const edited = settings.modelPicker.options.find(row => row.model === 'edited')
  edited.label = 'My label'
  const custom = { model: 'custom', label: 'Custom' }
  settings.modelPicker.options.push(custom)
  settings.model = 'owned'
  await writeFile(settingsPath, JSON.stringify(settings))
  const data = path.join(config, 'plugins', 'data', 'ollama-ollama')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'preference'), 'saved')

  const record = settingsPath + '.ollama-model-picker.json'
  const ownership = await readFile(record, 'utf8')
  await writeFile(record, 'invalid')
  assert.throws(() => run(process.execPath, [script, 'uninstall']), /not valid JSON/)
  assert.equal((await json(registry)).plugins[id].length, 2)
  await writeFile(record, ownership)
  assert.throws(() => run(process.execPath, [script, 'uninstall', 'local']))
  assert.deepEqual((await json(settingsPath)).modelPicker, settings.modelPicker)
  assert.match(run(process.execPath, [script, 'uninstall']), /Another install/)
  assert.deepEqual((await json(registry)).plugins[id].map(entry => entry.scope), ['project'])
  assert.deepEqual((await json(settingsPath)).modelPicker, settings.modelPicker)
  assert.equal(await readFile(record, 'utf8'), ownership)
  assert.match(run(process.execPath, [script, 'uninstall', 'project']), /Removed 1/)
  assert.equal((await json(registry)).plugins[id]?.length ?? 0, 0)
  assert.deepEqual((await json(settingsPath)).modelPicker.options, [edited, custom])
  assert.equal((await json(settingsPath)).model, undefined)
  assert.equal(await readFile(path.join(data, 'preference'), 'utf8'), 'saved')
  await assert.rejects(readFile(record), { code: 'ENOENT' })

  assert.equal((await configure({ settingsPath, catalog })).count, 0)
  const inPlace = await import(pathToFileURL(path.join(source, 'scripts', 'model-picker.mjs')).href)
  assert.equal((await inPlace.configure({ settingsPath, catalog })).count, 0)
  assert.match(run(process.execPath, [path.join(source, 'scripts', 'model-picker.mjs'), 'uninstall']), /Removed 0/)
  assert.deepEqual((await json(settingsPath)).modelPicker.options, [edited, custom])
})
