import type { Plugin } from "@opencode/plugin"
import {
  MAX_CONTENT_LENGTH,
  MAX_TODOS,
  STORAGE_PREFIX,
  TODO_PRIORITIES,
  TODO_STATUSES,
  hasOpenTodos,
  normalizeTodos,
  parseTodoRecord,
  renderTodos,
  sessionIDFromKey,
  storageKey,
} from "./todos.js"

export * from "./todos.js"

const TODOS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The complete todo list. This replaces any previous list.",
      items: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Imperative description of the task.",
          },
          status: {
            type: "string",
            enum: [...TODO_STATUSES],
            description: "Current state of the task.",
          },
          priority: {
            type: "string",
            enum: [...TODO_PRIORITIES],
            description: "Optional priority of the task.",
          },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
}

const TODO_READ_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

const TODOWRITE_DESCRIPTION = [
  "Create or replace the session todo list.",
  "Pass the complete list every time; it replaces any previous one.",
  "Use it to plan multi-step work and keep status current: keep exactly one task in_progress while working on it,",
  "mark tasks completed as soon as they are done, and cancel tasks that are no longer needed.",
  "Prefer short, imperative task descriptions.",
  `Maximum ${MAX_TODOS} items, ${MAX_CONTENT_LENGTH} characters per description.`,
].join(" ")

const TODOREAD_DESCRIPTION =
  "Read the current session todo list. Use it to recover the list after context compaction or to check progress before starting the next task."

const plugin: Plugin.Plugin = {
  id: "aiev.todolist",

  async setup(ctx: Plugin.Context) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "todowrite",
        description: TODOWRITE_DESCRIPTION,
        input: TODOS_INPUT_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => {
          const todos = normalizeTodos(input)
          await ctx.storage.set(storageKey(context.sessionID), { todos })
          return {
            content: `Todo list updated (${todos.length} ${todos.length === 1 ? "item" : "items"}):\n${renderTodos(todos)}`,
          }
        },
      })

      editor.add({
        name: "todoread",
        description: TODOREAD_DESCRIPTION,
        input: TODO_READ_INPUT_SCHEMA,
        options: { codemode: false },
        execute: async (_input, context) => {
          const record = parseTodoRecord(await ctx.storage.get(storageKey(context.sessionID)))
          const todos = record?.todos ?? []
          return { content: `Current todo list:\n${renderTodos(todos)}` }
        },
      })
    })

    const context = await ctx.session.hook("context", async (event) => {
      const record = parseTodoRecord(await ctx.storage.get(storageKey(event.sessionID)))
      const todos = record?.todos ?? []
      if (!hasOpenTodos(todos)) return
      event.system.push({
        type: "text",
        text: [
          "Current todo list for this session:",
          renderTodos(todos),
          "",
          "Keep it current with the todowrite tool as work progresses.",
        ].join("\n"),
      })
    })

    try {
      let cursor: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: STORAGE_PREFIX, after: cursor, limit: 100 })
        for (const entry of page.entries) {
          const sessionID = sessionIDFromKey(entry.key)
          if (!sessionID) continue
          try {
            if (await ctx.session.get({ sessionID })) continue
          } catch {
            // the session is gone; fall through to removal
          }
          try {
            await ctx.storage.remove(entry.key)
          } catch (error) {
            console.warn("todolist: failed to remove stale todos", error)
          }
        }
        cursor = page.next
      } while (cursor)
    } catch (error) {
      console.warn("todolist: startup todo sweep failed", error)
    }

    const controller = new AbortController()
    const events = ctx.event.subscribe({ signal: controller.signal })
    const listener = (async () => {
      for await (const event of events) {
        if (controller.signal.aborted) break
        if (event?.type !== "session.deleted") continue
        const sessionID = event.durable?.aggregateID
        if (typeof sessionID !== "string") continue
        try {
          await ctx.storage.remove(storageKey(sessionID))
        } catch (error) {
          console.warn("todolist: failed to remove todos for deleted session", error)
        }
      }
    })()

    return async () => {
      controller.abort()
      await listener
      await context.dispose()
      await tools.dispose()
    }
  },
}

export default plugin
