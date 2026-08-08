import type { ConnectSchema, StepDefinition } from './Connect.types'

const mcpStatusStep: StepDefinition = {
  id: 'mcp-status',
  title: 'Mekka MCP',
  description: 'MCP is available only when a tenant-bound endpoint and OAuth issuer are configured.',
  content: 'mekka/mcp',
}

// ============================================================================
// Main Schema
// ============================================================================

export const connectSchema: ConnectSchema = {
  // -------------------------------------------------------------------------
  // Mode Definitions
  // -------------------------------------------------------------------------
  modes: [
    {
      id: 'mcp',
      label: 'Mekka MCP',
      description: 'Tenant-bound agent access',
      fields: [],
    },
  ],

  // -------------------------------------------------------------------------
  // Field Definitions
  // -------------------------------------------------------------------------
  fields: {
  },

  // -------------------------------------------------------------------------
  // Steps - Conditional based on mode and nested selections
  // -------------------------------------------------------------------------
  steps: {
    // Keys are field IDs; each field maps state values to step trees.
    mode: {
      mcp: [mcpStatusStep],
    },
  },
}
