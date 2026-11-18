// Connect an app that has a REST API but no MCP server: fetch its OpenAPI 3.x spec
// and convert each operation to a tool. The REST calls themselves are in `restApp.ts`.
import { parse as parseYaml } from 'yaml'
import { MAX_OPENAPI_TOOLS, MAX_SCHEMA_BYTES, MAX_SPEC_BYTES, SPEC_FETCH_TIMEOUT_MS } from '../constants'
import type { Env } from '../types/env'
import type { ImportedSpec, ImportedTool, JsonObject, ParamLocation } from '../types/tools'
import { readLimitedText } from '../utils/http'
import { trustedUrl } from '../utils/urls'

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/** A problem with the spec that the user can fix. The message is shown in the control plane. */
export class SpecError extends Error {}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

function pointer(root: JsonObject, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new SpecError('Only references inside the same document are supported')
  let node: unknown = root
  for (const part of ref.slice(2).split('/')) {
    if (!isObject(node)) return undefined
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return node
}

/** Follow a top-level `$ref` (parameters, request bodies) without expanding the node's children. */
function follow(root: JsonObject, node: unknown): JsonObject | null {
  for (let hops = 0; hops < 8 && isObject(node); hops++) {
    if (typeof node.$ref !== 'string') return node
    node = pointer(root, node.$ref)
  }
  return null
}

/** Inline `$ref`s and drop OpenAPI-only keywords so the result is plain JSON Schema. Cycles become `{}`. */
function toJsonSchema(root: JsonObject, node: unknown, depth = 0, active = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map(item => toJsonSchema(root, item, depth + 1, active))
  if (!isObject(node)) return node
  if (depth > 12) return {}
  if (typeof node.$ref === 'string') {
    if (active.has(node.$ref)) return {}
    const next = new Set(active).add(node.$ref)
    return toJsonSchema(root, pointer(root, node.$ref) ?? {}, depth + 1, next)
  }
  const output: JsonObject = {}
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

/** `operationId` in snake_case, or `<method>_<path>` when there is none. Duplicates get a numeric suffix. */
function toolName(operationId: unknown, method: string, path: string, taken: Set<string>): string {
  const source = typeof operationId === 'string' && operationId.trim() ? operationId : `${method}_${path}`
  const base = source.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'operation'
  let name = base
  for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`
  taken.add(name)
  return name
}

function serverUrl(doc: JsonObject, specUrl: string): string {
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

/**
 * Convert spec text (JSON or YAML) to tools. Each tool takes the operation's path and query
 * parameters as top-level arguments and its JSON request body as `body`.
 * Header and cookie parameters are ignored; operations that only take non-JSON bodies are skipped.
 */
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
      if (tools.length >= MAX_OPENAPI_TOOLS) throw new SpecError(`The spec has more than ${MAX_OPENAPI_TOOLS} operations`)

      const properties: JsonObject = {}
      const required: string[] = []
      const params: ParamLocation[] = []
      // Operation-level parameters override path-level ones with the same name and location.
      const declared = new Map<string, JsonObject>()
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
        if (!json && (body.required === true || Object.keys(content).length)) continue
        if (json && !('body' in properties)) {
          properties.body = toJsonSchema(doc, json.schema ?? { type: 'object' })
          if (body.required === true) required.push('body')
          params.push({ name: 'body', in: 'body' })
        }
      }

      let inputSchema: JsonObject = { type: 'object', properties, ...(required.length ? { required } : {}) }
      if (JSON.stringify(inputSchema).length > MAX_SCHEMA_BYTES) {
        // Very large schemas cost too many tokens; keep the argument names and let the app validate.
        inputSchema = { type: 'object', properties: Object.fromEntries(Object.keys(properties).map(name => [name, {}])), ...(required.length ? { required } : {}) }
      }
      const summary = [operation.summary, operation.description]
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map((value, index, all) => index < all.length - 1 ? value.trim().replace(/\.$/, '') : value.trim())
        .join('. ')
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

/** Fetch the spec and convert it. `baseOverride` replaces the spec's server URL. */
export async function importSpec(specUrl: string, env: Env, baseOverride?: string): Promise<ImportedSpec> {
  let url: string
  try { url = trustedUrl(specUrl, env) } catch { throw new SpecError('The spec URL must be a public HTTPS URL') }
  let text: string
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json, application/yaml, text/yaml' }, redirect: 'manual', signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error('Spec request failed')
    text = await readLimitedText(response, MAX_SPEC_BYTES)
  } catch (error) {
    console.warn('Spec fetch failed:', error instanceof Error ? error.name : error)
    throw new SpecError('Could not fetch the spec within 30 seconds, or it is larger than 2 MB')
  }
  return parseSpec(text, url, env, baseOverride)
}
