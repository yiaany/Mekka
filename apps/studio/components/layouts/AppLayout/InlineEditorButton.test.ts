import { describe, expect, it } from 'vitest'

import { getInlineEditorDestination } from './InlineEditorButton'

describe('InlineEditorButton', () => {
  it('opens the restricted Mekka SQL workspace in the self-hosted fork', () => {
    expect(getInlineEditorDestination('local')).toBe('/project/local/sql/new')
    expect(getInlineEditorDestination(undefined)).toBeNull()
  })
})
