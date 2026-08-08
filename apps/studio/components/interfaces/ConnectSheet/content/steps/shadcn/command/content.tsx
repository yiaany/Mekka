import { useMemo } from 'react'
import { CodeBlock } from 'ui-patterns/CodeBlock'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'

function getShadcnCommand(state: StepContentProps['state']): string | null {
  if (state.framework === 'nextjs') {
    return 'npm install @supabase/supabase-js @supabase/ssr'
  }

  if (state.framework === 'react') {
    return 'npm install @supabase/supabase-js'
  }

  return null
}

function ShadcnCommandContent({ state }: StepContentProps) {
  const command = useMemo(() => getShadcnCommand(state), [state])

  if (!command) return null

  return (
    <div className="flex flex-col gap-2">
      <CodeBlock
        className="[&_code]:text-foreground"
        wrapperClassName="lg:col-span-2"
        value={command}
        hideLineNumbers
        language="bash"
      >
        {command}
      </CodeBlock>
      <p className="text-sm text-foreground-lighter">
        Use the official Supabase SDK in Litebase compatibility mode. Litebase endpoints and keys are
        configured in the next step.
      </p>
    </div>
  )
}

export default ShadcnCommandContent
