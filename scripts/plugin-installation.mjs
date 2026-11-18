import { spawnSync } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const marketplace = 'ollama'
const id = `ollama@${marketplace}`

async function readRegistry(configDir, filename) {
  try { return JSON.parse(await readFile(path.join(configDir, 'plugins', filename), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

async function installations(configDir) {
  const registry = await readRegistry(configDir, 'installed_plugins.json')
  if (registry === undefined) return []
  const entries = registry?.plugins?.[id] ?? []
  if (registry?.version !== 2 || !registry.plugins || typeof registry.plugins !== 'object' || Array.isArray(registry.plugins) ||
      !Array.isArray(entries) || entries.some(entry => typeof entry?.installPath !== 'string' || typeof entry.scope !== 'string')) {
    throw new Error('Cannot read Claude’s installed plugins. Check the installation with claude plugin list.')
  }
  return entries
}

// Claude may run a directory marketplace in place. Both that copy and its
// cache can outlive uninstall, while an independent --plugin-dir needs no install.
export async function canRegisterPicker(configDir) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const cache = path.join(await realpath(configDir), 'plugins', 'cache', marketplace, 'ollama')
  if (!root.startsWith(cache + path.sep)) {
    const marketplaces = await readRegistry(configDir, 'known_marketplaces.json')
    const location = marketplaces?.[marketplace]?.installLocation
    if (!location || await realpath(location).catch(() => undefined) !== root) return true
    return (await installations(configDir)).length > 0
  }
  const entries = await installations(configDir)
  for (const entry of entries) {
    if (await realpath(entry.installPath).catch(() => undefined) === root) return true
  }
  return false
}

export async function uninstallPlugin(configDir, scope) {
  if (!['user', 'project', 'local'].includes(scope)) throw new Error('Choose user, project, or local as the uninstall scope.')
  if (!(await installations(configDir)).length) return false
  const result = spawnSync('claude', ['plugin', 'uninstall', id, '--scope', scope, '--keep-data'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8', timeout: 30000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Claude could not uninstall Ollama.')
  return (await installations(configDir)).length > 0
}
