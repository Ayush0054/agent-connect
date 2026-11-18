// Postgres access over Neon's HTTP driver. Only files in `stores/` contain SQL.
import { neon, neonConfig } from '@neondatabase/serverless'
import type { Env } from '../types/env'
import { isLoopback } from '../utils/urls'

type Param = string | number | null

function db(env: Env) {
  if (env.DATABASE_HTTP_ENDPOINT) {
    const endpoint = new URL(env.DATABASE_HTTP_ENDPOINT)
    if (endpoint.protocol !== 'http:' || !isLoopback(endpoint.hostname)) throw new Error('DATABASE_HTTP_ENDPOINT must be a loopback http:// URL')
    neonConfig.fetchEndpoint = endpoint.toString()
  }
  return neon(env.DATABASE_URL, { fullResults: true })
}

export async function rows<T>(env: Env, sql: string, params: Param[] = []): Promise<T[]> {
  const result = await db(env).query(sql, params)
  return result.rows as T[]
}

export async function first<T>(env: Env, sql: string, params: Param[] = []): Promise<T | null> {
  return (await rows<T>(env, sql, params))[0] ?? null
}

export async function execute(env: Env, sql: string, params: Param[] = []): Promise<{ rowCount: number }> {
  const result = await db(env).query(sql, params)
  return { rowCount: result.rowCount ?? 0 }
}
