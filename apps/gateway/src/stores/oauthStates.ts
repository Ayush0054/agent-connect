// Pending sign-ins to apps. A state is stored as a hash and works once.
import type { OAuthState } from '../types/connections'
import type { Env } from '../types/env'
import { execute, first } from './db'

export async function insertOAuthState(env: Env, state: { stateHash: string; owner: string; connectionId: string; verifierCiphertext: string; expiresAt: string }): Promise<void> {
  await execute(env, 'INSERT INTO oauth_states (state_hash, owner_sub, connection_id, verifier_ciphertext, expires_at) VALUES ($1, $2, $3, $4, $5)', [
    state.stateHash, state.owner, state.connectionId, state.verifierCiphertext, state.expiresAt,
  ])
}

export function getOAuthState(env: Env, stateHash: string): Promise<OAuthState | null> {
  return first(env, 'SELECT * FROM oauth_states WHERE state_hash = $1', [stateHash])
}

/** Returns false when another request already used the state. */
export async function consumeOAuthState(env: Env, stateHash: string): Promise<boolean> {
  const result = await execute(env, 'DELETE FROM oauth_states WHERE state_hash = $1', [stateHash])
  return result.rowCount > 0
}
