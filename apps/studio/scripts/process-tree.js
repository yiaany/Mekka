import { spawnSync } from 'node:child_process'
import process from 'node:process'

export function terminateProcessTree(
  child,
  signal = 'SIGTERM',
  { platform = process.platform, spawnSyncImpl = spawnSync } = {}
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false

  if (platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    const result = spawnSyncImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    if (!result.error && result.status === 0) return true
  }

  if (child.killed) return false
  return child.kill(signal)
}
