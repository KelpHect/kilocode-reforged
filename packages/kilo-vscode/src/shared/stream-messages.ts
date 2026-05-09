/**
 * Wire types for the streaming part-update pipeline.
 *
 * Single source of truth shared by the extension-side scheduler
 * (`session-stream-scheduler.ts`) and the webview-side message types
 * (`webview-ui/src/types/messages.ts`). The generic `P` lets the webview
 * narrow `part` to its concrete `Part` union while the scheduler stays
 * payload-agnostic.
 */

export type PartTextDelta = { type: "text-delta"; textDelta: string }

export type PartUpdate<P = unknown> = {
  type: "partUpdated"
  sessionID: string
  messageID: string
  part: P
  delta?: PartTextDelta
}

export type PartBatch<P = unknown> = {
  type: "partsUpdated"
  updates: PartUpdate<P>[]
}

export type PartRemove = {
  type: "partRemoved"
  sessionID: string
  messageID: string
  partID: string
}

/**
 * Compact text-append wire format for streaming text/reasoning parts.
 *
 * Once a part has been bootstrapped on the webview side (via PartUpdate carrying
 * the full part), subsequent text-only deltas can be sent as PartTextAppend —
 * the webview locates the existing part by id and appends `textDelta` directly.
 * Drops the part-snapshot baggage from the IPC payload, which otherwise grows
 * O(n²) over a streamed message (each delta carried the full accumulated text).
 *
 * If the webview hasn't seen the part yet (e.g. extension-side reconnect after
 * a session-switch dropped the cache), the message is ignored — the next
 * PartUpdate will resync the part contents.
 */
export type PartTextAppend = {
  type: "partTextAppend"
  sessionID: string
  messageID: string
  partID: string
  textDelta: string
}
