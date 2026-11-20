#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { CLOUD_CATALOG, canonicalModel, cloudModels, isChatModel, isCloudModel, modelRow, modelChoices, compareModels } from '../hooks/catalog.ts'
import { connectionAddress } from '../hooks/route.ts'
import { canRegisterPicker, uninstallPlugin } from './plugin-installation.mjs'

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function parse(text, label) {
  let value
  try { value = JSON.parse(text) } catch { throw new Error(`${label} is not valid JSON; left unchanged.`) }
  if (!object(value)) throw new Error(`${label} must be a JSON object; left unchanged.`)
  return value
}
async function read(file) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Use a regular file for ${file}; symlinks are left unchanged.`)
    return { text: await fs.readFile(file, 'utf8'), mode: stat.mode & 0o777 }
  } catch (error) {
    if (error.code === 'ENOENT') return { text: undefined, mode: 0o600 }
    throw error
  }
}
function picker(settings) {
  if (settings.modelPicker === undefined) return undefined
  const value = settings.modelPicker
  if (!object(value) || !Array.isArray(value.options) || value.options.some(row => !object(row) || typeof row.model !== 'string' || !row.model.trim()) ||
      value.replaceBuiltInOptions !== undefined && typeof value.replaceBuiltInOptions !== 'boolean') {
    throw new Error('Existing modelPicker is malformed; left unchanged.')
  }
  return value
}
function catalogRows(value) {
  const models = Array.isArray(value) ? value : value?.models
  const complete = Array.isArray(value) ? true : value?.complete
  if (!Array.isArray(models) || typeof complete !== 'boolean' || models.some(model => !object(model) || typeof model.name !== 'string' || !model.name.trim() || typeof model.isDecision !== 'boolean')) {
    throw new Error('Catalog must contain model names, isDecision fields and a completeness flag.')
  }
  return { rows: models.filter(model => !model.isDecision).map(modelRow), complete }
}
async function discover(url, catalogFile) {
  if (catalogFile) return catalogRows(JSON.parse(await fs.readFile(catalogFile, 'utf8')))
  const base = connectionAddress(url)
  const headers = base === 'https://ollama.com' && process.env.OLLAMA_API_KEY ? { authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {}
  async function request(endpoint, body) {
    const response = await fetch(`${base}${endpoint}`, { headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Ollama ${endpoint} returned HTTP ${response.status}; settings left unchanged.`)
    return response.json()
  }
  const catalog = base === 'https://ollama.com' ? undefined : fetch(CLOUD_CATALOG, { signal: AbortSignal.timeout(15000) }).then(async response => response.ok ? cloudModels(await response.text()) : undefined).catch(() => undefined)
  const tags = await request('/api/tags')
  if (!Array.isArray(tags.models) || tags.models.some(item => !object(item) || typeof item.name !== 'string' || !item.name.trim())) throw new Error('Ollama returned an invalid model list.')
  const cloud = catalog ? await catalog : cloudModels(JSON.stringify(tags))
  let complete = cloud !== undefined
  const result = (cloud ?? []).map(modelRow)
  const named = base === 'https://ollama.com' ? [] : tags.models.filter(item => object(item) && typeof item.name === 'string' && item.name.trim())
  for (let index = 0; index < named.length; index += 4) {
    const batch = await Promise.all(named.slice(index, index + 4).map(async item => {
      try {
        const shown = await request('/api/show', { model: item.name })
        if (!Array.isArray(shown.capabilities)) throw new Error('Invalid model capabilities')
        if (!isChatModel(shown.capabilities)) return undefined
        return modelRow({ name: item.name, isCloud: isCloudModel(item.name, shown.remote_host) })
      } catch { complete = false; return undefined }
    }))
    result.push(...batch.filter(Boolean))
  }
  return { rows: [...new Map(result.map(item => [item.model, item])).values()], complete }
}

