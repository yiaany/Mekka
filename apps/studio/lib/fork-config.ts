export const STUDIO_BRAND = {
  name: 'Mekka',
  description: 'Mekka Studio',
} as const

export const STUDIO_FEATURES = {
  tableEditor: true,
  sqlEditor: true,
  database: false,
  auth: true,
  storage: false,
  edgeFunctions: false,
  realtime: false,
  advisors: false,
  observability: false,
  logs: false,
  integrations: false,
  settings: false,
  aiAssistant: false,
} as const
