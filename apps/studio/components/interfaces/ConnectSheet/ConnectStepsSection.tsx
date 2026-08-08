import { useRef } from 'react'

import MekkaMcpContent from './content/mekka/mcp/content'
import type { ConnectState, ProjectKeys, ResolvedStep } from './Connect.types'
import { CopyPromptButton } from './CopyPromptAdmonition'

interface ConnectStepsSectionProps {
  steps: ResolvedStep[]
  state: ConnectState
  projectKeys: ProjectKeys
}

export function ConnectStepsSection({ steps }: ConnectStepsSectionProps) {
  const stepsContainerRef = useRef<HTMLDivElement | null>(null)
  if (steps.length === 0) return null

  return (
    <div className="flex-1 bg-surface-100">
      <div className="flex items-center justify-between gap-4 border-b px-8 py-4">
        <div>
          <h3 className="font-medium">Mekka MCP</h3>
          <p className="text-sm text-foreground-light">One endpoint, scoped to this project.</p>
        </div>
        <CopyPromptButton stepsContainerRef={stepsContainerRef} />
      </div>
      <div ref={stepsContainerRef} className="p-8">
        <MekkaMcpContent />
      </div>
    </div>
  )
}
