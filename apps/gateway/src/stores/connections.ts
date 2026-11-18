import type { ConnectionSummary } from '../types/api'
import type { Connection } from '../types/connections'
import type { Env } from '../types/env'
import { execute, first, rows } from './db'

export function getConnection(env: Env, id: string, owner: string): Promise<Connection | null> {
  return first(env, 'SELECT * FROM connections WHERE id = $1 AND owner_sub = $2', [id, owner])
}

export function listConnectionSummaries(env: Env, owner: string): Promise<ConnectionSummary[]> {
  return rows(env, 'SELECT id, name, kind, auth_kind, mcp_url, connected_at FROM connections WHERE owner_sub = $1 ORDER BY created_at DESC', [owner])
}

/** Connections that hold a credential, oldest first. */
export function listConnectedConnections(env: Env, owner: string): Promise<Connection[]> {
  return rows(env, 'SELECT * FROM connections WHERE owner_sub = $1 AND access_token_ciphertext IS NOT NULL ORDER BY created_at', [owner])
}

type NewConnection = { id: string; owner: string; name: string }
type OAuthFields = { authorizationUrl: string; tokenUrl: string; clientId: string; scope: string }

/** An app with its own MCP server. Not connected until the user signs in to the app. */
export async function insertMcpConnection(env: Env, connection: NewConnection & OAuthFields & { mcpUrl: string }): Promise<void> {
  await execute(env,
    'INSERT INTO connections (id, owner_sub, name, mcp_url, authorization_url, token_url, client_id, scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [connection.id, connection.owner, connection.name, connection.mcpUrl, connection.authorizationUrl, connection.tokenUrl, connection.clientId, connection.scope])
}

/** A REST app that takes an API key. Connected at once, because the key is all it needs. */
export async function insertApiKeyConnection(env: Env, connection: NewConnection & { baseUrl: string; specUrl: string; header: string; prefix: string; keyCiphertext: string }): Promise<void> {
  await execute(env,
    "INSERT INTO connections (id, owner_sub, name, kind, mcp_url, spec_url, auth_kind, auth_header, auth_prefix, access_token_ciphertext, connected_at) VALUES ($1, $2, $3, 'openapi', $4, $5, 'api_key', $6, $7, $8, now())",
    [connection.id, connection.owner, connection.name, connection.baseUrl, connection.specUrl, connection.header, connection.prefix, connection.keyCiphertext])
}

/** A REST app that uses OAuth. Not connected until the user signs in to the app. */
export async function insertOpenApiOAuthConnection(env: Env, connection: NewConnection & OAuthFields & { baseUrl: string; specUrl: string }): Promise<void> {
  await execute(env,
    "INSERT INTO connections (id, owner_sub, name, kind, mcp_url, spec_url, auth_kind, authorization_url, token_url, client_id, scope) VALUES ($1, $2, $3, 'openapi', $4, $5, 'oauth', $6, $7, $8, $9)",
    [connection.id, connection.owner, connection.name, connection.baseUrl, connection.specUrl, connection.authorizationUrl, connection.tokenUrl, connection.clientId, connection.scope])
}

export async function saveConnectionTokens(env: Env, id: string, tokens: { accessCiphertext: string; refreshCiphertext: string | null; expiresAt: string | null }): Promise<void> {
  await execute(env, 'UPDATE connections SET access_token_ciphertext = $1, refresh_token_ciphertext = $2, token_expires_at = $3, connected_at = now() WHERE id = $4',
    [tokens.accessCiphertext, tokens.refreshCiphertext, tokens.expiresAt, id])
}

/** Disconnect an OAuth connection but keep it, so the user can sign in again. */
export async function clearConnectionTokens(env: Env, id: string): Promise<void> {
  await execute(env, 'UPDATE connections SET access_token_ciphertext = NULL, refresh_token_ciphertext = NULL, token_expires_at = NULL, connected_at = NULL WHERE id = $1', [id])
}

export async function deleteConnection(env: Env, id: string): Promise<void> {
  await execute(env, 'DELETE FROM connections WHERE id = $1', [id])
}
