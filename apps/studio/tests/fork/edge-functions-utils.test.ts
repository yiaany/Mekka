import assert from 'node:assert/strict'
import { test } from 'vitest'

import { formatFunctionBodyToFiles } from '../../components/interfaces/EdgeFunctions/EdgeFunctions.utils'

const files = formatFunctionBodyToFiles({
  entrypointPath: 'functions/hello/index.ts',
  functionBody: {
    metadata: { deno2_entrypoint_path: 'functions/hello/index.ts' },
    files: [
      { name: 'functions/hello/index.ts', content: 'Deno.serve(() => new Response("ok"))' },
      { name: 'functions/hello/lib/message.ts', content: 'export const message = "ok"' },
    ],
  },
})

assert.deepEqual(
  files.map(({ name }) => name),
  ['index.ts', 'lib/message.ts']
)

test('Edge Functions utility assertions completed', () => {})
