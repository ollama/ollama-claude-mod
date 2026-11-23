import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const helper = fileURLToPath(new URL('./desktop-context.mjs', import.meta.url))
const supported = ['win32', 'darwin'].includes(process.platform)

test('read the context setting only from the app serving this endpoint', { skip: !supported }, async t => {
  const sqlite = await import('node:sqlite').catch(() => undefined)
  if (!sqlite) return t.skip('Built-in SQLite is unavailable')

  const root = await mkdtemp(path.join(tmpdir(), 'ollama-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const windows = process.platform === 'win32'
  const directory = windows ? path.join(root, 'Ollama') : path.join(root, 'Library', 'Application Support', 'Ollama')
  await mkdir(directory, { recursive: true })
  const db = new sqlite.DatabaseSync(path.join(directory, 'db.sqlite'))
  db.exec('CREATE TABLE settings (context_length INTEGER); INSERT INTO settings VALUES (131072)')
  db.close()
  const pidFile = path.join(directory, 'ollama.pid')
  await writeFile(pidFile, String(process.pid))

  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const env = windows ? { ...process.env, LOCALAPPDATA: root } : { ...process.env, HOME: root }
  const query = async host => (await promisify(execFile)(process.execPath, [helper, `http://${host}:${port}`], { env })).stdout.trim()
  assert.equal(await query('127.0.0.1'), '131072')
  assert.equal(await query('example.invalid'), '')
  await writeFile(pidFile, '999999999')
  assert.equal(await query('127.0.0.1'), '')
})
