import { cp, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

// Claude compiles native TypeScript modules itself. Check the sources, then
// package that same module tree so its capability scan can follow imports.
const checked = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' })
if (checked.status !== 0) process.exit(checked.status ?? 1)
const target = 'dist/ollama'
await rm(target, { recursive: true, force: true })
await mkdir(`${target}/.claude-plugin`, { recursive: true })
await mkdir(`${target}/scripts`, { recursive: true })
await cp('scripts/desktop-context.mjs', `${target}/scripts/desktop-context.mjs`)
await cp('scripts/model-picker.mjs', `${target}/scripts/model-picker.mjs`)
await cp('scripts/plugin-installation.mjs', `${target}/scripts/plugin-installation.mjs`)
await cp('scripts/migrate-settings.mjs', `${target}/scripts/migrate-settings.mjs`)
for (const path of ['hooks', 'types', 'README.md']) await cp(path, `${target}/${path}`, { recursive: true })
for (const path of ['plugin.json', 'marketplace.json']) await cp(`.claude-plugin/${path}`, `${target}/.claude-plugin/${path}`)
