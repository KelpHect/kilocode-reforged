import { describe, expect, it } from "bun:test"
import { PostMessageBatcher } from "../../src/kilo-provider/post-message-batcher"

interface RecordedTarget {
  posts: unknown[]
  postMessage: (msg: unknown) => void
}

function makeTarget(): RecordedTarget {
  const posts: unknown[] = []
  return {
    posts,
    postMessage(msg) {
      posts.push(msg)
    },
  }
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve()
}

describe("PostMessageBatcher", () => {
  it("sends a single enqueue as a plain message (no batch envelope)", async () => {
    const target = makeTarget()
    const b = new PostMessageBatcher({ getTarget: () => target })
    b.enqueue({ type: "a" })
    await nextMicrotask()
    expect(target.posts.length).toBe(1)
    expect(target.posts[0]).toEqual({ type: "a" })
  })

  it("coalesces multiple enqueues in one tick into a single extensionBatch", async () => {
    const target = makeTarget()
    const b = new PostMessageBatcher({ getTarget: () => target })
    b.enqueue({ type: "a" })
    b.enqueue({ type: "b" })
    b.enqueue({ type: "c" })
    await nextMicrotask()
    expect(target.posts.length).toBe(1)
    expect(target.posts[0]).toEqual({
      type: "extensionBatch",
      events: [{ type: "a" }, { type: "b" }, { type: "c" }],
    })
  })

  it("preserves order across batches", async () => {
    const target = makeTarget()
    const b = new PostMessageBatcher({ getTarget: () => target })
    b.enqueue({ type: "a" })
    b.enqueue({ type: "b" })
    await nextMicrotask()
    b.enqueue({ type: "c" })
    await nextMicrotask()
    // First batch: 2 messages → extensionBatch envelope
    // Second batch: 1 message → plain
    expect(target.posts.length).toBe(2)
    expect(target.posts[0]).toEqual({
      type: "extensionBatch",
      events: [{ type: "a" }, { type: "b" }],
    })
    expect(target.posts[1]).toEqual({ type: "c" })
  })

  it("synchronous flush() drains immediately", () => {
    const target = makeTarget()
    const b = new PostMessageBatcher({ getTarget: () => target })
    b.enqueue({ type: "a" })
    b.enqueue({ type: "b" })
    b.flush() // sync — no need to await
    expect(target.posts.length).toBe(1)
    expect(target.posts[0]).toEqual({
      type: "extensionBatch",
      events: [{ type: "a" }, { type: "b" }],
    })
  })

  it("drops messages when target is unavailable, with a console warning", async () => {
    const target = makeTarget()
    let attached: RecordedTarget | undefined = undefined
    const b = new PostMessageBatcher({ getTarget: () => attached })
    b.enqueue({ type: "a" }) // no target → drop + warn
    await nextMicrotask()
    expect(target.posts.length).toBe(0)

    attached = target
    b.enqueue({ type: "b" })
    await nextMicrotask()
    expect(target.posts.length).toBe(1)
    expect(target.posts[0]).toEqual({ type: "b" })
  })

  it("flush() is a no-op when nothing is queued", () => {
    const target = makeTarget()
    const b = new PostMessageBatcher({ getTarget: () => target })
    b.flush()
    expect(target.posts.length).toBe(0)
  })

  it("handles a target whose postMessage returns a rejecting Thenable without throwing", async () => {
    const errors: unknown[] = []
    // Patch console.error for this test only
    const orig = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const target = {
        postMessage: () => Promise.reject(new Error("boom")),
      }
      const b = new PostMessageBatcher({ getTarget: () => target, name: "Test" })
      b.enqueue({ type: "a" })
      await nextMicrotask()
      // Allow the promise rejection to surface
      await new Promise((r) => setTimeout(r, 5))
      expect(errors.length).toBeGreaterThan(0)
    } finally {
      console.error = orig
    }
  })
})
