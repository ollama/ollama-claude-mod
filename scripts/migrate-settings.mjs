#!/usr/bin/env node
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

const SOURCES = ['ollama@ollama-local', 'ollama-chat@ollama-chat-local']
const DESTINATION = 'ollama@ollama'

// Verified against Claude Code 2.1.326's native store path function. Hash the
// full identity, not its sanitized filename or the bare plugin name.
export function pluginStoreName(id) {
  if (/^[a-z0-9._-]+$/.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(id) && id.length <= 64 && id !== '.' && id !== '..') return `${id}.json`
  return `${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'plugin'}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.json`
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function parse(snapshot, label) {
  if (snapshot.text === undefined) return {}
  let value
  try { value = JSON.parse(snapshot.text) } catch { throw new Error(`${label} is malformed JSON; left unchanged.`) }
  if (!object(value)) throw new Error(`${label} must be a JSON object; left unchanged.`)
  return value
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(':')
}
async function read(file) {
  let handle
  let inspected = false
  try {
    const stat = await fs.lstat(file, { bigint: true })
    inspected = true
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error(`Migration requires a regular, unlinked file: ${file}`)
    if (stat.size > 16n * 1024n * 1024n) throw new Error(`Migration file is unexpectedly large: ${file}`)
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (identity(opened) !== identity(stat)) throw new Error(`File changed while opening: ${file}`)
    const text = await handle.readFile('utf8')
    if (identity(await handle.stat({ bigint: true })) !== identity(opened)) throw new Error(`File changed while reading: ${file}`)
    return { text, mode: Number(stat.mode & 0o777n), identity: identity(stat) }
  } catch (error) {
    if (error.code === 'ENOENT' && !inspected) return { text: undefined, mode: 0o600, identity: undefined }
    throw error
  } finally { await handle?.close() }
}
async function directory(dir) {
  try {
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Migration requires a real directory: ${dir}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await fs.mkdir(dir, { mode: 0o700 })
  }
}
function merge(source, destination, label) {
  const result = { ...destination }
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(destination, key) && !isDeepStrictEqual(destination[key], value)) throw new Error(`${label} has conflicting destination data; nothing was replaced.`)
    Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true })
  }
  return result
}

