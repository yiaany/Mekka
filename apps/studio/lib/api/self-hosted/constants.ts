// Constants specific to self-hosted environments

// Schemas exposed via PostgREST Data API, read from the PGRST_DB_SCHEMAS env var
// that is passed to the Studio container via docker-compose / CLI.
export const DEFAULT_EXPOSED_SCHEMAS = process.env.PGRST_DB_SCHEMAS ?? 'public,graphql_public'

export const ENCRYPTION_KEY = process.env.PG_META_CRYPTO_KEY || undefined
export const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || '5432', 10)
export const POSTGRES_HOST = process.env.POSTGRES_HOST || 'db'
export const POSTGRES_DATABASE = process.env.POSTGRES_DB || 'postgres'
export const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || undefined
export const POSTGRES_USER_READ_WRITE = process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin'
export const POSTGRES_USER_READ_ONLY =
  process.env.POSTGRES_USER_READ_ONLY || 'supabase_read_only_user'

export const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || undefined

export function requireEnvironmentVariable(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} must be configured for Mekka Studio`)
  return value
}
