/** Worker bindings and variables. Secrets live in `.dev.vars` locally and in Worker secrets when deployed. */
export type Env = {
  /** Neon Postgres connection string. */
  DATABASE_URL: string
  ENCRYPTION_KEY: string
  ASSERTION_PRIVATE_JWK: string
  ASSETS: { fetch(request: Request): Promise<Response> }
  PUBLIC_BASE_URL: string
  MCP_BASE_URL: string
  ACCESS_ISSUER: string
  ACCESS_AUD: string
  /** Local development only: a loopback Neon HTTP proxy, e.g. http://127.0.0.1:4444/sql. */
  DATABASE_HTTP_ENDPOINT?: string
  /** Local development only: owner used when PUBLIC_BASE_URL is a loopback http:// origin. */
  DEV_OWNER?: string
  /** Local development only: allow http:// app URLs on loopback hosts. */
  ALLOW_LOOPBACK_APPS?: string
}

/** Hono environment. `owner` is set by the admin auth middleware. */
export type AppEnv = { Bindings: Env; Variables: { owner: string } }
