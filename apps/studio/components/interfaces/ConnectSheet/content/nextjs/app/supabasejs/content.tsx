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
          : `LITEBASE_ANON_KEY=${projectKeys.anonKey ?? 'your-anon-key'}`,
        '',
      ].join('\n'),
    },
    {
      name: 'page.tsx',
      language: 'tsx',
      code: `
import { createClient } from '@/utils/litebase/server'
import { cookies } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const litebase = createClient(cookieStore)

  const { data: todos } = await litebase.from('todos').select()

  return (
    <ul>
      {todos?.map((todo) => (
        <li key={todo.id}>{todo.name}</li>
      ))}
    </ul>
  )
}
`,
    },
    {
      name: 'utils/litebase/server.ts',
      language: 'ts',
      code: `
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const litebaseUrl = process.env.NEXT_PUBLIC_LITEBASE_URL;
const litebaseKey = process.env.${projectKeys?.publishableKey ? 'NEXT_PUBLIC_LITEBASE_PUBLISHABLE_KEY' : 'LITEBASE_ANON_KEY'};

export const createClient = (cookieStore: Awaited<ReturnType<typeof cookies>>) => {
  return createServerClient(
    litebaseUrl!,
    litebaseKey!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // The \`setAll\` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    },
  );
};
`,
    },
    {
      name: 'utils/litebase/client.ts',
      language: 'ts',
      code: `
import { createBrowserClient } from "@supabase/ssr";

const litebaseUrl = process.env.NEXT_PUBLIC_LITEBASE_URL;
const litebaseKey = process.env.${projectKeys?.publishableKey ? 'NEXT_PUBLIC_LITEBASE_PUBLISHABLE_KEY' : 'LITEBASE_ANON_KEY'};

export const createClient = () =>
  createBrowserClient(
    litebaseUrl!,
    litebaseKey!,
  );
`,
    },
    {
      name: 'utils/litebase/middleware.ts',
      language: 'ts',
      code: `
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const litebaseUrl = process.env.NEXT_PUBLIC_LITEBASE_URL;
const litebaseKey = process.env.${projectKeys?.publishableKey ? 'NEXT_PUBLIC_LITEBASE_PUBLISHABLE_KEY' : 'LITEBASE_ANON_KEY'};

export const createClient = (request: NextRequest) => {
  // Create an unmodified response
  let litebaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    litebaseUrl!,
    litebaseKey!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
            litebaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            litebaseResponse.cookies.set(name, value, options)
          )
        },
      },
    },
  );

  return litebaseResponse
};
`,
    },
  ]

  return <MultipleCodeBlock files={files} />
}

// [Joshen] Used as a dynamic import
export default ContentFile