export async function migrateSettings({ configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  if (!path.isAbsolute(configDir)) throw new Error('Use an absolute Claude configuration directory.')
  configDir = path.resolve(configDir)
  await directory(configDir)
  const pluginDir = path.join(configDir, 'plugins')
  const storeDir = path.join(pluginDir, 'store')
  await directory(pluginDir)
  await directory(storeDir)
  const sourceFiles = SOURCES.map(id => path.join(storeDir, pluginStoreName(id)))
  const destinationFile = path.join(storeDir, pluginStoreName(DESTINATION))
  const settingsFile = path.join(configDir, 'settings.json')
  const lockFile = path.join(configDir, '.ollama-settings-migration.lock')
  const lock = await fs.open(lockFile, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another settings migration is running (or its lock remains).')
    throw error
  })
  const nativeLocks = []
  const temporary = []
  let heartbeat
  let committed = 0
  try {
    // Match the host's store lock directory. Refuse active native writers;
    // keep our leases fresh while preparing. Stop old/new chats before running:
    // a later write by the old identity cannot be redirected by this helper.
    for (const file of [...sourceFiles, destinationFile].sort()) {
      const dir = `${file}.lock`
      try { await fs.mkdir(dir, { mode: 0o700 }) }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('A native plugin store is active or locked. Stop its chats and retry; no stale lock is removed automatically.')
        throw error
      }
      const stat = await fs.lstat(dir)
      nativeLocks.push({ dir, dev: stat.dev, ino: stat.ino })
    }
    heartbeat = setInterval(() => {
      const now = new Date()
      for (const { dir } of nativeLocks) void fs.utimes(dir, now, now).catch(() => {})
    }, 2000)
    heartbeat.unref()
    const [recentSnapshot, destinationSnapshot, settingsSnapshot] = await Promise.all([sourceFiles[0], destinationFile, settingsFile].map(read))
    const destination = parse(destinationSnapshot, 'Destination plugin store')
    const settings = parse(settingsSnapshot, 'Claude settings')
    if (settings.pluginConfigs !== undefined && !object(settings.pluginConfigs)) throw new Error('pluginConfigs is malformed; left unchanged.')
    const configs = settings.pluginConfigs || {}
    // Earlier migrations kept their source store. Prefer the newest identity
    // that exists so an old snapshot cannot bring back superseded preferences.
    const sourceIndex = recentSnapshot.text !== undefined || Object.hasOwn(configs, SOURCES[0]) ? 0 : 1
    const sourceId = SOURCES[sourceIndex]
    const sourceFile = sourceFiles[sourceIndex]
    const sourceSnapshot = sourceIndex === 0 ? recentSnapshot : await read(sourceFile)
    const files = [sourceFile, destinationFile, settingsFile]
    const snapshots = [sourceSnapshot, destinationSnapshot, settingsSnapshot]
    const source = parse(sourceSnapshot, 'Source plugin store')
    const merged = merge(source, destination, 'Plugin store')
    let nextSettings = settings
    if (Object.hasOwn(configs, sourceId)) {
      if (!object(configs[sourceId])) throw new Error('Source plugin configuration is malformed; left unchanged.')
      if (Object.hasOwn(configs, DESTINATION) && !isDeepStrictEqual(configs[sourceId], configs[DESTINATION])) throw new Error('Plugin configuration has conflicting destination data; nothing was replaced.')
      nextSettings = { ...settings, pluginConfigs: { ...configs, [DESTINATION]: configs[sourceId] } }
    }
    const changes = []
    if (!isDeepStrictEqual(merged, destination)) changes.push({ file: destinationFile, value: merged, snapshot: destinationSnapshot })
    if (!isDeepStrictEqual(nextSettings, settings)) changes.push({ file: settingsFile, value: nextSettings, snapshot: settingsSnapshot })
    for (const change of changes) {
      change.temp = `${change.file}.${randomUUID()}.tmp`
      temporary.push(change.temp)
      await fs.writeFile(change.temp, JSON.stringify(change.value, null, 2) + '\n', { flag: 'wx', mode: change.snapshot.mode })
    }
    // Check the source as well as destinations before *each* rename. Store
    // locks exclude cooperating native writers; settings editors do not share
    // them, so a final recheck reduces but cannot eliminate that rename race.
    for (const change of changes) {
      for (const held of nativeLocks) {
        const stat = await fs.lstat(held.dir)
        if (!stat.isDirectory() || stat.dev !== held.dev || stat.ino !== held.ino) throw new Error('Migration lost a native store lock; retry after stopping writers.')
      }
      for (let i = 0; i < files.length; i++) {
        const current = await read(files[i])
        if (current.text !== snapshots[i].text || current.identity !== snapshots[i].identity) throw new Error('Files changed during migration; retry after stopping writers.')
      }
      if (change.snapshot.text === undefined) {
        // Atomic no-clobber creation: a file appearing after the final snapshot
        // must win, even if its writer does not honor the native store lock.
        await fs.link(change.temp, change.file)
        committed++
        await fs.unlink(change.temp)
      } else {
        await fs.rename(change.temp, change.file)
        committed++
      }
      snapshots[files.indexOf(change.file)] = await read(change.file)
    }
    return { configDir, sourceFile, destinationFile, settingsFile, storeKeys: Object.keys(source).length, changedFiles: changes.length }
  } catch (error) {
    if (committed) throw new Error(`${error.message} ${committed} destination file(s) were already copied; the source is unchanged and the migration can be retried.`)
    throw error
  } finally {
    clearInterval(heartbeat)
    for (const temp of temporary) await fs.unlink(temp).catch(() => {})
    for (const held of nativeLocks.reverse()) {
      const stat = await fs.lstat(held.dir).catch(() => undefined)
      if (stat?.dev === held.dev && stat?.ino === held.ino) await fs.rmdir(held.dir).catch(() => {})
    }
    await lock.close()
    await fs.unlink(lockFile)
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--config-dir')) throw new Error('Usage: migrate-settings.mjs [--config-dir /absolute/claude-config]')
  const result = await migrateSettings(args.length ? { configDir: args[1] } : {})
  console.log(`Migration complete: ${result.storeKeys} source store keys, ${result.changedFiles} destination files changed. Original plugin data and enable/disable settings were preserved.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
