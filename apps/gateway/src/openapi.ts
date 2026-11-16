// Connect an app that has a REST API but no MCP server: import its OpenAPI
// spec once, expose each operation as a tool, and call the REST API directly.
import { parse as parseYaml } from 'yaml'
import { execute, rows, trustedUrl, type Agent, type Connection, type Env } from './core'
import { readLimitedText } from './discovery'
import { agentAssertion } from './assertion'
import { appToken } from './oauth'

type Json = Record<string, unknown>
export type ParamLocation = { name: string; in: 'path' | 'query' | 'body' }
export type ImportedTool = { name: string; description: string; method: string; path: string; inputSchema: Json; params: ParamLocation[] }
export type ImportedSpec = { title: string; baseUrl: string; tools: ImportedTool[] }
export type StoredTool = { connection_id: string; tool_name: string; description: string; method: string; path: string; input_schema: string; params: string }

const MAX_SPEC_BYTES = 2_000_000
const MAX_TOOLS = 300
const MAX_SCHEMA_BYTES = 32_000
const MAX_RESPONSE_BYTES = 100_000
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const reservedHeaders = new Set(['host', 'content-length', 'content-type', 'accept', 'agent-connect-assertion'])

export class SpecError extends Error {}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function pointer(root: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new SpecError('Only references inside the same document are supported')
  let node: unknown = root
  for (const part of ref.slice(2).split('/')) {
    if (!isObject(node)) return undefined
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return node
}

/** Follow a top-level `$ref` (parameters, request bodies) without expanding the node's children. */
function follow(root: Json, node: unknown): Json | null {
  for (let hops = 0; hops < 8 && isObject(node); hops++) {
    if (typeof node.$ref !== 'string') return node
    node = pointer(root, node.$ref)
  }
  return null
}

/** Inline `$ref`s and drop OpenAPI-only keywords so the result is plain JSON Schema. Cycles become `{}`. */
function toJsonSchema(root: Json, node: unknown, depth = 0, active = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map(item => toJsonSchema(root, item, depth + 1, active))
  if (!isObject(node)) return node
  if (depth > 12) return {}
  if (typeof node.$ref === 'string') {
    if (active.has(node.$ref)) return {}
    const next = new Set(active).add(node.$ref)
    return toJsonSchema(root, pointer(root, node.$ref) ?? {}, depth + 1, next)
  }
  const output: Json = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'nullable' || key === 'example' || key === 'xml' || key === 'externalDocs' || key === 'discriminator' || key.startsWith('x-')) continue
    // `properties` maps names to schemas, so its keys are not keywords and must not be filtered.
    output[key] = key === 'properties' && isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, toJsonSchema(root, schema, depth + 1, active)]))
      : toJsonSchema(root, value, depth + 1, active)
  }
  if (node.nullable === true && typeof output.type === 'string') output.type = [output.type, 'null']
  return output
}

