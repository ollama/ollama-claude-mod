import type { EngineInterface } from 'claude-code'
import type { Effort, Thinking } from '../types'

function namedEffort(value: unknown): Effort | undefined {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

// Desktop writes the launch selection near the start of the session record.
// Parse only a complete top-level prefix so nested data cannot supply a level.
function launchEffort(header: string, hostId: string, model: string): Effort | undefined {
  for (const match of header.matchAll(/"(?:sessionId|model|effort)"\s*:\s*"[^"\\]*"\s*(?=[,}])/g)) {
    try {
      const data = JSON.parse(header.slice(0, match.index! + match[0].length) + '}')
      const level = namedEffort(data.effort)
      if (level && data.sessionId === hostId && data.model === model) return level
    } catch { /* A nested field does not end a complete top-level prefix. */ }
  }
}

export async function desktopEffort($: EngineInterface, model: string, observed?: Thinking): Promise<Thinking | undefined> {
  const override = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
  if (override) return namedEffort(override)
  const flag = await $.settings.read({ source: 'flag' })
  if (flag.effortLevel !== undefined) return namedEffort(flag.effortLevel)
  if (observed) return observed

  // Desktop supplies the initial effort via --effort, outside the settings
  // layers. Use the current chat's own record until Desktop publishes a flag.
  const [hostId, account, org] = await Promise.all([
    $.env.get('CLAUDE_CODE_HOST_SESSION_ID'), $.env.get('CLAUDE_CODE_ACCOUNT_UUID'), $.env.get('CLAUDE_CODE_ORGANIZATION_UUID'),
  ])
  if (!hostId?.startsWith('local_') || !uuid.test(hostId.slice(6)) || !account || !uuid.test(account) || !org || !uuid.test(org)) return
  const { platform } = await $.session.info()
  const roots: string[] = []
  if (platform === 'windows') {
    const [local, roaming] = await Promise.all([$.env.get('LOCALAPPDATA'), $.env.get('APPDATA')])
    if (local) roots.push(`${local}/Claude-Data/claude_pzs8sxrjxfjjc`)
    if (roaming) roots.push(`${roaming}/Claude`)
  } else if (platform === 'macos') {
    const home = await $.env.get('HOME')
    if (home) roots.push(`${home}/Library/Application Support/Claude`)
  }
  for (const root of roots) {
    const path = `${root}/claude-code-sessions/${account}/${org}/${hostId}.json`
    const header = await $.fs.read(path, { length: 8192 }).catch(() => undefined)
    if (header !== undefined) return launchEffort(header, hostId, model)
  }
}
