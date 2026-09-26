import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"

type ToolDef = {
  name: string
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: string }>
}

type ContextHook = (event: { sessionID: string; system: Array<{ type: string; text: string }> }) => Promise<void> | void

type FakeEvent = { type: string; durable?: { aggregateID: string } }

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function fakeContext() {
  const tools = new Map<string, ToolDef>()
  const hooks = new Map<string, ContextHook>()
  const storage = new Map<string, unknown>()
  const sessions = new Set<string>()
  const events: FakeEvent[] = []
  let notify: (() => void) | undefined

  const editor = {
    add: (tool: ToolDef) => tools.set(tool.name, tool),
    update: () => {},
    remove: () => {},
    namespace: () => {},
    list: () => [],
    get: () => undefined,
  }

  const context = {
    tool: {
      transform: async (callback: (value: unknown) => void) => {
        callback(editor)
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name: string, callback: ContextHook) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
      get: async (input: { sessionID: string }) => {
        if (!sessions.has(input.sessionID)) throw new Error(`session ${input.sessionID} not found`)
        return { id: input.sessionID }
      },
    },
    event: {
      subscribe: async function* (options?: { signal?: AbortSignal }) {
        const signal = options?.signal
        while (!signal?.aborted) {
          const event = events.shift()
          if (event) {
            yield event
            continue
          }
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            notify = resolve
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          notify = undefined
        }
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
        const keys = [...storage.keys()].filter((key) => key.startsWith(prefix)).sort()
        const start = after ? keys.findIndex((key) => key > after) : 0
        const begin = Math.max(start, 0)
        const page = keys.slice(begin, begin + (limit ?? keys.length))
        const next = begin + page.length < keys.length ? page[page.length - 1] : undefined
        return { entries: page.map((key) => ({ key, value: storage.get(key) })), next }
      },
    },
  } as unknown as Plugin.Context

  return {
    context,
    tools,
    hooks,
    storage,
    sessions,
    emit: (event: FakeEvent) => {
      events.push(event)
      notify?.()
      notify = undefined
    },
  }
}

test("setup registers todowrite and todoread", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.context)
  assert.deepEqual([...fake.tools.keys()].sort(), ["todoread", "todowrite"])
})

test("todos are stored and read per session", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.context)

  const write = fake.tools.get("todowrite")!
  const written = await write.execute(
    { todos: [{ content: "A", status: "pending", priority: "high" }] },
    { sessionID: "ses_1" },
  )
  assert.match(written.content ?? "", /Todo list updated \(1 item\)/)

  const stored = fake.storage.get("todos/ses_1") as { todos: unknown[] }
  assert.deepEqual(stored, { todos: [{ content: "A", status: "pending", priority: "high" }] })

  const read = fake.tools.get("todoread")!
  const mine = await read.execute({}, { sessionID: "ses_1" })
  assert.match(mine.content ?? "", /1\. \[ \] A — high priority/)
  const other = await read.execute({}, { sessionID: "ses_2" })
  assert.match(other.content ?? "", /empty/)
})

test("context hook injects the open todo list into the system prompt", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.context)
  await fake.tools.get("todowrite")!.execute(
    { todos: [{ content: "Open task", status: "in_progress" }] },
    { sessionID: "ses_1" },
  )

  const event = { sessionID: "ses_1", system: [] as Array<{ type: string; text: string }> }
  await fake.hooks.get("context")!(event)

  assert.equal(event.system.length, 1)
  assert.match(event.system[0].text, /Open task/)
  assert.match(event.system[0].text, /todowrite/)
})

test("context hook stays quiet when nothing is open", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.context)
  await fake.tools.get("todowrite")!.execute(
    { todos: [{ content: "Done", status: "completed" }] },
    { sessionID: "ses_1" },
  )

  const finished = { sessionID: "ses_1", system: [] as Array<{ type: string; text: string }> }
  await fake.hooks.get("context")!(finished)
  assert.equal(finished.system.length, 0)

  const unknown = { sessionID: "ses_unknown", system: [] as Array<{ type: string; text: string }> }
  await fake.hooks.get("context")!(unknown)
  assert.equal(unknown.system.length, 0)
})

test("startup sweep removes todos for dead sessions", async () => {
  const fake = fakeContext()
  fake.storage.set("todos/ses_live", { todos: [{ content: "Live", status: "pending" }] })
  fake.storage.set("todos/ses_dead", { todos: [{ content: "Dead", status: "completed" }] })
  fake.storage.set("todos/", { todos: [] })
  fake.sessions.add("ses_live")

  await plugin.setup(fake.context)

  assert.ok(fake.storage.has("todos/ses_live"))
  assert.ok(!fake.storage.has("todos/ses_dead"))
  assert.ok(fake.storage.has("todos/"))
})

test("session.deleted events remove stored todos", async () => {
  const fake = fakeContext()
  fake.sessions.add("ses_1")
  await plugin.setup(fake.context)
  await fake.tools.get("todowrite")!.execute(
    { todos: [{ content: "Task", status: "pending" }] },
    { sessionID: "ses_1" },
  )
  assert.ok(fake.storage.has("todos/ses_1"))

  fake.emit({ type: "session.idle" })
  fake.emit({ type: "session.deleted" })
  fake.emit({ type: "session.deleted", durable: { aggregateID: "ses_1" } })

  await waitFor(() => !fake.storage.has("todos/ses_1"))
})
