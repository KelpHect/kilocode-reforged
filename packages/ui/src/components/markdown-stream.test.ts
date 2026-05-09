import { describe, expect, test } from "bun:test"
import { stream } from "./markdown-stream"

describe("markdown stream", () => {
  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([{ raw: "hello **world", src: "hello **world**", mode: "live" }])
    expect(stream("say `code", true)).toEqual([{ raw: "say `code", src: "say `code`", mode: "live" }])
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live" },
    ])
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "live" },
      { raw: "```ts\nconst x = 1", src: "```ts\nconst x = 1", mode: "live" },
    ])
  })

  test("keeps reference-style markdown as one block", () => {
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ])
  })

  test("peels a stable head when finished paragraphs precede a live paragraph", () => {
    // First paragraph is finalized (terminated by \n\n); second is being extended.
    // Head bytes ("First.\n\n") stay identical across deltas → cache hit on every
    // delta within the live paragraph.
    const result = stream("First.\n\nSecond paragraph being writ", true)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ raw: "First.\n\n", mode: "live" })
    expect(result[1]).toMatchObject({ mode: "live" })
    expect(result[1].raw).toContain("Second paragraph being writ")
  })

  test("peels a stable head with a heading followed by a live paragraph", () => {
    const result = stream("# Title\n\nBody being written", true)
    expect(result).toHaveLength(2)
    expect(result[0].raw).toBe("# Title\n\n")
    expect(result[1].raw).toContain("Body being written")
  })

  test("does not split when an active list is in the head (token boundary unstable)", () => {
    // Lists can absorb continuation lines into earlier tokens; the head is
    // not byte-stable so we keep the whole text as one block.
    const result = stream("- item one\n- item two\n\nFollow-up paragraph", true)
    expect(result).toHaveLength(1)
    expect(result[0].mode).toBe("live")
  })

  test("does not split when a table appears in the head", () => {
    const result = stream("| a | b |\n|---|---|\n| 1 | 2 |\n\nNext paragraph", true)
    expect(result).toHaveLength(1)
  })

  test("preserves the existing code-block-tail split", () => {
    // Regression: the unfinished trailing code fence path is preferred over
    // the new stable-head path when both could apply.
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "live" },
      { raw: "```ts\nconst x = 1", src: "```ts\nconst x = 1", mode: "live" },
    ])
  })
})
