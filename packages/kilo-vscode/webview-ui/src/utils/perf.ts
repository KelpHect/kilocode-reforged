/**
 * Lightweight perf instrumentation for the webview.
 *
 * Disabled by default (zero cost — every call short-circuits on a single
 * boolean check). Enable from the Webview DevTools console with
 *
 *   globalThis.KILO_PERF = true     // warn on slow operations
 *   globalThis.KILO_PERF = "verbose" // log every measure
 *   globalThis.KILO_PERF = false    // back off
 *
 * Reload the page to pick up the change (the flag is read on every call,
 * so technically toggling at runtime works too; reload just resets the
 * mark map cleanly).
 *
 * Logs go to the console — there's intentionally no telemetry pipeline.
 * This is a developer aid, not a product feature; if you find yourself
 * reaching for a metrics backend, the right move is a real perf-budget
 * harness, not threading data out of the webview.
 *
 * Currently instrumented:
 *   - handlePartUpdated (session.tsx)
 *   - handleMessagesLoaded setStore (session.tsx)
 *   - sessionFamily BFS (session.tsx)
 *   - MessageList virtualizer first paint (MessageList.tsx)
 *
 * To add a new site, prefer `timed()` for synchronous blocks. Reach for
 * `mark()` / `measure()` only when start and end live in different scopes.
 */

const SLOW_THRESHOLD_MS = 16

type Mode = boolean | "verbose"

function readFlag(): Mode {
  const raw = (globalThis as { KILO_PERF?: unknown }).KILO_PERF
  if (raw === "verbose") return "verbose"
  return Boolean(raw)
}

const marks = new Map<string, number>()

export function mark(name: string): void {
  if (!readFlag()) return
  marks.set(name, performance.now())
}

export function measure(name: string, startMark: string, tags?: Record<string, string | number>): void {
  const mode = readFlag()
  if (!mode) return
  const start = marks.get(startMark)
  if (start === undefined) return
  const duration = performance.now() - start
  marks.delete(startMark)
  report(mode, name, duration, tags)
}

/**
 * Time a synchronous function. Returns its result. The fn is always
 * invoked exactly once — when KILO_PERF is off, this just wraps `fn()`
 * with a couple of `performance.now()` reads (no allocation, no logging).
 */
export function timed<T>(name: string, fn: () => T, tags?: Record<string, string | number>): T {
  const mode = readFlag()
  if (!mode) return fn()
  const start = performance.now()
  const result = fn()
  const duration = performance.now() - start
  report(mode, name, duration, tags)
  return result
}

function report(mode: Mode, name: string, duration: number, tags?: Record<string, string | number>): void {
  if (duration > SLOW_THRESHOLD_MS) {
    if (tags) console.warn(`[KILO_PERF] slow ${name}: ${duration.toFixed(1)}ms`, tags)
    else console.warn(`[KILO_PERF] slow ${name}: ${duration.toFixed(1)}ms`)
    return
  }
  if (mode === "verbose") {
    if (tags) console.log(`[KILO_PERF] ${name}: ${duration.toFixed(1)}ms`, tags)
    else console.log(`[KILO_PERF] ${name}: ${duration.toFixed(1)}ms`)
  }
}
