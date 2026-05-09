import { describe, expect, it } from "bun:test"
import { BoundedMap, BoundedSet } from "../../src/util/bounded-map"

describe("BoundedMap", () => {
  it("behaves like a Map under the cap", () => {
    const m = new BoundedMap<string, number>({ cap: 3 })
    m.set("a", 1)
    m.set("b", 2)
    expect(m.size).toBe(2)
    expect(m.get("a")).toBe(1)
    expect(m.has("b")).toBe(true)
  })

  it("evicts oldest entry on overflow (insertion-order)", () => {
    const m = new BoundedMap<string, number>({ cap: 3, onWarn: () => {} })
    m.set("a", 1)
    m.set("b", 2)
    m.set("c", 3)
    m.set("d", 4) // overflow → drop oldest "a"
    expect(m.size).toBe(3)
    expect(m.has("a")).toBe(false)
    expect(m.has("b")).toBe(true)
    expect(m.has("c")).toBe(true)
    expect(m.has("d")).toBe(true)
  })

  it("does not evict on update of existing key", () => {
    const m = new BoundedMap<string, number>({ cap: 3, onWarn: () => {} })
    m.set("a", 1)
    m.set("b", 2)
    m.set("c", 3)
    m.set("a", 100) // update — no overflow, no eviction
    expect(m.size).toBe(3)
    expect(m.get("a")).toBe(100)
    expect(m.has("b")).toBe(true)
  })

  it("warns once per instance on first overflow", () => {
    const warns: string[] = []
    const m = new BoundedMap<string, number>({ cap: 1, onWarn: (s) => warns.push(s) })
    m.set("a", 1)
    m.set("b", 2)
    m.set("c", 3)
    m.set("d", 4)
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain("cap 1 exceeded")
  })

  it("invokes evict hook with key+value when entry is dropped", () => {
    const dropped: Array<[string, number]> = []
    const m = new BoundedMap<string, number>({ cap: 2, onWarn: () => {} })
    m.onEvict((k, v) => dropped.push([k, v]))
    m.set("a", 1)
    m.set("b", 2)
    m.set("c", 3) // drops "a"
    m.set("d", 4) // drops "b"
    expect(dropped).toEqual([
      ["a", 1],
      ["b", 2],
    ])
  })

  it("is structurally a Map (instanceof and iteration)", () => {
    const m = new BoundedMap<string, number>({ cap: 10 })
    m.set("a", 1)
    m.set("b", 2)
    expect(m instanceof Map).toBe(true)
    expect([...m.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ])
    expect([...m.keys()]).toEqual(["a", "b"])
    expect([...m.values()]).toEqual([1, 2])
  })
})

describe("BoundedSet", () => {
  it("evicts oldest entry on overflow", () => {
    const s = new BoundedSet<string>({ cap: 3, onWarn: () => {} })
    s.add("a")
    s.add("b")
    s.add("c")
    s.add("d") // drops "a"
    expect(s.size).toBe(3)
    expect(s.has("a")).toBe(false)
    expect(s.has("d")).toBe(true)
  })

  it("re-adding an existing value does not trigger eviction", () => {
    const s = new BoundedSet<string>({ cap: 3, onWarn: () => {} })
    s.add("a")
    s.add("b")
    s.add("c")
    s.add("a") // re-add — no growth, no eviction
    expect(s.size).toBe(3)
    expect(s.has("a")).toBe(true)
    expect(s.has("b")).toBe(true)
    expect(s.has("c")).toBe(true)
  })

  it("is structurally a Set (instanceof)", () => {
    const s = new BoundedSet<string>({ cap: 10 })
    s.add("a")
    expect(s instanceof Set).toBe(true)
    expect([...s]).toEqual(["a"])
  })
})
