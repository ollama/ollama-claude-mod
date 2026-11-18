import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { configure } from './model-picker.mjs'

async function fixture(t, settings) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-picker-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const settingsPath = path.join(directory, 'settings.json')
  const catalogFile = path.join(directory, 'catalog.json')
  if (settings !== undefined) await fs.writeFile(settingsPath, JSON.stringify(settings))
  await fs.writeFile(catalogFile, JSON.stringify([{ name: 'test-model', isCloud: false, isDecision: false }]))
  return { settingsPath, catalogFile, directory, read: async () => JSON.parse(await fs.readFile(settingsPath, 'utf8')) }
}
const row = { model: 'test-model', label: 'Ollama · test-model', description: 'Local Ollama' }

test('startup replaces only an Ollama launch default and preserves picker, preferences, and native choices', async t => {
  const initial = { model: 'test-model', effortLevel: 'high', modelPicker: { options: [row] }, pluginConfigs: { ollama: { options: { modelCatalog: 'saved' } } } }
  const f = await fixture(t, initial)
  await configure({ ...f, mode: 'startup', nativeModel: 'opus' })
  assert.deepEqual(await f.read(), { ...initial, model: 'opus' })
  await configure({ ...f, mode: 'startup', nativeModel: 'sonnet' })
  assert.equal((await f.read()).model, 'opus')
  await fs.writeFile(f.settingsPath, JSON.stringify(initial))
  await configure({ ...f, mode: 'startup', nativeModel: 'default' })
  const { model, ...withoutModel } = initial
  assert.deepEqual(await f.read(), withoutModel)
})

test('install is idempotent and remove preserves existing rows and settings', async t => {
  const initial = { model: 'opus', permissions: { allow: ['Read'] }, modelPicker: { options: [{ model: 'existing', label: 'Mine' }], replaceBuiltInOptions: true } }
  const f = await fixture(t, initial)
  assert.equal((await configure(f)).count, 1)
  const installed = await fs.readFile(f.settingsPath, 'utf8')
  assert.deepEqual(await f.read(), { ...initial, modelPicker: { ...initial.modelPicker, options: [...initial.modelPicker.options, row] } })
  assert.equal((await configure(f)).count, 0)
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), installed)
  await configure({ ...f, mode: 'remove' })
  assert.deepEqual(await f.read(), initial)
  await configure({ ...f, mode: 'remove' })
  assert.deepEqual(await f.read(), initial)
})

test('refresh removes stale owned rows and removal preserves user edits', async t => {
  const f = await fixture(t, {})
  await configure(f)
  await fs.writeFile(f.catalogFile, JSON.stringify([{ name: 'next-model', isCloud: true, isDecision: false }]))
  await configure(f)
  assert.deepEqual((await f.read()).modelPicker.options, [{ model: 'next-model', label: 'Ollama · next-model', description: 'Ollama Cloud' }])
  const edited = await f.read()
  edited.modelPicker.options[0].label = 'My renamed model'
  edited.modelPicker.options.push({ model: 'custom', label: 'Keep' })
  await fs.writeFile(f.settingsPath, JSON.stringify(edited))
  await configure({ ...f, mode: 'remove' })
  assert.deepEqual(await f.read(), edited)
})

test('partial refresh adds new rows without deleting previously discovered models', async t => {
  const f = await fixture(t, { model: 'opus', modelPicker: { options: [{ model: 'custom', label: 'Mine' }] } })
  await configure(f)
  const models = [{ name: 'new-model', isCloud: true, isDecision: false }]
  await configure({ ...f, catalog: { models, complete: false } })
  assert.deepEqual((await f.read()).modelPicker.options.map(row => row.model), ['custom', 'test-model', 'new-model'])
  await configure({ ...f, catalog: { models: [], complete: false } })
  assert.deepEqual((await f.read()).modelPicker.options.map(row => row.model), ['custom', 'test-model', 'new-model'])
  await configure({ ...f, catalog: { models, complete: true } })
  assert.deepEqual((await f.read()).modelPicker.options.map(row => row.model), ['custom', 'new-model'])
  assert.equal((await f.read()).model, 'opus')
})

