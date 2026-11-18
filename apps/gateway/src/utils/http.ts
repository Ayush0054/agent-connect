import { MAX_SMALL_JSON_BYTES } from '../constants'

/** Read a response body as text, failing once it exceeds `limit` bytes. */
export async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error('Response is too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}

export async function readSmallJson(response: Response): Promise<unknown> {
  return JSON.parse(await readLimitedText(response, MAX_SMALL_JSON_BYTES))
}
