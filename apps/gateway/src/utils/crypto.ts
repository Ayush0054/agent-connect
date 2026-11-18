import type { Env } from '../types/env'

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** SHA-256 as lowercase hex. Used to store tokens, codes and states without keeping their values. */
export async function sha256(value: string): Promise<string> {
  return [...await digest(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 as base64url. Used for PKCE challenges and the assertion's token hash. */
export async function sha256Base64url(value: string): Promise<string> {
  return base64url(await digest(value))
}

export const pkceChallenge = sha256Base64url

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = fromBase64url(env.ENCRYPTION_KEY)
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must contain 32 bytes')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** AES-GCM. The output is the 12-byte nonce followed by the ciphertext, base64url-encoded. */
export async function encrypt(env: Env, value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await encryptionKey(env), new TextEncoder().encode(value)))
  const output = new Uint8Array(nonce.length + encrypted.length)
  output.set(nonce)
  output.set(encrypted, nonce.length)
  return base64url(output)
}

export async function decrypt(env: Env, value: string): Promise<string> {
  const bytes = fromBase64url(value)
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await encryptionKey(env), bytes.slice(12))
  return new TextDecoder().decode(clear)
}
