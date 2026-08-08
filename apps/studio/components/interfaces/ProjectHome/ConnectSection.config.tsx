import { KeyRound, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'

import type { ConnectMode } from '../ConnectSheet/Connect.types'

export type ConnectAction = {
  id: ConnectMode | 'api_keys'
  heading: string
  subheading: string
  icon: ReactNode
  mode?: ConnectMode
  href?: string
  requiresActiveProject?: boolean
}

export const CONNECT_ACTIONS: ConnectAction[] = [
  {
    id: 'mcp',
    mode: 'mcp',
    heading: 'Mekka MCP',
    subheading: 'View agent integration status',
    icon: <Sparkles size={16} strokeWidth={1.5} />,
  },
  {
    id: 'api_keys',
    heading: 'API Keys',
    subheading: 'Manage project keys',
    icon: <KeyRound size={16} strokeWidth={1.5} />,
    href: '/project/[ref]/settings/api-keys',
    requiresActiveProject: false,
  },
]
