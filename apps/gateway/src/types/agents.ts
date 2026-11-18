// Rows of the `agents`, `grants` and `action_log` tables.

export type Agent = { id: string; owner_sub: string; name: string; token_hash: string | null; revoked_at: string | null; created_at: string }

/** One agent may call one tool of one connection. */
export type Grant = { agent_id: string; connection_id: string; tool_name: string }

export type ActionOutcome = 'success' | 'tool_error' | 'transport_error'

export type Action = { id: string; agent_id: string; connection_id: string; tool_name: string; outcome: ActionOutcome; created_at: string }
