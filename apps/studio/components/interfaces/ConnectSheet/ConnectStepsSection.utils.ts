import type { ConnectState } from './Connect.types'

export function resolveContentPath(template: string, state: ConnectState): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key) => String(state[key] ?? ''))
    .split('/')
    .filter(Boolean)
    .join('/')
}

// Retained temporarily for legacy unit-test imports. Unsupported Connect modes never invoke them.
export function shouldShowIpv4AddonNotice(..._args: unknown[]): boolean {
  return false
}

export function shouldShowSessionPoolerNotice(..._args: unknown[]): boolean {
  return false
}

export function shouldShowSelfHostedMcpNotice(..._args: unknown[]): boolean {
  return false
}

export function shouldFetchDataApiConfig(..._args: unknown[]): boolean {
  return false
}

export function shouldShowDataApiDisabledWarning(..._args: unknown[]): boolean {
  return false
}
