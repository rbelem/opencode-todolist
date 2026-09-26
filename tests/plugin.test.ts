import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"

type ToolDef = {
  name: string
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: string }>
}

type ContextHook = (event: { sessionID: string; system: Array<{ type: string; text: string }> }) => Promise<void> | void

type FakeEvent = { type: string; data?: { sessionID: string }; durable?: { aggregateID: string } }

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
  const failingLookups = new Set<string>()
  const events: FakeEvent[] = []
  const disposals = { tools: 0, context: 0 }
  let streamShouldThrow = false
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
        return { dispose: async () => { disposals.tools++ } }
      },
    },
    session: {
      hook: async (name: string, callback: ContextHook) => {
        hooks.set(name, callback)
        return { dispose: async () => { disposals.context++ } }
      },
      get: async (input: { sessionID: string }) => {
        if (failingLookups.has(input.sessionID)) throw new Error(`session ${input.sessionID} lookup failed`)
        if (!sessions.has(input.sessionID)) return undefined
        return { id: input.sessionID }
      },
    },
    event: {
      subscribe: async function* (options?: { signal?: AbortSignal }) {
        const signal = options?.signal
        while (!signal?.aborted) {
          if (streamShouldThrow) throw new Error("event stream failed")
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
    disposals,
    emit: (event: FakeEvent) => {
      events.push(event)
      notify?.()
      notify = undefined
    },
    failLookup: (sessionID: string) => failingLookups.add(sessionID),
    failEventStream: () => {
      streamShouldThrow = true
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

test("startup sweep keeps records when session lookup fails", async () => {
  const fake = fakeContext()
  fake.storage.set("todos/ses_broken", { todos: [{ content: "Broken", status: "pending" }] })
  fake.sessions.add("ses_broken")
  fake.failLookup("ses_broken")

  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    await plugin.setup(fake.context)
  } finally {
    console.warn = originalWarn
  }

  assert.ok(fake.storage.has("todos/ses_broken"))
  assert.ok(warnings.some((args) => args[0] === "todolist: session lookup failed for"))
})

test("startup sweep removes stale todos across multiple pages", async () => {
  const fake = fakeContext()
  const pad = (i: number) => String(i).padStart(3, "0")
  for (let i = 0; i < 120; i++) {
    fake.storage.set(`todos/ses_stale_${pad(i)}`, { todos: [{ content: `Stale ${i}`, status: "completed" }] })
  }
  for (let i = 0; i < 30; i++) {
    fake.storage.set(`todos/ses_live_${pad(i)}`, { todos: [{ content: `Live ${i}`, status: "pending" }] })
    fake.sessions.add(`ses_live_${pad(i)}`)
  }

  await plugin.setup(fake.context)

  const staleLeft = [...fake.storage.keys()].filter((key) => key.startsWith("todos/ses_stale_"))
  const liveLeft = [...fake.storage.keys()].filter((key) => key.startsWith("todos/ses_live_"))
  assert.equal(staleLeft.length, 0)
  assert.equal(liveLeft.length, 30)
})

test("event stream failure warns and teardown still disposes", async () => {
  const fake = fakeContext()
  const teardown = await plugin.setup(fake.context)

  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    fake.failEventStream()
    await waitFor(() => warnings.some((args) => args[0] === "todolist: event subscription ended"))
    if (typeof teardown === "function") await teardown()
    // Give any unhandled rejection a chance to surface before asserting.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    console.warn = originalWarn
    process.off("unhandledRejection", onUnhandled)
  }

  assert.equal(fake.disposals.context, 1)
  assert.equal(fake.disposals.tools, 1)
  assert.equal(unhandled.length, 0)
})

test("session.deleted honors event.data.sessionID", async () => {
  const fake = fakeContext()
  await plugin.setup(fake.context)
  await fake.tools.get("todowrite")!.execute(
    { todos: [{ content: "Task", status: "pending" }] },
    { sessionID: "ses_2" },
  )
  assert.ok(fake.storage.has("todos/ses_2"))

  fake.emit({ type: "session.deleted", data: { sessionID: "ses_2" } })
  await waitFor(() => !fake.storage.has("todos/ses_2"))
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
