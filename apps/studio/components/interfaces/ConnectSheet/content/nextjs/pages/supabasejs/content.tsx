import { MultipleCodeBlock } from 'ui-patterns/MultipleCodeBlock'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'

const ContentFile = ({ projectKeys }: StepContentProps) => {
  const files = [
    {
      name: '.env.local',
      language: 'bash',
      code: [
        `NEXT_PUBLIC_LITEBASE_URL=${projectKeys.apiUrl ?? 'your-project-url'}`,
        projectKeys?.publishableKey
          ? `NEXT_PUBLIC_LITEBASE_PUBLISHABLE_KEY=${projectKeys.publishableKey}`
          : `NEXT_PUBLIC_LITEBASE_ANON_KEY=${projectKeys.anonKey ?? 'your-anon-key'}`,
        '',
      ].join('\n'),
    },
    {
      name: 'utils/litebase.ts',
      language: 'ts',
      code: `
import { createClient } from "@supabase/supabase-js";

const litebaseUrl = process.env.NEXT_PUBLIC_LITEBASE_URL!;
const litebaseKey = process.env.${projectKeys?.publishableKey ? 'NEXT_PUBLIC_LITEBASE_PUBLISHABLE_KEY' : 'NEXT_PUBLIC_LITEBASE_ANON_KEY'}!;

export const litebase = createClient(litebaseUrl, litebaseKey);
`,
    },
    {
      name: 'pages/index.tsx',
      language: 'tsx',
      code: `
import { useState, useEffect } from 'react'
 import { litebase } from '../utils/litebase'

export default function Page() {
  const [todos, setTodos] = useState([])

  useEffect(() => {
    async function getTodos() {
      const { data: todos } = await litebase.from('todos').select()

      if (todos) {
        setTodos(todos)
      }
    }

    getTodos()
  }, [])

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.name}</li>
      ))}
    </ul>
  )
}
`,
    },
  ]

  return <MultipleCodeBlock files={files} />
}

export default ContentFile