test('the packaged stdin entrypoint uses the shared catalog and returns a retryable lock status', async t => {
  const f = await fixture(t, { model: 'opus' })
  const catalog = JSON.stringify({ models: [{ name: 'shared', isCloud: false, isDecision: false }], complete: true })
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./model-picker.mjs', import.meta.url).pathname, 'install', '--catalog-stdin'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: f.directory, OLLAMA_HOST: 'http://unreachable.invalid' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stderr }))
    child.stdin.end(catalog)
  })
  assert.deepEqual(await run(), { code: 0, stderr: '' })
  assert.deepEqual((await f.read()).modelPicker.options.map(row => row.model), ['shared'])
  await fs.writeFile(`${f.settingsPath}.ollama-model-picker.json.lock`, '')
  assert.equal((await run()).code, 75)
  assert.equal((await f.read()).model, 'opus')
})

test('malformed settings and ownership records are never overwritten', async t => {
  const f = await fixture(t, {})
  await fs.writeFile(f.settingsPath, '{invalid')
  await assert.rejects(configure(f), /not valid JSON/)
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), '{invalid')
  await fs.writeFile(f.settingsPath, '{}')
  await fs.writeFile(`${f.settingsPath}.ollama-model-picker.json`, '{"version":2,"rows":[]}')
  await assert.rejects(configure(f), /ownership record is malformed/)
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), '{}')
})

test('setup refuses a conflicting setup lock and leaves a symlink alone', async t => {
  const f = await fixture(t, { model: 'opus' })
  const original = await fs.readFile(f.settingsPath, 'utf8')
  await fs.writeFile(`${f.settingsPath}.ollama-model-picker.json.lock`, '')
  await assert.rejects(configure(f), /Another picker setup/)
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), original)
  await fs.unlink(`${f.settingsPath}.ollama-model-picker.json.lock`)
  const link = path.join(f.directory, 'linked.json')
  await fs.symlink(f.settingsPath, link)
  await assert.rejects(configure({ ...f, settingsPath: link }), /symlinks are left unchanged/)
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
})

test('an editor change during preparation is preserved as a conflict', async t => {
  const f = await fixture(t, { model: 'opus' })
  const write = fs.writeFile
  let changed = false
  fs.writeFile = async (file, ...args) => {
    await write(file, ...args)
    if (!changed && String(file).endsWith('.tmp')) {
      changed = true
      await write(f.settingsPath, '{"model":"edited"}')
    }
  }
  try { await assert.rejects(configure(f), /Settings changed during setup/) }
  finally { fs.writeFile = write }
  assert.deepEqual(await f.read(), { model: 'edited' })
})

test('a failed settings rename retains ownership intent and can be retried', async t => {
  const f = await fixture(t, {})
  const rename = fs.rename
  fs.rename = async (from, to) => {
    if (to === f.settingsPath) throw new Error('Simulated settings rename failure')
    return rename(from, to)
  }
  try { await assert.rejects(configure(f), /Simulated settings rename failure/) }
  finally { fs.rename = rename }
  assert.deepEqual(await f.read(), {})
  assert.deepEqual(JSON.parse(await fs.readFile(`${f.settingsPath}.ollama-model-picker.json`, 'utf8')).rows, [row])
  await configure(f)
  await configure({ ...f, mode: 'remove' })
  assert.deepEqual(await f.read(), {})
})

test('a settings file created after the final snapshot is not overwritten', async t => {
  const f = await fixture(t)
  const link = fs.link
  fs.link = async (from, to) => {
    if (to === f.settingsPath) await fs.writeFile(to, '{"model":"created-by-editor"}')
    return link(from, to)
  }
  try { await assert.rejects(configure(f), { code: 'EEXIST' }) }
  finally { fs.link = link }
  assert.deepEqual(await f.read(), { model: 'created-by-editor' })
  await configure(f)
  assert.equal((await f.read()).model, 'created-by-editor')
})

test('live discovery merges the public cloud catalog with tool-capable local models', async t => {
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, init) => url === 'https://ollama.com/api/tags'
    ? Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'cloud-model', capabilities: ['tools'] }, { name: 'text-cloud', capabilities: ['completion'] }] })))
    : originalFetch(url, init))
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'tools' }, { name: 'text' }, { name: 'decision' }] }))
    else {
      const name = JSON.parse(body).model
      response.end(JSON.stringify({ capabilities: name === 'tools' ? ['tools'] : name === 'decision' ? ['tools', 'decision'] : ['completion'] }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const f = await fixture(t, {})
  await configure({ settingsPath: f.settingsPath, url: `127.0.0.1:${server.address().port}` })
  assert.deepEqual((await f.read()).modelPicker.options, [
    { model: 'cloud-model:cloud', label: 'Ollama · cloud-model:cloud', description: 'Ollama Cloud' },
    { model: 'tools', label: 'Ollama · tools', description: 'Local Ollama' },
  ])
})