function toolName(operationId: unknown, method: string, path: string, taken: Set<string>): string {
  const source = typeof operationId === 'string' && operationId.trim() ? operationId : `${method}_${path}`
  const base = source.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'operation'
  let name = base
  for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`
  taken.add(name)
  return name
}

function serverUrl(doc: Json, specUrl: string): string {
  const server = Array.isArray(doc.servers) ? follow(doc, doc.servers[0]) : null
  let url = typeof server?.url === 'string' ? server.url : '/'
  const variables = isObject(server?.variables) ? server.variables : {}
  url = url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const variable = variables[name]
    if (!isObject(variable) || typeof variable.default !== 'string') throw new SpecError('The spec\'s server URL has a variable without a default. Enter the API base URL.')
    return variable.default
  })
  return new URL(url, specUrl).toString()
}

export function parseSpec(text: string, specUrl: string, env: Env, baseOverride?: string): ImportedSpec {
  let doc: unknown
  try { doc = JSON.parse(text) } catch {
    try { doc = parseYaml(text) } catch { throw new SpecError('The spec is not valid JSON or YAML') }
  }
  if (!isObject(doc) || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) throw new SpecError('Only OpenAPI 3.x specs are supported')
  if (!isObject(doc.paths)) throw new SpecError('The spec has no paths')

  let baseUrl: string
  try { baseUrl = trustedUrl(baseOverride || serverUrl(doc, specUrl), env) }
  catch (error) { throw error instanceof SpecError ? error : new SpecError('The API base URL must be a public HTTPS URL') }
  if (new URL(baseUrl).search) throw new SpecError('The API base URL must not have a query string')

  const tools: ImportedTool[] = []
  const taken = new Set<string>()
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    const item = follow(doc, rawItem)
    if (!item || !path.startsWith('/')) continue
    for (const method of METHODS) {
      const operation = follow(doc, item[method])
      if (!operation) continue
      if (tools.length >= MAX_TOOLS) throw new SpecError(`The spec has more than ${MAX_TOOLS} operations`)

      const properties: Json = {}
      const required: string[] = []
      const params: ParamLocation[] = []
      // Operation-level parameters override path-level ones with the same name and location.
      const declared = new Map<string, Json>()
      for (const raw of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        const parameter = follow(doc, raw)
        if (parameter && typeof parameter.name === 'string') declared.set(`${parameter.in}:${parameter.name}`, parameter)
      }
      for (const parameter of declared.values()) {
        const name = parameter.name as string
        if ((parameter.in !== 'path' && parameter.in !== 'query') || name in properties) continue
        const schema = toJsonSchema(doc, parameter.schema ?? { type: 'string' })
        properties[name] = isObject(schema) && typeof parameter.description === 'string' && !schema.description
          ? { ...schema, description: parameter.description } : schema
        if (parameter.in === 'path' || parameter.required === true) required.push(name)
        params.push({ name, in: parameter.in })
      }
      const missing = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!).filter(name => !params.some(param => param.in === 'path' && param.name === name))
      for (const name of missing) {
        if (name in properties) continue
        properties[name] = { type: 'string' }
        required.push(name)
        params.push({ name, in: 'path' })
      }

      const body = follow(doc, operation.requestBody)
      if (body) {
        const content = isObject(body.content) ? body.content : {}
        const json = follow(doc, content['application/json'])
        // Operations that only take non-JSON bodies (uploads, forms) cannot be called by this adapter.
        if (!json && body.required === true) continue
        if (json && !('body' in properties)) {
          properties.body = toJsonSchema(doc, json.schema ?? { type: 'object' })
          if (body.required === true) required.push('body')
          params.push({ name: 'body', in: 'body' })
        }
      }

      let inputSchema: Json = { type: 'object', properties, ...(required.length ? { required } : {}) }
      if (JSON.stringify(inputSchema).length > MAX_SCHEMA_BYTES) {
        // Very large schemas cost too many tokens; keep the argument names and let the app validate.
        inputSchema = { type: 'object', properties: Object.fromEntries(Object.keys(properties).map(name => [name, {}])), ...(required.length ? { required } : {}) }
      }
      const summary = [operation.summary, operation.description].filter(value => typeof value === 'string' && value.trim()).join('. ')
      tools.push({
        name: toolName(operation.operationId, method, path, taken),
        description: (summary || `${method.toUpperCase()} ${path}`).slice(0, 1000),
        method: method.toUpperCase(),
        path,
        inputSchema,
        params,
      })
    }
  }
  if (!tools.length) throw new SpecError('The spec has no operations this adapter can call')
  const title = isObject(doc.info) && typeof doc.info.title === 'string' ? doc.info.title.trim().slice(0, 100) : ''
  return { title, baseUrl, tools }
}

export async function importSpec(specUrl: string, env: Env, baseOverride?: string): Promise<ImportedSpec> {
  let url: string
  try { url = trustedUrl(specUrl, env) } catch { throw new SpecError('The spec URL must be a public HTTPS URL') }
  let text: string
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json, application/yaml, text/yaml' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('Spec request failed')
    text = await readLimitedText(response, MAX_SPEC_BYTES)
  } catch { throw new SpecError('Could not fetch the spec, or it is larger than 2 MB') }
  return parseSpec(text, url, env, baseOverride)
}

export async function saveTools(connectionId: string, tools: ImportedTool[], env: Env) {
  await execute(env, 'DELETE FROM connection_tools WHERE connection_id = $1', [connectionId])
  for (const tool of tools) {
    await execute(env, 'INSERT INTO connection_tools (connection_id, tool_name, description, method, path, input_schema, params) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      connectionId, tool.name, tool.description, tool.method, tool.path, JSON.stringify(tool.inputSchema), JSON.stringify(tool.params),
    ])
  }
}

export function storedTools(connection: Connection, env: Env): Promise<StoredTool[]> {
  return rows<StoredTool>(env, 'SELECT * FROM connection_tools WHERE connection_id = $1 ORDER BY path, method', [connection.id])
}

/** How an API key is sent: a header name and an optional prefix such as "Bearer ". */
export function apiKeyHeader(header: unknown, prefix: unknown): { header: string; prefix: string } | null {
  const name = typeof header === 'string' && header.trim() ? header.trim() : 'Authorization'
  const lead = typeof prefix === 'string' ? prefix : name.toLowerCase() === 'authorization' ? 'Bearer ' : ''
  if (!/^[A-Za-z0-9-]{1,255}$/.test(name) || reservedHeaders.has(name.toLowerCase())) return null
  if (lead.length > 64 || !/^[\x20-\x7e]*$/.test(lead)) return null
  return { header: name, prefix: lead }
}

function credentialHeader(connection: Connection, token: string): [string, string] {
  if (connection.auth_kind === 'api_key') return [connection.auth_header || 'Authorization', `${connection.auth_prefix ?? ''}${token}`]
  return ['Authorization', `Bearer ${token}`]
}

function queryValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[] }
const failed = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

export async function callOperation(connection: Connection, tool: StoredTool, args: Record<string, unknown>, agent: Agent, env: Env): Promise<ToolResult> {
  const params = JSON.parse(tool.params) as ParamLocation[]
  const base = new URL(trustedUrl(connection.mcp_url, env))

  let invalid = ''
  const path = tool.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name]
    const segment = value === undefined || value === null || typeof value === 'object' ? '' : String(value)
    // "." and ".." survive percent-encoding and would let an argument reach a different endpoint.
    if (!segment || segment === '.' || segment === '..') invalid = name
    return encodeURIComponent(segment)
  })
  if (invalid) return failed(`Invalid value for path parameter "${invalid}"`)

  const url = new URL(base.pathname.replace(/\/$/, '') + path, base.origin)
  for (const param of params) {
    const value = args[param.name]
    if (param.in !== 'query' || value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(param.name, queryValue(item))
    else url.searchParams.set(param.name, queryValue(value))
  }
  if (url.origin !== base.origin) return failed('Request left the app origin')

  const token = await appToken(connection, env)
  const headers = new Headers({ Accept: 'application/json' })
  headers.set(...credentialHeader(connection, token))
  // The app can verify this to learn which agent acted; apps that ignore it still work.
  headers.set('Agent-Connect-Assertion', await agentAssertion(agent, connection, tool.tool_name, token, env))
  const hasBody = params.some(param => param.in === 'body') && args.body !== undefined
  if (hasBody) headers.set('Content-Type', 'application/json')

  const response = await fetch(url, {
    method: tool.method,
    headers,
    body: hasBody ? JSON.stringify(args.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status >= 300 && response.status < 400) return failed('The app answered with a redirect, which is not followed')

  let text = ''
  if (response.body) {
    try { text = await readLimitedText(response, MAX_RESPONSE_BYTES) }
    catch { return failed(`HTTP ${response.status}: the response is larger than ${MAX_RESPONSE_BYTES / 1000} KB. Narrow the request.`) }
  }
  if (!response.ok) return failed(`HTTP ${response.status}${text ? `: ${text.slice(0, 2000)}` : ''}`)
  return { content: [{ type: 'text', text: text || `HTTP ${response.status}` }] }
}
