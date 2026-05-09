/** @jsxImportSource solid-js */

/**
 * MessageVirtualizer
 *
 * Thin Solid adapter around `@tanstack/solid-virtual`'s `createVirtualizer`
 * that mirrors the prop surface of `virtua`'s `<Virtualizer>`. The goal is a
 * mechanical swap at the call site (MessageList) without leaking TanStack
 * specifics into the rest of the chat UI. If we need to A/B between
 * implementations, this is the only seam.
 *
 * Behaviour parity notes vs. virtua:
 *  - `itemSize` is the *estimate*; real heights are measured on mount via
 *    `measureElement`. Skipped on Firefox to avoid a known
 *    `ResizeObserverEntry` boxSize quirk that mis-measures wrapped lines.
 *  - `shift` mirrors virtua's prepend-anchor behavior. When data grows and
 *    `shift` is true, we snapshot the scroll container's `scrollHeight`
 *    before the TanStack adapter's internal createComputed flushes the new
 *    totalSize to the DOM, then bump `scrollTop` by the delta after the
 *    microtask completes. The user's view stays pinned on the same message
 *    while older entries appear above.
 *  - Iterates over a memoized slice of `data` rather than the virtualizer's
 *    item store, and keys `<For>` by item reference. This matches virtua's
 *    behavior: when data prepends and `stableMessageTurns` preserves
 *    existing turn references, those rows are reused (no remount). The
 *    children render fn is invoked once per row inside `untrack`, so the
 *    consumer's JSX (e.g. `<VscodeSessionTurn turn={turn} />`) is built a
 *    single time and reactive prop updates flow through the existing Solid
 *    store, not through component remounts.
 *  - `overscan` defaults to 12 (vs. virtua's 6 in the previous config),
 *    chosen to cover roughly two viewports at the 260px estimate so fast
 *    scroll doesn't outrun the renderer.
 */

import { type JSX, For, createEffect, createMemo, on, onMount, untrack } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { mark, measure } from "../../utils/perf"

export interface MessageVirtualizerProps<T> {
  /** Items to virtualize. */
  data: T[]
  /** Scroll container — the element with `overflow: auto` that owns scrollTop. */
  scrollRef: HTMLElement | undefined
  /**
   * When data length grows and `shift` is true, anchor the scroll position
   * so currently-visible items don't jump (e.g. when older messages prepend).
   */
  shift?: boolean
  /** Pre-render overscan in items, default 12. */
  overscan?: number
  /** Initial size estimate per item in pixels. */
  itemSize?: number
  /**
   * Stable identity per item, used as the virtualizer's key extractor. When
   * omitted the item index is used, which is fine for append-only lists but
   * causes incorrect prepend behavior — the chat list passes the user
   * message id.
   */
  getItemKey?: (index: number, item: T) => string | number
  /**
   * Render fn. Invoked once per row (not on every reactive tick). `index()`
   * is reactive so consumers can derive memoized values like "is this turn
   * queued?" without remounting the row.
   */
  children: (item: T, index: () => number) => JSX.Element
}

const isFirefox =
  typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("firefox")

export function MessageVirtualizer<T>(props: MessageVirtualizerProps<T>): JSX.Element {
  // First-paint perf marker: the start mark fires synchronously during
  // component construction; the matching measure fires from a one-shot rAF
  // scheduled inside onMount, after the browser has painted the initial
  // virtualizer output. Disabled by default; toggle KILO_PERF to enable.
  mark("MessageVirtualizer.firstPaint")
  onMount(() => {
    requestAnimationFrame(() => {
      measure("MessageVirtualizer.firstPaint", "MessageVirtualizer.firstPaint", {
        count: props.data.length,
      })
    })
  })

  // Prepend-anchor: when data grows while `shift` is true, the new items push
  // existing rows down. Without compensation, scrollTop stays constant and
  // the user suddenly sees different content. We snapshot scrollHeight HERE,
  // before the TanStack Solid adapter's internal createComputed (registered
  // by `createVirtualizer` below) reads `props.data` via mergeProps and
  // updates the totalSize. Solid fires effect subscribers in registration
  // order within a batch, so this effect *must* be registered before
  // createVirtualizer for the snapshot to capture pre-mutation height.
  // The adjustment runs in a microtask, after Solid finishes flushing the
  // batch (including the new totalSize style on the wrapper div).
  createEffect(
    on(
      () => props.data.length,
      (nextLen, prevLen) => {
        if (prevLen === undefined || nextLen <= prevLen) return
        if (!props.shift) return
        const el = props.scrollRef
        if (!el) return
        const prevScrollHeight = el.scrollHeight
        queueMicrotask(() => {
          const cur = props.scrollRef
          if (!cur) return
          const delta = cur.scrollHeight - prevScrollHeight
          if (delta > 0) cur.scrollTop += delta
        })
      },
      { defer: true },
    ),
  )

  // Property getters keep these reactive: the TanStack Solid adapter calls
  // setOptions inside a createComputed, which tracks gets through mergeProps.
  const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
    get count() {
      return props.data.length
    },
    getScrollElement: () => props.scrollRef ?? null,
    estimateSize: () => props.itemSize ?? 260,
    get overscan() {
      return props.overscan ?? 12
    },
    measureElement: isFirefox
      ? undefined
      : (element) => element?.getBoundingClientRect().height ?? 0,
    getItemKey: (index) => {
      const fn = props.getItemKey
      const item = props.data[index]
      if (fn && item !== undefined) return fn(index, item)
      return index
    },
  })

  // Window described by the virtualizer: which absolute indices are mounted
  // and where each one is positioned. We iterate over the data slice within
  // this window so `<For>`'s identity-keyed diff reuses rows when items
  // shift indices on prepend (assuming the consumer hands us a `data` array
  // that preserves item references across updates, which `stableMessageTurns`
  // already does).
  //
  // The previous implementation built a `Map<index, start>` per scroll tick;
  // since the visible window is small (12-15 items) and items already carry
  // `.start`, we now read offsets directly off the items array — no Map
  // allocation per scroll event.
  const items = createMemo(() => virtualizer.getVirtualItems())
  const window = createMemo(() => {
    const list = items()
    if (list.length === 0) return { start: -1, end: -1 }
    return { start: list[0]!.index, end: list[list.length - 1]!.index }
  })

  const visibleData = createMemo(() => {
    const w = window()
    if (w.start < 0) return [] as T[]
    return props.data.slice(w.start, w.end + 1)
  })

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      <For each={visibleData()}>
        {(item, indexInWindow) => {
          // Absolute index in the underlying data array. Recomputed when the
          // window shifts (scroll) or when items prepend (window.start moves).
          const absoluteIndex = createMemo(() => window().start + indexInWindow())
          const offset = createMemo(() => items()[indexInWindow()]?.start ?? 0)

          // children is invoked exactly once per row. The consumer's JSX
          // therefore mounts one component per row; reactive prop bindings
          // ((index) => ..., or memos derived from data) propagate through
          // Solid's normal reactive system rather than via remount.
          const childContent = createMemo(() => untrack(() => props.children(item, absoluteIndex)))

          return (
            <div
              ref={(el) => virtualizer.measureElement(el)}
              data-index={absoluteIndex()}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${offset()}px)`,
              }}
            >
              {childContent()}
            </div>
          )
        }}
      </For>
    </div>
  )
}