export async function configure({ mode = 'install', settingsPath, url = process.env.OLLAMA_HOST || 'http://localhost:11434', catalogFile, catalog, nativeModel, scope = 'user' }) {
  if (!['install', 'remove', 'uninstall', 'startup'].includes(mode)) throw new Error('Use install, remove, uninstall, or startup.')
  if (mode === 'startup' && (typeof nativeModel !== 'string' || !nativeModel.trim())) throw new Error('Startup requires a native model.')
  const file = settingsPath || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')
  if (!path.isAbsolute(file)) throw new Error('--settings must be an absolute file path.')
  const sidecar = `${file}.ollama-model-picker.json`
  // Discover before opening any output: connection failure changes no settings.
  const { rows: discovered, complete } = mode === 'install' || mode === 'startup'
    ? catalog !== undefined ? catalogRows(catalog) : await discover(url, catalogFile)
    : { rows: [], complete: true }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const lockPath = `${sidecar}.lock`
  const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw Object.assign(new Error('Another picker setup is running (or its lock remains); settings left unchanged.'), { code: 'ELOCKED' }); throw error })
  const temporary = []
  try {
    const configDir = path.dirname(file)
    if (mode === 'install' && !await canRegisterPicker(configDir)) return { settingsPath: file, mode, count: 0 }
    let original = await read(file)
    const prior = await read(sidecar)
    let settings = original.text === undefined ? {} : parse(original.text, 'Settings')
    let current = picker(settings)
    const saved = prior.text === undefined ? { version: 1, createdPicker: current === undefined, rows: [] } : parse(prior.text, 'Picker ownership record')
    if (saved.version !== 1 || typeof saved.createdPicker !== 'boolean' || !Array.isArray(saved.rows) || saved.rows.some(item => !object(item) || typeof item.model !== 'string' || typeof item.label !== 'string' || typeof item.description !== 'string')) throw new Error('Picker ownership record is malformed; left unchanged.')
    if (mode === 'uninstall') {
      if (await uninstallPlugin(configDir, scope)) return { settingsPath: file, mode, retained: true, count: 0 }
      // Claude just updated enabledPlugins and pluginConfigs. Apply picker
      // cleanup to those new settings while still holding the picker lock.
      original = await read(file)
      settings = original.text === undefined ? {} : parse(original.text, 'Settings')
      current = picker(settings)
    }
    const options = [...(current?.options || [])]
    let owned = saved.rows.filter(owned => options.some(item => isDeepStrictEqual(item, owned)))
    const previouslyPresent = [...owned]
    let count = 0
    if (mode === 'install') {
      // User-authored or edited native rows retain their exact IDs, even when
      // the catalog also advertises a shorter canonical alias.
      const protectedNames = options.filter(item => !owned.some(own => isDeepStrictEqual(item, own))).map(item => item.model)
      if (typeof settings.model === 'string') protectedNames.push(settings.model)
      const choices = modelChoices(discovered.map(row => ({ name: row.model, isCloud: row.description === 'Ollama Cloud', isDecision: false, row })), protectedNames).map(item => item.row)
      const names = new Set(choices.map(item => item.model))
      for (const stale of owned.filter(item => complete && !names.has(item.model))) {
        const index = options.findIndex(item => isDeepStrictEqual(item, stale))
        if (index !== -1) options.splice(index, 1)
      }
      owned = owned.filter(item => !complete || names.has(item.model))
      for (const item of choices) {
        const previous = owned.find(row => row.model === item.model)
        if (previous) {
          const index = options.findIndex(row => isDeepStrictEqual(row, previous))
          if (index !== -1) options[index] = item
          owned = owned.map(row => row === previous ? item : row)
        }
        if (options.some(existing => existing.model === item.model)) continue
        options.push(item); owned.push(item); count++
      }
      const ordered = [...choices, ...owned].filter((row, index, rows) => rows.findIndex(item => item.model === row.model) === index && owned.some(item => isDeepStrictEqual(item, row))).sort((a, b) => compareModels({ name: a.model }, { name: b.model }))
      let next = 0
      for (let index = 0; index < options.length; index++) {
        if (owned.some(row => isDeepStrictEqual(row, options[index]))) options[index] = ordered[next++]
      }
      if (current || options.length) settings.modelPicker = { ...current, options }
    } else if (mode === 'remove' || mode === 'uninstall') {
      const remaining = [...options]
      for (const own of owned) {
        const index = remaining.findIndex(item => isDeepStrictEqual(item, own))
        if (index !== -1) remaining.splice(index, 1)
      }
      count = options.length - remaining.length
      if (mode === 'uninstall' && owned.some(row => row.model === settings.model) && !remaining.some(row => row.model === settings.model)) delete settings.model
      if (current) {
        if (saved.createdPicker && remaining.length === 0 && Object.keys(current).every(key => key === 'options')) delete settings.modelPicker
        else settings.modelPicker = { ...current, options: remaining }
      }
      owned = []
    } else if (typeof settings.model === 'string' && discovered.some(row => canonicalModel(row.model) === canonicalModel(settings.model)) &&
        !discovered.some(row => canonicalModel(row.model) === canonicalModel(nativeModel))) {
      // The active session keeps its selected model. Only the next process
      // starts on Claude, until the plugin has loaded Ollama's real context.
      if (nativeModel === 'default') delete settings.model
      else settings.model = nativeModel
    }
    const nextSettings = JSON.stringify(settings, null, 2) + '\n'
    // Retain ownership of stale rows through this commit too: if the settings
    // rename fails, a retry or remove can still recognize them. A later run
    // drops records for rows no longer present.
    const tracked = mode === 'install' ? [...new Map([...previouslyPresent, ...owned].map(item => [JSON.stringify(item), item])).values()] : owned
    const nextRecord = JSON.stringify({ version: 1, createdPicker: saved.createdPicker, rows: tracked }, null, 2) + '\n'
    const changes = []
    // Record addition intent before exposing new rows. A failed settings rename
    // is safe to retry; it cannot leave new rows with no ownership record.
    if (mode === 'install' && (owned.length > 0 || prior.text !== undefined) && nextRecord !== prior.text) changes.push([sidecar, nextRecord, prior])
    if (!isDeepStrictEqual(settings, original.text === undefined ? {} : JSON.parse(original.text))) changes.push([file, nextSettings, original])
    for (const [target, text, snapshot] of changes) {
      const temp = `${target}.${randomUUID()}.tmp`
      temporary.push(temp)
      await fs.writeFile(temp, text, { flag: 'wx', mode: snapshot.mode })
    }
    // Recheck both exact snapshots just before committing. This catches edits
    // during preparation; separate renames cannot make two files one atomic
    // transaction or exclude another editor after this final comparison.
    if ((await read(file)).text !== original.text || (await read(sidecar)).text !== prior.text) throw Object.assign(new Error('Settings changed during setup; retry. Nothing was replaced.'), { code: 'EAGAIN' })
    for (let index = 0; index < changes.length; index++) {
      if (changes[index][2].text === undefined) {
        await fs.link(temporary[index], changes[index][0])
        await fs.unlink(temporary[index])
      } else await fs.rename(temporary[index], changes[index][0])
    }
    const written = await read(file)
    if (!isDeepStrictEqual(written.text === undefined ? undefined : picker(parse(written.text, 'Settings')), settings.modelPicker)) {
      throw Object.assign(new Error('Native model entries changed during setup; retry.'), { code: 'EAGAIN' })
    }
    if (mode === 'startup' && (written.text === undefined ? undefined : parse(written.text, 'Settings').model) !== settings.model) throw Object.assign(new Error('Startup model changed during setup; retry.'), { code: 'EAGAIN' })
    if ((mode === 'remove' || mode === 'uninstall') && prior.text !== undefined) await fs.unlink(sidecar)
    return { settingsPath: file, mode, count }
  } finally {
    for (const temp of temporary) await fs.unlink(temp).catch(() => {})
    await lock.close()
    await fs.unlink(lockPath)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args[0] && !args[0].startsWith('--') ? args.shift() : 'install'
  if (mode === 'uninstall') {
    if (args.length > 1) throw new Error('Usage: model-picker.mjs uninstall [user|project|local]')
    const result = await configure({ mode, scope: args[0] })
    console.log(result.retained ? 'Ollama uninstalled from this scope. Another install still uses the model picker.'
      : `Ollama uninstalled. Removed ${result.count} Ollama model picker entries. Restart Claude Code.`)
    return
  }
  const options = { mode }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--catalog-stdin') {
      let text = ''
      for await (const chunk of process.stdin) {
        text += chunk
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Catalog is too large.')
      }
      options.catalog = JSON.parse(text)
      continue
    }
    const names = { '--settings': 'settingsPath', '--url': 'url', '--catalog': 'catalogFile', '--native-model': 'nativeModel' }
    if (!names[args[index]] || !args[index + 1]) throw new Error('Usage: model-picker.mjs [install|remove|startup] [--settings /absolute/settings.json] [--url http://localhost:11434] [--catalog models.json | --catalog-stdin] [--native-model MODEL]')
    options[names[args[index]]] = args[++index]
  }
  const result = await configure(options)
  console.log(result.mode === 'startup' ? 'Native startup model preserved.' : `${result.mode === 'install' ? 'Added' : 'Removed'} ${result.count} Ollama model row(s) in ${result.settingsPath}.`)
}
const entry = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => undefined)
if (entry && import.meta.url === pathToFileURL(entry).href) main().catch(error => {
  console.error(error.message)
  process.exitCode = ['ELOCKED', 'EAGAIN', 'EEXIST'].includes(error.code) ? 75 : 1
})
