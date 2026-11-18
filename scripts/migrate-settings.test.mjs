import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateSettings, pluginStoreName } from './migrate-settings.mjs'

const oldId = 'ollama-chat@ollama-chat-local'
const newId = 'ollama@ollama-local'
async function fixture(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-migration-'))
  t.after(() => fs.rm(configDir, { recursive: true, force: true }))
  const storeDir = path.join(configDir, 'plugins', 'store')
  await fs.mkdir(storeDir, { recursive: true })
  const sourceFile = path.join(storeDir, pluginStoreName(oldId))
  const destinationFile = path.join(storeDir, pluginStoreName(newId))
  const settingsFile = path.join(configDir, 'settings.json')
  return { configDir, sourceFile, destinationFile, settingsFile }
}
const write = (file, value) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 })
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))

test('store filenames match the inspected native host identities', () => {
  assert.equal(pluginStoreName(oldId), 'ollama-chat_ollama-chat-local-bdc75795ea72.json')
  assert.equal(pluginStoreName(newId), 'ollama_ollama-local-cbf0159c6872.json')
})

test('copies every store value and plugin configuration without touching source or enablement', async t => {
  const f = await fixture(t)
  const store = {
    'preferences:chat': { version: 1, value: { enabled: true, mode: 'subagent', full: 'a', subagent: 'b' } },
    'preference-defaults-v1': { version: 1, value: { enabled: false, mode: 'full', full: 'a', subagent: 'b' } },
    'native-model-v1:last': 'opus', 'chat-owner-v1:raw': 'desktop:logical',
    'request-template-v1:chat': { version: 1, system: 'exact', tools: [] },
    'connection-v1': 'http://localhost:11434', unknownFutureKey: { preserve: [1, null, false] },
  }
  const settings = { model: 'sonnet', enabledPlugins: { [oldId]: false }, pluginConfigs: { [oldId]: { options: { modelCatalog: '[]' } }, unrelated: { options: { a: true } } } }
  await write(f.sourceFile, store)
  await write(f.settingsFile, settings)
  const original = await fs.readFile(f.sourceFile, 'utf8')
  const result = await migrateSettings(f)
  assert.equal(result.changedFiles, 2)
  assert.deepEqual(await read(f.destinationFile), store)
  assert.equal(await fs.readFile(f.sourceFile, 'utf8'), original)
  assert.deepEqual(await read(f.settingsFile), { ...settings, pluginConfigs: { ...settings.pluginConfigs, [newId]: settings.pluginConfigs[oldId] } })
  assert.equal((await fs.stat(f.destinationFile)).mode & 0o777, 0o600)
  const snapshot = await fs.readFile(f.settingsFile, 'utf8')
  assert.equal((await migrateSettings(f)).changedFiles, 0)
  assert.equal(await fs.readFile(f.settingsFile, 'utf8'), snapshot)
})

test('preserves destination-only keys but refuses different overlapping values before any write', async t => {
  const f = await fixture(t)
  await write(f.sourceFile, { keep: 1, newKey: 2 })
  await write(f.destinationFile, { keep: 1, destinationOnly: true })
  await migrateSettings(f)
  assert.deepEqual(await read(f.destinationFile), { keep: 1, newKey: 2, destinationOnly: true })
  await write(f.sourceFile, { keep: 3 })
  await write(f.settingsFile, { pluginConfigs: { [oldId]: { options: {} } } })
  await assert.rejects(migrateSettings(f), /conflicting destination data/)
  assert.deepEqual(await read(f.destinationFile), { keep: 1, newKey: 2, destinationOnly: true })
  assert.equal((await read(f.settingsFile)).pluginConfigs[newId], undefined)
})

test('a plugin-config conflict leaves the destination store uncreated', async t => {
  const f = await fixture(t)
  await write(f.sourceFile, { newKey: 2 })
  await write(f.settingsFile, { pluginConfigs: { [oldId]: { options: { a: 1 } }, [newId]: { options: { a: 2 } } } })
  await assert.rejects(migrateSettings(f), /configuration has conflicting/)
  await assert.rejects(fs.stat(f.destinationFile), { code: 'ENOENT' })
})

