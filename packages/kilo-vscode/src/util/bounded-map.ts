/**
 * Insertion-order-bounded Map / Set.
 *
 * Long-lived singletons (KiloConnectionService, KiloProvider) accumulate
 * per-session and per-message metadata Maps that depend on explicit
 * session/message deletion paths to evict. Any missed eviction path turns
 * into an 8-hour memory leak proportional to the SSE event rate
 * (~100 evt/s sustained).
 *
 * BoundedMap / BoundedSet add an upper bound: when the size exceeds `cap`,
 * the oldest entry (by insertion order) is dropped. JavaScript Map / Set
 * preserve insertion order so this is O(1) per overflow.
 *
 * The first overflow logs a single warning so a regression in eviction is
 * surfaced — quiet eviction would mask the underlying leak.
 *
 * NOT for use with listener Sets or anything where "the oldest entry"
 * carries semantic weight. This is purely a memory-pressure backstop.
 *
 * Both classes extend the native Map / Set so they're drop-in compatible
 * with any consumer that types its parameter as `Map<K,V>` / `Set<T>`.
 */

export interface BoundedMapOptions {
  cap: number
  /** Identifier surfaced in the overflow warning; aids debugging. */
  name?: string
  onWarn?: (msg: string) => void
}

const defaultWarn = (msg: string): void => {
  console.warn(`[Kilo New] ${msg}`)
}

export class BoundedMap<K, V> extends Map<K, V> {
  private readonly cap: number
  private readonly name: string
  private readonly onWarn: (msg: string) => void
  private warned = false
  private evictHook: ((key: K, value: V) => void) | undefined

  constructor(opts: BoundedMapOptions) {
    super()
    this.cap = opts.cap
    this.name = opts.name ?? "BoundedMap"
    this.onWarn = opts.onWarn ?? defaultWarn
  }

  /** Optional eviction observer — fires for each entry removed by the cap. */
  onEvict(fn: (key: K, value: V) => void): void {
    this.evictHook = fn
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.set(key, value)
      return this
    }
    super.set(key, value)
    if (super.size > this.cap) {
      this.evictOldest()
    }
    return this
  }

  private evictOldest(): void {
    if (!this.warned) {
      this.warned = true
      this.onWarn(
        `${this.name}: cap ${this.cap} exceeded — oldest entry dropped. This usually indicates a missed cleanup path.`,
      )
    }
    const first = super.keys().next()
    if (first.done) return
    const key = first.value
    const value = super.get(key) as V
    super.delete(key)
    this.evictHook?.(key, value)
  }
}

export interface BoundedSetOptions {
  cap: number
  name?: string
  onWarn?: (msg: string) => void
}

export class BoundedSet<T> extends Set<T> {
  private readonly cap: number
  private readonly name: string
  private readonly onWarn: (msg: string) => void
  private warned = false

  constructor(opts: BoundedSetOptions) {
    super()
    this.cap = opts.cap
    this.name = opts.name ?? "BoundedSet"
    this.onWarn = opts.onWarn ?? defaultWarn
  }

  override add(value: T): this {
    if (super.has(value)) return this
    super.add(value)
    if (super.size > this.cap) {
      this.evictOldest()
    }
    return this
  }

  private evictOldest(): void {
    if (!this.warned) {
      this.warned = true
      this.onWarn(
        `${this.name}: cap ${this.cap} exceeded — oldest entry dropped. This usually indicates a missed cleanup path.`,
      )
    }
    const first = super.values().next()
    if (first.done) return
    super.delete(first.value)
  }
}
