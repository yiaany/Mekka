import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import { QuickSetupWizard } from '../../components/interfaces/Onboarding/QuickSetupWizard'

const html = renderToStaticMarkup(<QuickSetupWizard />)

assert.match(html, /Create your backend/)
assert.match(html, /Organization name/)
assert.match(html, /Project name/)
assert.match(html, /Enabled modules/)
assert.match(html, /Safe defaults create an isolated production project/)
assert.doesNotMatch(html, /serviceRoleKey|service key|server secret/i)

test('onboarding assertions completed', () => {})
