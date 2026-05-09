/**
 * VS Code API context provider
 * Provides access to the VS Code webview API for posting messages
 */

import { createContext, useContext, onCleanup, ParentComponent } from "solid-js"
import type { VSCodeAPI, WebviewMessage, ExtensionMessage } from "../types/messages"

// Get the VS Code API (only available in webview context)
let vscodeApi: VSCodeAPI | undefined

export function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    // In VS Code webview, acquireVsCodeApi is available globally
    if (typeof acquireVsCodeApi === "function") {
      vscodeApi = acquireVsCodeApi()
    } else {
      // Mock for development/testing outside VS Code
      console.warn("[Kilo New] Running outside VS Code, using mock API")
      vscodeApi = {
        postMessage: (msg) => console.log("[Kilo New] Mock postMessage:", msg),
        getState: () => undefined,
        setState: () => {},
      }
    }
  }
  return vscodeApi
}

// Context value type
interface VSCodeContextValue {
  postMessage: (message: WebviewMessage) => void
  /** Wildcard handler — receives every message. Prefer `onMessageFor` for new
   *  call sites: the wildcard path runs every handler for every event, which
   *  scaled poorly (38+ handlers × every SSE-driven `partUpdated`). */
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
  /** Type-keyed handler — runs only when `message.type === type`. Drops the
   *  per-event N-handler scan for hot streaming paths. */
  onMessageFor: <T extends ExtensionMessage["type"]>(
    type: T,
    handler: (message: Extract<ExtensionMessage, { type: T }>) => void,
  ) => () => void
  getState: <T>() => T | undefined
  setState: <T>(state: T) => void
}

const VSCodeContext = createContext<VSCodeContextValue>()

export const VSCodeProvider: ParentComponent = (props) => {
  const api = getVSCodeAPI()
  // Wildcards still fan out to every registered handler — kept for migration
  // ergonomics. Existing onMessage callers continue to work; new code should
  // use onMessageFor to land in the byType bucket.
  const wildcards = new Set<(message: ExtensionMessage) => void>()
  const byType = new Map<string, Set<(message: ExtensionMessage) => void>>()

  // Listen for messages from the extension
  const messageListener = (event: MessageEvent) => {
    const message = event.data as ExtensionMessage
    if (message && typeof message === "object" && "type" in message) {
      const set = byType.get((message as { type: string }).type)
      if (set) for (const h of set) h(message)
    }
    for (const h of wildcards) h(message)
  }

  window.addEventListener("message", messageListener)

  onCleanup(() => {
    window.removeEventListener("message", messageListener)
    wildcards.clear()
    byType.clear()
  })

  const value: VSCodeContextValue = {
    postMessage: (message: WebviewMessage) => {
      api.postMessage(message)
    },
    onMessage: (handler: (message: ExtensionMessage) => void) => {
      wildcards.add(handler)
      return () => wildcards.delete(handler)
    },
    onMessageFor: <T extends ExtensionMessage["type"]>(
      type: T,
      handler: (message: Extract<ExtensionMessage, { type: T }>) => void,
    ) => {
      let set = byType.get(type)
      if (!set) {
        set = new Set()
        byType.set(type, set)
      }
      const wrapped = handler as (m: ExtensionMessage) => void
      set.add(wrapped)
      return () => {
        const s = byType.get(type)
        if (!s) return
        s.delete(wrapped)
        if (s.size === 0) byType.delete(type)
      }
    },
    getState: <T,>() => api.getState() as T | undefined,
    setState: <T,>(state: T) => api.setState(state),
  }

  return <VSCodeContext.Provider value={value}>{props.children}</VSCodeContext.Provider>
}

export function useVSCode(): VSCodeContextValue {
  const context = useContext(VSCodeContext)
  if (!context) {
    throw new Error("useVSCode must be used within a VSCodeProvider")
  }
  return context
}
