// A "legacy" Tasks API for local end-to-end testing of Agent Connect's OpenAPI adapter.
// It is a plain REST service with an API key and an OpenAPI spec: no MCP server,
// no OAuth, and no Agent Connect SDK. Everything is in memory.
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const port = Number(process.env.PORT ?? 4100)
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`
// Demo credential for this in-memory example only.
const apiKey = process.env.LEGACY_API_KEY ?? 'legacy-demo-key'

type Task = { id: number; title: string; done: boolean }
const tasks: Task[] = [{ id: 1, title: 'Migrate the billing cron', done: false }]
let nextId = 2
// What the gateway sent, so the e2e script can check it.
const seen = { apiKeyCalls: 0, assertions: 0 }

const taskSchema = {
  type: 'object',
  required: ['id', 'title', 'done'],
  properties: { id: { type: 'integer' }, title: { type: 'string' }, done: { type: 'boolean' } },
}

const spec = {
  openapi: '3.0.3',
  info: { title: 'Legacy Tasks', version: '1.0.0' },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    schemas: {
      Task: taskSchema,
      NewTask: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } },
      TaskPatch: { type: 'object', properties: { title: { type: 'string' }, done: { type: 'boolean', nullable: true } } },
    },
    parameters: { TaskId: { name: 'id', in: 'path', required: true, schema: { type: 'integer' } } },
  },
  security: [{ apiKey: [] }],
  paths: {
    '/tasks': {
      get: {
        operationId: 'listTasks',
        summary: 'List tasks',
        parameters: [{ name: 'done', in: 'query', description: 'Only tasks with this status', schema: { type: 'boolean' } }],
        responses: { 200: { description: 'Tasks', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } } },
      },
      post: {
        operationId: 'createTask',
        summary: 'Create a task',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewTask' } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/tasks/{id}': {
      parameters: [{ $ref: '#/components/parameters/TaskId' }],
      get: { operationId: 'getTask', summary: 'Get one task', responses: { 200: { description: 'Task' } } },
      patch: {
        operationId: 'updateTask',
        summary: 'Rename a task or mark it done',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskPatch' } } } },
        responses: { 200: { description: 'Updated' } },
      },
      delete: { operationId: 'deleteTask', summary: 'Delete a task', responses: { 204: { description: 'Deleted' } } },
    },
  },
}

const app = new Hono()

app.get('/openapi.json', c => c.json(spec))
app.get('/debug/state', c => c.json({ tasks, seen }))

app.use('/api/*', async (c, next) => {
  if (c.req.header('X-API-Key') !== apiKey) return c.json({ error: 'Invalid API key' }, 401)
  seen.apiKeyCalls++
  if (c.req.header('Agent-Connect-Assertion')) seen.assertions++
  await next()
})

app.get('/api/tasks', c => {
  const done = c.req.query('done')
  return c.json(done === undefined ? tasks : tasks.filter(task => String(task.done) === done))
})

app.post('/api/tasks', async c => {
  const body = await c.req.json().catch(() => null) as { title?: unknown } | null
  if (typeof body?.title !== 'string' || !body.title.trim()) return c.json({ error: 'title is required' }, 400)
  const task = { id: nextId++, title: body.title.trim().slice(0, 200), done: false }
  tasks.push(task)
  return c.json(task, 201)
})

app.get('/api/tasks/:id', c => {
  const task = tasks.find(item => item.id === Number(c.req.param('id')))
  return task ? c.json(task) : c.json({ error: 'Task not found' }, 404)
})

app.patch('/api/tasks/:id', async c => {
  const task = tasks.find(item => item.id === Number(c.req.param('id')))
  if (!task) return c.json({ error: 'Task not found' }, 404)
  const body = await c.req.json().catch(() => null) as { title?: unknown; done?: unknown } | null
  if (typeof body?.title === 'string' && body.title.trim()) task.title = body.title.trim().slice(0, 200)
  if (typeof body?.done === 'boolean') task.done = body.done
  return c.json(task)
})

app.delete('/api/tasks/:id', c => {
  const index = tasks.findIndex(item => item.id === Number(c.req.param('id')))
  if (index < 0) return c.json({ error: 'Task not found' }, 404)
  tasks.splice(index, 1)
  return c.body(null, 204)
})

serve({ fetch: app.fetch, port }, () => console.log(`Legacy Tasks API on ${origin} (spec ${origin}/openapi.json)`))
