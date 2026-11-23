import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Only consult the desktop app's setting when its server owns this listener.
// A proxy or a second Ollama instance can have a different configuration.
async function ownsListener(pid, url) {
  const port = url.port || '80'
  const addresses = new Set()
  if (url.hostname !== '[::1]') {
    addresses.add(`127.0.0.1:${port}`)
    addresses.add(`0.0.0.0:${port}`)
  }
  if (url.hostname !== '127.0.0.1') {
    addresses.add(`[::1]:${port}`)
    addresses.add(`[::]:${port}`)
  }
  if (process.platform === 'win32') {
    const { stdout } = await exec(path.join(process.env.SystemRoot, 'System32', 'netstat.exe'), ['-ano'], { windowsHide: true, timeout: 2000 })
    const listeners = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .filter(([protocol, address, peer]) => protocol === 'TCP' && addresses.has(address) && peer?.endsWith(':0'))
    return listeners.length > 0 && listeners.every(row => row.at(-1) === pid)
  }
  addresses.add(`*:${port}`)
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 2000 })
  let owner
  const owners = []
  for (const field of stdout.split('\n')) {
    if (field.startsWith('p')) owner = field.slice(1)
    if (field.startsWith('n') && addresses.has(field.slice(1))) owners.push(owner)
  }
  return owners.length > 0 && owners.every(value => value === pid)
}

async function desktopContext(base) {
  const url = new URL(base)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return
  let directory
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) directory = path.join(process.env.LOCALAPPDATA, 'Ollama')
  if (process.platform === 'darwin') directory = path.join(homedir(), 'Library', 'Application Support', 'Ollama')
  if (!directory) return
  const pid = (await readFile(path.join(directory, 'ollama.pid'), 'utf8')).trim()
  if (!/^[1-9]\d*$/.test(pid) || !await ownsListener(pid, url)) return
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(directory, 'db.sqlite'), { readOnly: true })
  try {
    const size = db.prepare('SELECT context_length FROM settings LIMIT 1').get()?.context_length
    if (Number.isSafeInteger(size) && size > 0) return size
  } finally {
    db.close()
  }
}

// The daemon API remains usable on systems without the app or built-in SQLite.
const size = await desktopContext(process.argv[2]).catch(() => undefined)
if (size !== undefined) console.log(size)
