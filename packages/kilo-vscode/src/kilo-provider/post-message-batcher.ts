/**
 * Microtask-coalesced postMessage batcher.
 *
 * Per AGENTS.md "Coalesce postMessage calls in a single microtask via a
 * per-tick flush. Each post is an IPC trip; at 200 evt/sec the syscall
 * overhead dominates. Batch and decode events: T[] on the receiver."
 *
 * Wraps a single VS Code webview reference and groups every `enqueue` call
 * arriving within a tick into a single `extensionBatch` envelope sent at the
 * next microtask. The webview-side message listener flattens the batch back
 * into individual events for normal dispatch (see `webview-ui/src/context/vscode.tsx`).
 *
 * Used by both KiloProvider (sidebar) and AgentManagerProvider (editor panel)
 * — they each own one batcher per webview-shaped surface.
 */

/**
 * Minimal target interface — we accept anything with a `postMessage` method,
 * whether it returns void (PanelContext) or Thenable (vscode.Webview). The
 * batcher fires and forgets; promise rejections are reported via .then().
 */
interface PostTarget {
  postMessage(message: unknown): void | Thenable<unknown>
}

export interface PostMessageBatcherOptions {
  /**
   * Returns the current target or undefined if not attached. Captured lazily
   * at enqueue/flush time so the batcher doesn't pin a stale reference across
   * webview reloads.
   */
  getTarget: () => PostTarget | null | undefined
  /** Identifier prefix for error logging. */
  name?: string
}

function logPostError(prefix: string, error: unknown): void {
  console.error(`[Kilo New] ${prefix}: postMessage failed`, error)
}

function postOnce(target: PostTarget, message: unknown, name: string): void {
  const result = target.postMessage(message)
  if (result && typeof (result as { then?: unknown }).then === "function") {
    ;(result as Thenable<unknown>).then(undefined, (error) => logPostError(name, error))
  }
}

export class PostMessageBatcher {
  private readonly getTarget: () => PostTarget | null | undefined
  private readonly name: string
  private pending: unknown[] = []
  private flushScheduled = false

  constructor(opts: PostMessageBatcherOptions) {
    this.getTarget = opts.getTarget
    this.name = opts.name ?? "PostMessageBatcher"
  }

  /**
   * Queue a message for the next microtask flush. The target is captured
   * lazily at flush time, so calls before it attaches are dropped (matches
   * the prior "no webview" behavior of direct callers).
   */
  enqueue(message: unknown): void {
    if (!this.getTarget()) {
      const type =
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        typeof (message as { type?: unknown }).type === "string"
          ? (message as { type: string }).type
          : "<unknown>"
      console.warn(`[Kilo New] ${this.name}: postMessage dropped (no target)`, { type })
      return
    }
    this.pending.push(message)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => this.flush())
    }
  }

  /**
   * Synchronous flush — call on dispose to drain queued messages before the
   * target reference is cleared. Safe no-op if the queue is empty.
   */
  flush(): void {
    this.flushScheduled = false
    if (this.pending.length === 0) return

    const target = this.getTarget()
    if (!target) {
      this.pending = []
      return
    }

    if (this.pending.length === 1) {
      const msg = this.pending[0]
      this.pending = []
      postOnce(target, msg, this.name)
      return
    }

    const events = this.pending
    this.pending = []
    postOnce(target, { type: "extensionBatch", events }, this.name)
  }
}
