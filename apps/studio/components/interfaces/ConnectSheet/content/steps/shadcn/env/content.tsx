import { MultipleCodeBlock } from 'ui-patterns/MultipleCodeBlock'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'

function getEnvFile(
  state: StepContentProps['state'],
  projectKeys: StepContentProps['projectKeys']
) {
  if (state.framework === 'nextjs') {
    return {
      name: '.env.local',
      language: 'bash',
      code: [
        `NEXT_PUBLIC_LITEBASE_URL=${projectKeys.apiUrl ?? 'your-project-url'}`,
        projectKeys.publishableKey
          ? `NEXT_PUBLIC_LITEBASE_PUBLISHABLE_KEY=${projectKeys.publishableKey}`
          : `LITEBASE_ANON_KEY=${projectKeys.anonKey ?? 'your-anon-key'}`,
        '',
      ].join('\n'),
    }
  }

  if (state.framework === 'react') {
    const isCreateReactApp = state.frameworkVariant === 'create-react-app'
    const envFileName = isCreateReactApp ? '.env.local' : '.env'
    const keyPrefix = isCreateReactApp ? 'REACT_APP' : 'VITE'

    return {
      name: envFileName,
      language: 'bash',
      code: [
        `${keyPrefix}_LITEBASE_URL=${projectKeys.apiUrl ?? 'your-project-url'}`,
        projectKeys.publishableKey
          ? `${keyPrefix}_LITEBASE_PUBLISHABLE_KEY=${projectKeys.publishableKey}`
          : `${keyPrefix}_LITEBASE_ANON_KEY=${projectKeys.anonKey ?? 'your-anon-key'}`,
        '',
      ].join('\n'),
    }
  }

  return null
}

function ShadcnEnvContent({ state, projectKeys }: StepContentProps) {
  const envFile = getEnvFile(state, projectKeys)

  if (!envFile) return null

  return <MultipleCodeBlock files={[envFile]} />
}

export default ShadcnEnvContent