test('malformed data and unsafe files remain untouched', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.sourceFile, '{invalid')
  await assert.rejects(migrateSettings(f), /malformed JSON/)
  assert.equal(await fs.readFile(f.sourceFile, 'utf8'), '{invalid')
  await fs.unlink(f.sourceFile)
  const target = path.join(f.configDir, 'target')
  await write(target, { a: 1 })
  await fs.symlink(target, f.sourceFile)
  await assert.rejects(migrateSettings(f), /regular, unlinked file/)
  await fs.unlink(f.sourceFile)
  await fs.link(target, f.sourceFile)
  await assert.rejects(migrateSettings(f), /regular, unlinked file/)
  assert.deepEqual(await read(target), { a: 1 })
})

test('refuses an active native lock and a symlinked store directory', async t => {
  const f = await fixture(t)
  await fs.mkdir(`${f.sourceFile}.lock`)
  await assert.rejects(migrateSettings(f), /active or locked/)
  assert.equal((await fs.stat(`${f.sourceFile}.lock`)).isDirectory(), true)
  await fs.rmdir(`${f.sourceFile}.lock`)
  await fs.rmdir(path.dirname(f.sourceFile))
  const target = path.join(f.configDir, 'outside-store')
  await fs.mkdir(target)
  await fs.symlink(target, path.dirname(f.sourceFile))
  await assert.rejects(migrateSettings(f), /real directory/)
})

test('a source edit during preparation is detected without replacing destination', async t => {
  const f = await fixture(t)
  await write(f.sourceFile, { original: 1 })
  const originalWrite = fs.writeFile
  let changed = false
  fs.writeFile = async (file, ...args) => {
    await originalWrite(file, ...args)
    if (!changed && String(file).endsWith('.tmp')) {
      changed = true
      await originalWrite(f.sourceFile, JSON.stringify({ edited: 2 }))
    }
  }
  try { await assert.rejects(migrateSettings(f), /Files changed during migration/) }
  finally { fs.writeFile = originalWrite }
  assert.deepEqual(await read(f.sourceFile), { edited: 2 })
  await assert.rejects(fs.stat(f.destinationFile), { code: 'ENOENT' })
})

test('an interrupted second commit preserves the source and can be retried', async t => {
  const f = await fixture(t)
  await write(f.sourceFile, { original: 1 })
  await write(f.settingsFile, { pluginConfigs: { [oldId]: { options: { modelCatalog: '[]' } } } })
  const originalRename = fs.rename
  fs.rename = async (from, to) => {
    if (to === f.settingsFile) throw new Error('Simulated rename failure')
    return originalRename(from, to)
  }
  try { await assert.rejects(migrateSettings(f), /1 destination file\(s\) were already copied/) }
  finally { fs.rename = originalRename }
  assert.deepEqual(await read(f.sourceFile), { original: 1 })
  assert.deepEqual(await read(f.destinationFile), { original: 1 })
  assert.equal((await migrateSettings(f)).changedFiles, 1)
})

test('honors CLAUDE_CONFIG_DIR and handles a missing source idempotently', async t => {
  const f = await fixture(t)
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = f.configDir
  try {
    assert.equal((await migrateSettings()).changedFiles, 0)
    await write(f.sourceFile, { a: 1 })
    assert.equal((await migrateSettings()).configDir, f.configDir)
    assert.deepEqual(await read(f.destinationFile), { a: 1 })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})


test('a destination created after the last check is never clobbered', async t => {
  const f = await fixture(t)
  await write(f.sourceFile, { source: 1 })
  const originalLink = fs.link
  fs.link = async (from, to) => {
    if (to === f.destinationFile) await write(f.destinationFile, { external: 2 })
    return originalLink(from, to)
  }
  try { await assert.rejects(migrateSettings(f), { code: 'EEXIST' }) }
  finally { fs.link = originalLink }
  assert.deepEqual(await read(f.destinationFile), { external: 2 })
  assert.deepEqual(await read(f.sourceFile), { source: 1 })
})
