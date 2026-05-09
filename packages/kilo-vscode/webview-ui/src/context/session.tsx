/**
 * Session context
 * Manages session state, messages, and handles SSE events from the extension.
 * Also owns global (extension-lifetime) model selection (provider context is catalog-only).
 */

import {
  createContext,
  useContext,
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  onMount,
  onCleanup,
  batch,
} from "solid-js"
import type { ParentComponent, Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useVSCode } from "./vscode"
import { useServer } from "./server"
import { useProvider } from "./provider"
import { useConfig } from "./config"
import { useLanguage } from "./language"
import { showToast } from "@kilocode/kilo-ui/toast"
import type {
  SessionInfo,
  Message,
  Part,
  PartDelta,
  SessionStatus,
  SessionStatusInfo,
  PermissionRequest,
  QuestionRequest,
  SuggestionRequest,
  TodoItem,
  ModelSelection,
  ContextUsage,
  AgentInfo,
  SkillInfo,
  ExtensionMessage,
  FileAttachment,
  SendMessageFailedMessage,
  McpStatusEntry,
  MessageLoadMode,
} from "../types/messages"
import { removeSessionPermissions, upsertPermission } from "./permission-queue"
import {
  computeStatus,
  calcContextUsage,
  buildFamilyCosts,
  buildFamilyLabels,
  buildCostBreakdown,
  childID,
  arraysShallowEqual,
  setsEqual,
} from "./session-utils"
import { Identifier } from "../utils/id"
import { resolveModelSelection } from "./model-selection"
import { resolveMessagePrefs } from "./session-preferences"
import { errorIDs } from "./session-errors"
import { PartStash } from "./part-stash"
import { timed } from "../utils/perf"
import { getVariant, sessionVariantKeys, transferVariants, variantKey } from "./session-variant-store"
import { KILO_AUTO, parseModelString } from "../../../src/shared/provider-model"

const RECENT_LIMIT = 5
const MESSAGE_PAGE_LIMIT = 80

type MessageMutation = Exclude<MessageLoadMode, "focus"> | "append" | "update"

interface MessagePageState {
  initialLoaded: boolean
  loadingInitial: boolean
  loadingOlder: boolean
  before?: string
  hasMore: boolean
  lastMutation?: MessageMutation
}

const emptyPageState: MessagePageState = {
  initialLoaded: false,
  loadingInitial: false,
  loadingOlder: false,
  hasMore: false,
}

// Store structure for messages and parts
interface SessionStore {
  sessions: Record<string, SessionInfo>
  messages: Record<string, Message[]> // sessionID -> messages
  parts: Record<string, Part[]> // messageID -> parts
  todos: Record<string, TodoItem[]> // sessionID -> todos
  modelSelections: Record<string, ModelSelection | null> // agentName -> model (global, extension-lifetime)
  sessionOverrides: Record<string, ModelSelection> // sessionID -> per-session model override (compare mode)
  agentSelections: Record<string, string> // sessionID -> agent name
  variantSelections: Record<string, string> // session/agent scoped variant key -> variant name
  recentModels: ModelSelection[]
  favoriteModels: ModelSelection[]
}

interface SessionContextValue {
  // Current session
  currentSessionID: Accessor<string | undefined>
  currentSession: Accessor<SessionInfo | undefined>
  setCurrentSessionID: (id: string | undefined) => void

  // All sessions (sorted most recent first)
  sessions: Accessor<SessionInfo[]>

  // Session status
  status: Accessor<SessionStatus>
  statusInfo: Accessor<SessionStatusInfo>
  statusText: Accessor<string | undefined>
  busySince: Accessor<number | undefined>
  loading: Accessor<boolean>
  loadingOlderMessages: Accessor<boolean>
  hasOlderMessages: Accessor<boolean>
  messageMutation: Accessor<MessageMutation | undefined>

  // Messages for current session
  messages: Accessor<Message[]>

  // User messages for current session (role === "user")
  userMessages: Accessor<Message[]>

  // All messages keyed by sessionID (includes child sessions)
  allMessages: () => Record<string, Message[]>

  // All parts keyed by messageID (includes child sessions)
  allParts: () => Record<string, Part[]>

  // All session statuses keyed by sessionID (for DataBridge)
  allStatusMap: () => Record<string, SessionStatusInfo>

  // Parts for a specific message
  getParts: (messageID: string) => Part[]

  // Hidden after model changes so switching models can clear stale provider errors
  // without removing messages and their checkpoint restore actions.
  isErrorHidden: (messageID: string) => boolean

  // Move stashed parts into the reactive store for the given message IDs.
  // Called by VscodeSessionTurn when the virtualizer renders a turn.
  hydrateParts: (messageIDs: string[]) => void

  // Todos for current session
  todos: Accessor<TodoItem[]>

  // Pending permission requests (unscoped — all tracked sessions)
  permissions: Accessor<PermissionRequest[]>
  respondingPermissions: Accessor<Set<string>>

  // Pending question requests (unscoped — all tracked sessions)
  questions: Accessor<QuestionRequest[]>
  questionErrors: Accessor<Set<string>>
  suggestions: Accessor<SuggestionRequest[]>
  suggestionErrors: Accessor<Set<string>>
  respondingSuggestions: Accessor<Set<string>>

  // Scoped permissions/questions — filtered to a session's family (self + subagents)
  scopedPermissions: (sessionID: string | undefined) => PermissionRequest[]
  scopedQuestions: (sessionID: string | undefined) => QuestionRequest[]
  scopedSuggestions: (sessionID: string | undefined) => SuggestionRequest[]

  // Model selection (global, extension-lifetime)
  selected: (sessionID?: string) => ModelSelection | null
  selectModel: (providerID: string, modelID: string, sessionID?: string) => void
  hasModelOverride: (sessionID?: string) => boolean
  clearModelOverride: (sessionID?: string) => void

  // Cost and context usage for the current session
  costBreakdown: Accessor<Array<{ label: string; cost: number }>>
  contextUsage: Accessor<ContextUsage | undefined>

  // Skills loaded from the CLI backend
  skills: Accessor<SkillInfo[]>
  refreshSkills: () => void
  removeSkill: (location: string) => void

  // Agent/mode selection (per-session)
  agents: Accessor<AgentInfo[]>
  allAgents: Accessor<AgentInfo[]>
  removeMode: (name: string) => void
  removeMcp: (name: string) => void

  // MCP server status (runtime connect/disconnect)
  mcpStatus: Accessor<Record<string, McpStatusEntry>>
  mcpLoading: Accessor<string | null>
  connectMcp: (name: string) => void
  disconnectMcp: (name: string) => void
  authenticateMcp: (name: string) => void
  refreshMcpStatus: () => void
  selectedAgent: (sessionID?: string) => string
  selectAgent: (name: string, sessionID?: string) => void
  getSessionAgent: (sessionID: string) => string
  getSessionModel: (sessionID: string) => ModelSelection | null
  setSessionModel: (sessionID: string, providerID: string, modelID: string) => void
  setSessionAgent: (sessionID: string, name: string) => void
  setSessionVariant: (sessionID: string, providerID: string, modelID: string, value: string, agent?: string) => void

  // Thinking variant for the selected model
  variantList: (sessionID?: string) => string[]
  currentVariant: (sessionID?: string) => string | undefined
  selectVariant: (value: string, sessionID?: string) => void

  // Model favorites
  favoriteModels: Accessor<ModelSelection[]>
  toggleFavorite: (providerID: string, modelID: string) => void

  // Revert/undo state for the current session
  revert: Accessor<SessionInfo["revert"]>
  revertedCount: Accessor<number>
  summary: Accessor<SessionInfo["summary"]>

  // Live worktree diff stats (polled from CLI backend)
  worktreeStats: Accessor<{ files: number; additions: number; deletions: number } | undefined>

  // Actions
  revertSession: (messageID: string) => void
  unrevertSession: () => void
  sendMessage: (
    text: string,
    providerID?: string,
    modelID?: string,
    files?: FileAttachment[],
    draftID?: string,
    context?: string,
  ) => void
  sendCommand: (
    command: string,
    args: string,
    providerID?: string,
    modelID?: string,
    files?: FileAttachment[],
    draftID?: string,
    context?: string,
  ) => void
  abort: () => void
  compact: () => void
  respondToPermission: (
    permissionId: string,
    response: "once" | "always" | "reject",
    approvedAlways: string[],
    deniedAlways: string[],
  ) => void
  replyToQuestion: (requestID: string, answers: string[][]) => void
  rejectQuestion: (requestID: string) => void
  acceptSuggestion: (requestID: string, index: number) => void
  dismissSuggestion: (requestID: string) => void
  createSession: () => void
  clearCurrentSession: () => void
  loadSessions: () => void
  loadOlderMessages: () => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  syncSession: (sessionID: string) => void

  // Cloud session preview
  cloudPreviewId: Accessor<string | null>
  selectCloudSession: (cloudSessionId: string) => void
  draftSessionID: Accessor<string | undefined>
  setDraftSessionID: (id: string | undefined) => void
}

export const SessionContext = createContext<SessionContextValue>()

export const SessionProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const server = useServer()
  const provider = useProvider()
  const { config } = useConfig()
  const language = useLanguage()

  // Current session ID
  const [currentSessionID, setCurrentSessionID] = createSignal<string | undefined>()
  const [draftSessionID, setDraftSessionID] = createSignal<string | undefined>()

  // Per-session status map — keyed by sessionID
  const [statusMap, setStatusMap] = createStore<Record<string, SessionStatusInfo>>({})
  const [busySinceMap, setBusySinceMap] = createStore<Record<string, number>>({})

  const idle: SessionStatusInfo = { type: "idle" }

  // Derived accessors for the current session (backwards compatible)
  const statusInfo = () => {
    const id = currentSessionID()
    return id ? (statusMap[id] ?? idle) : idle
  }
  const status = () => statusInfo().type as SessionStatus
  const busySince = () => {
    const id = currentSessionID()
    return id ? busySinceMap[id] : undefined
  }

  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal<Set<string>>(new Set())
  const [pages, setPages] = createStore<Record<string, MessagePageState>>({})

  // Parts stash: holds parts from messagesLoaded outside the reactive store
  // until a VscodeSessionTurn is rendered by the virtualizer and calls
  // hydrateParts(). This avoids writing parts for off-screen messages into
  // the store, which would trigger expensive DOM work for invisible content.
  const stash = new PartStash()

  // Family / scoped derivation caches. sessionFamily walks the message+parts
  // graph BFS-style and is read from statusText, PermissionDock, QuestionDock,
  // and various send/abort handlers. Without memoization the BFS re-runs on
  // every render touching scopedPermissions/Questions/Suggestions. Each entry
  // owns a detached Solid root so we can dispose it surgically on session
  // delete or session switch (see disposeFamilyMemosFor) without leaking
  // reactive subscriptions to store.messages / store.parts.
  type DisposableMemo<T> = { memo: () => T; dispose: () => void }
  const familyMemos = new Map<string, DisposableMemo<Set<string>>>()
  const scopedPermsMemos = new Map<string, DisposableMemo<PermissionRequest[]>>()
  const scopedQuestionsMemos = new Map<string, DisposableMemo<QuestionRequest[]>>()
  const scopedSuggestionsMemos = new Map<string, DisposableMemo<SuggestionRequest[]>>()

  // Incremental session-family adjacency. Previously computeSessionFamily
  // walked store.messages / store.parts BFS-style, subscribing to thousands
  // of reactive reads — every part-delta re-ran the entire walk and cascaded
  // into 5+ downstream memos (scopedPermissions/Questions/Suggestions, costs,
  // labels, statusText). With an explicit parent→child map maintained at
  // ingest time, family lookup is O(family-depth) and only invalidates when
  // a *new* child relationship is discovered.
  const sessionChildren = new Map<string, Set<string>>()
  const sessionParent = new Map<string, string>()
  const familyCache = new Map<string, { v: Set<string>; rev: number }>()
  // Reactive bump used by computeSessionFamily memos. Increment whenever a
  // new (parent, child) edge is added so consumers re-run the cached walk.
  const [familyRev, setFamilyRev] = createSignal(0)

  /** Register a (parent, child) session edge. Called from mergePartUpdate
   *  when a tool=task part's metadata.sessionId points at a new child.
   *  No-ops on duplicates so streaming text-deltas don't churn the rev. */
  function registerSessionEdge(parentSid: string, childSid: string): void {
    if (parentSid === childSid) return
    if (sessionParent.get(childSid) === parentSid) return
    sessionParent.set(childSid, parentSid)
    let kids = sessionChildren.get(parentSid)
    if (!kids) {
      kids = new Set()
      sessionChildren.set(parentSid, kids)
    }
    if (kids.has(childSid)) return
    kids.add(childSid)
    setFamilyRev((r) => r + 1)
  }

  function disposeFamilyMemosFor(sessionID: string) {
    familyMemos.get(sessionID)?.dispose()
    familyMemos.delete(sessionID)
    scopedPermsMemos.get(sessionID)?.dispose()
    scopedPermsMemos.delete(sessionID)
    scopedQuestionsMemos.get(sessionID)?.dispose()
    scopedQuestionsMemos.delete(sessionID)
    scopedSuggestionsMemos.get(sessionID)?.dispose()
    scopedSuggestionsMemos.delete(sessionID)
    familyCache.delete(sessionID)
    // NOTE: Adjacency (`sessionChildren` / `sessionParent`) is intentionally
    // *not* cleared here. parkSessionParts() calls this on every session
    // switch — clearing edges would force a re-walk on every re-entry. Edges
    // are erased only on session *delete* via dropAdjacencyFor().
  }

  /** Drop parent→child adjacency for a deleted session. Keep entries that
   *  point AT live sessions so re-entering surviving parents still resolves
   *  their family deterministically. */
  function dropAdjacencyFor(sessionID: string): void {
    const kids = sessionChildren.get(sessionID)
    const hadParent = sessionParent.delete(sessionID)
    if (!kids && !hadParent) return
    if (kids) {
      for (const child of kids) sessionParent.delete(child)
      sessionChildren.delete(sessionID)
    }
    // Only bump familyRev when adjacency actually changed — otherwise every
    // unrelated leaf-session delete would invalidate every other session's
    // family memo cache.
    setFamilyRev((r) => r + 1)
  }

  // Pending permissions
  const [permissions, setPermissions] = createSignal<PermissionRequest[]>([])

  // Permission IDs that have been responded to but not yet confirmed by the server
  const [respondingPermissions, setRespondingPermissions] = createSignal<Set<string>>(new Set())

  // Pending questions
  const [questions, setQuestions] = createSignal<QuestionRequest[]>([])

  // Tracks question IDs that failed so the UI can reset sending state
  const [questionErrors, setQuestionErrors] = createSignal<Set<string>>(new Set())
  const [suggestions, setSuggestions] = createSignal<SuggestionRequest[]>([])
  const [suggestionErrors, setSuggestionErrors] = createSignal<Set<string>>(new Set())
  const [respondingSuggestions, setRespondingSuggestions] = createSignal<Set<string>>(new Set())

  // Tracks whether the user has explicitly set a model override per agent (to
  // prevent the default-sync effect from overwriting it).
  const [userSetAgents, setUserSetAgents] = createSignal<Record<string, boolean>>({})

  // Agents (modes) loaded from the CLI backend
  const [agents, setAgents] = createSignal<AgentInfo[]>([])
  const [allAgents, setAllAgents] = createSignal<AgentInfo[]>([])
  const [defaultAgent, setDefaultAgent] = createSignal("code")

  // Skills loaded from the CLI backend
  const [skills, setSkills] = createSignal<SkillInfo[]>([])

  const removeMode = (name: string) => {
    setAgents((prev) => prev.filter((a) => a.name !== name))

    // Clear stale selections so selectedAgentName() falls back to the default
    if (pendingAgentSelection() === name) {
      setPendingAgentSelection(null)
    }
    setStore(
      "agentSelections",
      produce((selections) => {
        for (const sid of Object.keys(selections)) {
          if (selections[sid] === name) delete selections[sid]
        }
      }),
    )

    // Drop the per-mode model selection and the userSet flag for the removed
    // agent. Otherwise re-creating an agent with the same name later would
    // resurrect an obsolete model choice instead of resolving from config.
    setStore(
      "modelSelections",
      produce((selections) => {
        delete selections[name]
      }),
    )
    setUserSetAgents((prev) => {
      if (!prev[name]) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })

    vscode.postMessage({ type: "removeMode", name })
  }

  const removeMcp = (name: string) => {
    vscode.postMessage({ type: "removeMcp", name })
  }

  // MCP runtime status
  const [mcpStatus, setMcpStatus] = createSignal<Record<string, McpStatusEntry>>({})
  const [mcpLoading, setMcpLoading] = createSignal<string | null>(null)

  const connectMcp = (name: string) => {
    if (mcpLoading()) return
    if (!server.isConnected()) return
    setMcpLoading(name)
    vscode.postMessage({ type: "connectMcp", name })
  }

  const disconnectMcp = (name: string) => {
    if (mcpLoading()) return
    if (!server.isConnected()) return
    setMcpLoading(name)
    vscode.postMessage({ type: "disconnectMcp", name })
  }

  const authenticateMcp = (name: string) => {
    if (mcpLoading()) return
    if (!server.isConnected()) return
    setMcpLoading(name)
    vscode.postMessage({ type: "authenticateMcp", name })
  }

  const refreshMcpStatus = () => {
    vscode.postMessage({ type: "requestMcpStatus" })
  }

  // Pending agent selection for before a session exists
  const [pendingAgentSelection, setPendingAgentSelection] = createSignal<string | null>(null)

  // Cloud session preview state
  const [cloudPreviewId, setCloudPreviewId] = createSignal<string | null>(null)
  const [hiddenErrors, setHiddenErrors] = createSignal<Set<string>>(new Set())

  // Live worktree diff stats from extension polling
  const [worktreeStats, setWorktreeStats] = createSignal<
    { files: number; additions: number; deletions: number } | undefined
  >()

  // Tracks optimistic messageIDs that haven't been confirmed by the server yet.
  // Prevents handleMessagesLoaded from wiping them when it replaces the array.
  const pendingOptimistic = new Map<string, Set<string>>()

  // Store for sessions, messages, parts, todos, modelSelections, agentSelections
  const [store, setStore] = createStore<SessionStore>({
    sessions: {},
    messages: {},
    parts: {},
    todos: {},
    modelSelections: {},
    sessionOverrides: {},
    agentSelections: {},
    variantSelections: {},
    recentModels: [],
    favoriteModels: [],
  })

  // Per-session agent selection
  const selectedAgentName = createMemo<string>(() => {
    const sessionID = currentSessionID()
    if (sessionID) {
      return store.agentSelections[sessionID] ?? defaultAgent()
    }
    return pendingAgentSelection() ?? defaultAgent()
  })

  function agentForScope(sessionID?: string) {
    if (sessionID) return store.agentSelections[sessionID] ?? defaultAgent()
    return selectedAgentName()
  }

  const agentNames = createMemo<Set<string>>(() => new Set(agents().map((agent) => agent.name)), new Set<string>(), {
    equals: setsEqual,
  })

  /** Per-mode model from config (e.g. config.agent.code.model). */
  function getModeModel(agentName: string): ModelSelection | null {
    return parseModelString(config().agent?.[agentName]?.model)
  }

  /** Global default model from config (config.model). */
  function getGlobalModel(): ModelSelection | null {
    return parseModelString(config().model)
  }

  function resolveModel(agentName: string, override?: ModelSelection | null): ModelSelection | null {
    return resolveModelSelection({
      providers: provider.providers(),
      connected: provider.connected(),
      override,
      mode: getModeModel(agentName),
      global: getGlobalModel(),
      recent: store.recentModels,
      fallback: KILO_AUTO,
    })
  }

  // Keep model selection in sync with provider/mode default until the user
  // explicitly overrides it.
  createEffect(() => {
    const agentName = selectedAgentName()
    if (userSetAgents()[agentName]) return
    const sel = resolveModel(agentName)
    setStore("modelSelections", agentName, sel)
  })

  const currentSelected = createMemo<ModelSelection | null>(() => {
    const sid = currentSessionID()
    if (sid) {
      const session = store.sessionOverrides[sid]
      if (session) return session
    }
    const agentName = selectedAgentName()
    return resolveModel(agentName, store.modelSelections[agentName])
  })

  // Precedence: scoped override > per-agent global/default > config/default.
  function selected(sessionID?: string): ModelSelection | null {
    if (!sessionID) return currentSelected()
    const session = store.sessionOverrides[sessionID]
    if (session) return session
    const agentName = agentForScope(sessionID)
    return resolveModel(agentName, store.modelSelections[agentName])
  }

  function pushRecent(selection: ModelSelection) {
    const key = `${selection.providerID}/${selection.modelID}`
    const filtered = store.recentModels.filter((r) => `${r.providerID}/${r.modelID}` !== key)
    const updated = [selection, ...filtered].slice(0, RECENT_LIMIT)
    setStore("recentModels", updated)
    vscode.postMessage({ type: "persistRecents", recents: updated })
  }

  function applyModel(agentName: string, selection: ModelSelection, sessionID?: string) {
    pushRecent(selection)
    if (sessionID) {
      setStore("sessionOverrides", sessionID, selection)
      return
    }
    // Always remember the per-mode model choice so switching modes restores
    // the last-used model (mirrors CLI TUI's model.json behavior).
    setUserSetAgents((prev) => ({ ...prev, [agentName]: true }))
    setStore("modelSelections", agentName, selection)
    // Persist to model.json via the extension host
    vscode.postMessage({
      type: "persistModelSelection",
      agent: agentName,
      providerID: selection.providerID,
      modelID: selection.modelID,
    })
  }

  function selectModel(providerID: string, modelID: string, sessionID?: string) {
    const sid = sessionID ?? currentSessionID()
    applyModel(agentForScope(sid), { providerID, modelID }, sid)
    if (sid) {
      hideErrors(sid)
    }
  }

  function promptAgent(sessionID?: string) {
    const name = agentForScope(sessionID)
    return name !== defaultAgent() ? name : undefined
  }

  function hideErrors(sid: string) {
    const msgs = store.messages[sid]
    if (!msgs?.length) return
    // Single-pass scan that allocates the Set only when there's something
    // new to add. errorIDs walked + filtered + mapped the message list,
    // and the previous setHiddenErrors callback always allocated a new Set
    // even when nothing changed.
    setHiddenErrors((prev) => {
      let next: Set<string> | undefined
      for (const m of msgs) {
        if (!m.error) continue
        if (prev.has(m.id)) continue
        next ??= new Set(prev)
        next.add(m.id)
      }
      return next ?? prev
    })
  }

  function clearHiddenErrors(ids: string[]) {
    if (ids.length === 0) return
    setHiddenErrors((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      if (next.size === prev.size) return prev
      return next
    })
  }

  function configModel(sessionID?: string): ModelSelection | null {
    const agentName = agentForScope(sessionID)
    return resolveModel(agentName)
  }

  /** True when the active model differs from what the config dictates. */
  function hasModelOverride(sessionID?: string) {
    const sel = selected(sessionID)
    const cfg = configModel(sessionID)
    if (!sel || !cfg) return false
    return sel.providerID !== cfg.providerID || sel.modelID !== cfg.modelID
  }

  /** Clear the per-mode model override, falling back to config default. */
  function clearModelOverride(sessionID?: string) {
    const sid = sessionID ?? currentSessionID()
    if (sid) {
      setStore(
        "sessionOverrides",
        produce((overrides) => {
          delete overrides[sid]
        }),
      )
      hideErrors(sid)
      return
    }
    const agentName = selectedAgentName()
    setUserSetAgents((prev) => {
      const next = { ...prev }
      delete next[agentName]
      return next
    })
    setStore(
      "modelSelections",
      produce((selections) => {
        delete selections[agentName]
      }),
    )
    // Clear from model.json via extension host
    vscode.postMessage({ type: "clearModelSelection", agent: agentName })
  }

  // Track the agent-name set that was last used to recover prefs so we can
  // skip the full-store rescan when nothing changed (settings save with no
  // agent edits, redundant agentsLoaded pushes after profile reattach, etc.).
  let lastAgentNamesKey = ""
  const namesKey = (s: Set<string>) => [...s].sort().join("|")

  // Handle agentsLoaded immediately (not in onMount) so we never miss
  // the initial push that arrives before the DOM mounts. This mirrors the
  // pattern used by ProviderProvider for providersLoaded.
  // Uses onMessageFor so this handler doesn't run for unrelated SSE traffic.
  const unsubAgents = vscode.onMessageFor("agentsLoaded", (message) => {
    setAgents(message.agents)
    setAllAgents(message.allAgents ?? message.agents)
    setDefaultAgent(message.defaultAgent)

    const names = new Set(message.agents.map((a) => a.name))

    // Reset pending selection if the agent no longer exists (e.g. after org switch)
    const pending = pendingAgentSelection()
    if (!pending || !names.has(pending)) {
      setPendingAgentSelection(message.defaultAgent)
    }

    // Clear per-session selections that reference a mode no longer available
    setStore(
      "agentSelections",
      produce((selections) => {
        for (const sid of Object.keys(selections)) {
          if (selections[sid] && !names.has(selections[sid]!)) delete selections[sid]
        }
      }),
    )

    // Rescan already-loaded message history so sessions whose messagesLoaded
    // arrived before agentsLoaded (and therefore got no agent selection) are
    // backfilled now that we know the valid agent names. Idempotent: skip
    // when the agent-name set is unchanged AND skip individual sessions whose
    // selection is already valid against the new names — most settings saves
    // don't change agent names, so this turns a 10–30 ms hitch into a no-op.
    // Iterate via `for…in` so we don't allocate the Object.entries snapshot
    // on every settings save.
    const key = namesKey(names)
    if (key !== lastAgentNamesKey) {
      lastAgentNamesKey = key
      batch(() => {
        for (const sid in store.messages) {
          const sel = store.agentSelections[sid]
          if (sel && names.has(sel)) continue
          const msgs = store.messages[sid]
          if (msgs) recoverPrefs(sid, msgs, names)
        }
      })
    }
  })

  // Request agents immediately; if the extension's httpClient is not yet ready,
  // extensionDataReady will fire once initialization completes and we retry once.
  vscode.postMessage({ type: "requestAgents" })

  // Skills loaded from the CLI backend
  const unsubSkills = vscode.onMessageFor("skillsLoaded", (message) => {
    setSkills(message.skills)
  })

  const refreshSkills = () => {
    vscode.postMessage({ type: "requestSkills" })
  }

  const removeSkill = (location: string) => {
    setSkills((prev) => prev.filter((s) => s.location !== location))
    vscode.postMessage({ type: "removeSkill", location })
  }

  // Handle permission events immediately (not in onMount) so we never miss
  // the first permission request that may arrive before the DOM mounts.
  // This matches the pattern already used for agentsLoaded and skillsLoaded.
  // Split per-type so unrelated SSE traffic doesn't run any of these handlers.
  const unsubPermReq = vscode.onMessageFor("permissionRequest", (m) => handlePermissionRequest(m.permission))
  const unsubPermRes = vscode.onMessageFor("permissionResolved", (m) => handlePermissionResolved(m.permissionID))
  const unsubPermErr = vscode.onMessageFor("permissionError", (m) => handlePermissionError(m.permissionID, m.stale))
  onCleanup(() => {
    unsubPermReq()
    unsubPermRes()
    unsubPermErr()
  })

  // MCP status loaded from CLI backend
  const unsubMcpStatus = vscode.onMessageFor("mcpStatusLoaded", (message) => {
    setMcpStatus(message.status)
    setMcpLoading(null)
  })

  // Request MCP status immediately; retry once on extensionDataReady if still missing.
  vscode.postMessage({ type: "requestMcpStatus" })

  const fallback = setTimeout(() => {
    if (agents().length === 0) vscode.postMessage({ type: "requestAgents" })
    if (Object.keys(mcpStatus()).length === 0) vscode.postMessage({ type: "requestMcpStatus" })
  }, 3000)

  const unsubReady = vscode.onMessageFor("extensionDataReady", () => {
    unsubReady()
    clearTimeout(fallback)
    if (agents().length === 0) vscode.postMessage({ type: "requestAgents" })
    if (Object.keys(mcpStatus()).length === 0) vscode.postMessage({ type: "requestMcpStatus" })
  })

  onCleanup(() => {
    unsubAgents()
    unsubSkills()
    unsubMcpStatus()
    unsubReady()
    clearTimeout(fallback)
  })

  const variantList = (sessionID?: string) => {
    const sel = selected(sessionID)
    if (!sel) return []
    const model = provider.findModel(sel)
    if (!model?.variants) return []
    return Object.keys(model.variants)
  }

  const currentVariant = (sessionID?: string) => {
    const sid = sessionID ?? currentSessionID()
    const sel = selected(sid)
    if (!sel) return undefined
    const list = variantList(sid)
    if (list.length === 0) return undefined
    return getVariant(store.variantSelections, sel, list, agentForScope(sid), sid)
  }

  const selectVariant = (value: string, sessionID?: string) => {
    const sid = sessionID ?? currentSessionID()
    const sel = selected(sid)
    if (!sel) return
    const key = variantKey(sel, agentForScope(sid), sid)
    setStore("variantSelections", key, value)
    if (!sid) vscode.postMessage({ type: "persistVariant", key, value })
  }

  // Load persisted variants from extension globalState
  const unsubVariants = vscode.onMessageFor("variantsLoaded", (message) => {
    for (const [k, v] of Object.entries(message.variants)) {
      if (k.startsWith("session/")) continue
      setStore("variantSelections", k, v)
    }
  })

  vscode.postMessage({ type: "requestVariants" })

  onCleanup(unsubVariants)

  // Load persisted per-mode model selections from model.json via extension host.
  // Uses replace semantics so a reset (empty payload) clears old entries.
  const unsubSelections = vscode.onMessageFor("modelSelectionsLoaded", (message) => {
    setStore("modelSelections", reconcile(message.selections))
    const flags: Record<string, boolean> = {}
    for (const name of Object.keys(message.selections)) {
      flags[name] = true
    }
    setUserSetAgents(flags)
  })
  vscode.postMessage({ type: "requestModelSelections" })
  onCleanup(unsubSelections)

  // Load persisted recent models from extension globalState
  const unsubRecents = vscode.onMessageFor("recentsLoaded", (message) => {
    setStore("recentModels", message.recents)
  })
  vscode.postMessage({ type: "requestRecents" })
  onCleanup(unsubRecents)

  // Load persisted favorite models from extension globalState
  const unsubFavorites = vscode.onMessageFor("favoritesLoaded", (message) => {
    setStore("favoriteModels", message.favorites)
  })
  vscode.postMessage({ type: "requestFavorites" })
  onCleanup(unsubFavorites)

  function handleError(message: Extract<ExtensionMessage, { type: "error" }>) {
    if (!message.sessionID || message.sessionID === currentSessionID()) setLoading(false)
    if (message.sessionID) patchPage(message.sessionID, { loadingInitial: false, loadingOlder: false })
  }

  function toggleFavorite(providerID: string, modelID: string) {
    const key = `${providerID}/${modelID}`
    const idx = store.favoriteModels.findIndex((f) => `${f.providerID}/${f.modelID}` === key)
    const updated =
      idx >= 0 ? store.favoriteModels.filter((_, i) => i !== idx) : [...store.favoriteModels, { providerID, modelID }]
    const action = idx >= 0 ? "remove" : "add"
    setStore("favoriteModels", updated)
    vscode.postMessage({ type: "toggleFavorite", action, providerID, modelID })
  }

  function handleStreamMessage(message: ExtensionMessage): boolean {
    if (message.type === "partUpdated") {
      handlePartUpdated(message.sessionID, message.messageID, message.part, message.delta)
      return true
    }

    if (message.type === "partsUpdated") {
      batch(() => {
        for (const update of message.updates) {
          handlePartUpdated(update.sessionID, update.messageID, update.part, update.delta)
        }
      })
      return true
    }

    if (message.type === "partTextAppend") {
      // Compact wire format: only a textDelta, no full part snapshot.
      // Drops the O(n²) IPC payload that the full part-snapshot form
      // produced over a long streamed text or reasoning part. The
      // scheduler only emits this once we've already bootstrapped the
      // part on this side; if for any reason the part is no longer in
      // the store/stash (session re-loaded), the merge no-ops and a
      // subsequent full PartUpdate will resync the content.
      handlePartTextAppend(message.sessionID, message.messageID, message.partID, message.textDelta)
      return true
    }

    if (message.type === "partRemoved") {
      handlePartRemoved(message.sessionID, message.messageID, message.partID)
      return true
    }

    return false
  }

  /**
   * Microtask-batched text-delta accumulator.
   *
   * Per AGENTS.md "Strings: array-of-chunks + single .join('') for SSE delta
   * accumulation". Each `+=` creates a ConsString cons-node; subsequent
   * char-access operations (e.g. `marked.parse(text)` at render time) flatten
   * the tree at O(total) cost. With 100-200 deltas/sec a single message can
   * accumulate a 200-deep ConsString within seconds, and every render flattens
   * the whole tree.
   *
   * Strategy: queue all deltas in a Map<key, chunks[]> within a tick; flush at
   * next microtask via a single `setStore` + `produce` that joins chunks per
   * part and applies one `+=` per part. For 50 deltas in one tick this turns
   * 50 cons-nodes per part into 1 cons-node per part — depth bounded by
   * the worst-case "deltas-per-tick", typically <10.
   *
   * Ordering with non-delta `partUpdate` (full snapshot) is preserved by
   * `dropPendingDeltasFor` — when a snapshot arrives for a part with pending
   * deltas, the deltas are dropped (the snapshot subsumes them).
   */
  interface PendingDeltaEntry {
    sessionID: string | undefined
    chunks: string[]
  }
  const pendingTextDeltas = new Map<string, PendingDeltaEntry>()
  let textDeltaFlushScheduled = false

  function pendingDeltaKey(messageID: string, partID: string): string {
    return `${messageID} ${partID}`
  }

  function enqueueTextDelta(
    sessionID: string | undefined,
    messageID: string,
    partID: string,
    textDelta: string,
  ): void {
    const key = pendingDeltaKey(messageID, partID)
    const entry = pendingTextDeltas.get(key)
    if (entry) {
      entry.chunks.push(textDelta)
    } else {
      pendingTextDeltas.set(key, { sessionID, chunks: [textDelta] })
    }
    if (!textDeltaFlushScheduled) {
      textDeltaFlushScheduled = true
      queueMicrotask(flushTextDeltas)
    }
  }

  function dropPendingDeltasFor(messageID: string, partID: string): void {
    pendingTextDeltas.delete(pendingDeltaKey(messageID, partID))
  }

  function dropPendingDeltasForMessage(messageID: string): void {
    const prefix = `${messageID} `
    for (const key of pendingTextDeltas.keys()) {
      if (key.startsWith(prefix)) pendingTextDeltas.delete(key)
    }
  }

  function flushTextDeltas(): void {
    textDeltaFlushScheduled = false
    if (pendingTextDeltas.size === 0) return

    interface FlushItem {
      messageID: string
      partID: string
      sessionID: string | undefined
      joined: string
    }
    const storeBatch: FlushItem[] = []
    const stashBatch: FlushItem[] = []

    for (const [key, entry] of pendingTextDeltas) {
      const sep = key.indexOf(" ")
      if (sep < 0) continue
      const messageID = key.slice(0, sep)
      const partID = key.slice(sep + 1)
      const joined = entry.chunks.length === 1 ? entry.chunks[0] : entry.chunks.join("")
      const item: FlushItem = { messageID, partID, sessionID: entry.sessionID, joined }
      if (messageID in store.parts) storeBatch.push(item)
      else stashBatch.push(item)
    }
    pendingTextDeltas.clear()

    // Apply all hydrated-store updates in a single setStore + produce.
    if (storeBatch.length > 0) {
      setStore(
        "parts",
        produce((parts) => {
          for (let i = 0; i < storeBatch.length; i++) {
            const { messageID, partID, joined } = storeBatch[i]
            const list = parts[messageID]
            if (!list) continue
            const idx = list.findIndex((p) => p.id === partID)
            if (idx < 0) continue
            const existing = list[idx]
            if (existing && (existing.type === "text" || existing.type === "reasoning")) {
              ;(existing as { text: string }).text += joined
            }
          }
        }),
      )
      // Mirror lastMutation patching for each affected session — coalesced so
      // a session with 20 parts updating in this tick patches once.
      const seen = new Set<string>()
      for (let i = 0; i < storeBatch.length; i++) {
        const sid = storeBatch[i].sessionID
        if (!sid || seen.has(sid)) continue
        seen.add(sid)
        patchPage(sid, { lastMutation: "update" })
      }
    }

    // Stash updates respect the off-screen text cap; can't be batched into
    // setStore/produce because the stash is a side-store, not reactive.
    for (let i = 0; i < stashBatch.length; i++) {
      const { messageID, partID, joined } = stashBatch[i]
      const stashed = stash.peek(messageID)
      if (!stashed) continue
      const idx = stashed.findIndex((p) => p.id === partID)
      if (idx < 0) continue
      const existing = stashed[idx]
      if (existing.type !== "text" && existing.type !== "reasoning") continue
      const target = existing as { text: string }
      if (target.text.length >= STASH_TEXT_CAP) continue
      const next = target.text.length + joined.length
      if (next > STASH_TEXT_CAP) {
        const remaining = STASH_TEXT_CAP - target.text.length
        target.text += joined.slice(0, remaining) + "\n… (truncated, hydrate to view full content)"
      } else {
        target.text += joined
      }
    }
  }

  /**
   * Cap for off-screen accumulated text. Without this, a long-running
   * off-screen tool output (e.g. multi-MB log) accumulates in the stash with
   * no upper bound until the user scrolls to it. Hydration shows the cap;
   * the user can refresh to fetch the full part on demand.
   */
  const STASH_TEXT_CAP = 262_144

  /** Apply a compact text-only delta against an already-bootstrapped part.
   *  Quietly skips if the part isn't found — the scheduler only emits this
   *  form for parts it has already sent in full, but that bootstrap can be
   *  invalidated by drop()/messagesLoaded; recovery comes from the next
   *  full PartUpdate carrying the part snapshot. */
  function handlePartTextAppend(sessionID: string, messageID: string, partID: string, textDelta: string) {
    enqueueTextDelta(sessionID || undefined, messageID, partID, textDelta)
  }

  function handleExtensionMessage(message: ExtensionMessage): void {
    // Route suggestion messages (extracted to stay within complexity limit)
    routeSuggestionMessage(message)
    if (handleStreamMessage(message)) return
    switch (message.type) {
      case "sessionCreated":
        handleSessionCreated(message.session, message.draftID)
        break

      case "messagesLoaded":
        handleMessagesLoaded(message.sessionID, message.messages, {
          mode: message.mode,
          cursor: message.cursor,
          hasMore: message.hasMore,
        })
        break

      case "messageCreated":
        handleMessageCreated(message.message)
        break

      case "sessionStatus":
        handleSessionStatus(message.sessionID, message.status, message.attempt, message.message, message.next)
        break

      case "todoUpdated":
        handleTodoUpdated(message.sessionID, message.items)
        break

      case "questionRequest":
        handleQuestionRequest(message.question)
        break

      case "questionResolved":
        handleQuestionResolved(message.requestID)
        break

      case "questionError":
        handleQuestionError(message.requestID)
        break

      case "clearPendingPrompts":
        setPermissions([])
        setQuestions([])
        setSuggestions([])
        setRespondingPermissions(new Set<string>())
        setSuggestionErrors(new Set<string>())
        setRespondingSuggestions(new Set<string>())
        break

      case "sessionsLoaded":
        handleSessionsLoaded(message.sessions, message.preserveSessionIds)
        break

      case "sessionUpdated":
        setStore("sessions", message.session.id, message.session)
        break

      case "sessionDeleted":
        handleSessionDeleted(message.sessionID)
        break

      case "messageRemoved":
        handleMessageRemoved(message.sessionID, message.messageID)
        break

      case "sessionError": {
        if (message.error?.name === "MessageAbortedError") break
        const sid = message.sessionID ?? currentSessionID()
        if (!sid) break
        // Find the last user message in this session to use as parentID
        const msgs = store.messages[sid] ?? []
        const parent = [...msgs].reverse().find((m) => m.role === "user")
        const errorMsg: Message = {
          id: Identifier.ascending("message"),
          sessionID: sid,
          role: "assistant",
          createdAt: new Date().toISOString(),
          parentID: parent?.id,
          error: message.error,
        }
        handleMessageCreated(errorMsg)
        break
      }

      case "error":
        handleError(message)
        break

      case "sendMessageFailed":
        handleSendMessageFailed(message as unknown as SendMessageFailedMessage)
        break

      case "cloudSessionDataLoaded":
        handleCloudSessionDataLoaded(message.cloudSessionId, message.title, message.messages)
        break

      case "cloudSessionImported":
        handleCloudSessionImported(message.cloudSessionId, message.session)
        break

      case "cloudSessionImportFailed":
        setCloudPreviewId(null)
        setCurrentSessionID(undefined)
        setLoading(false)
        showToast({
          variant: "error",
          title: language.t("session.cloud.import.failed") ?? "Failed to import cloud session",
          description: message.error,
        })
        console.error("[Kilo New] Cloud session import failed:", message.error)
        break

      case "worktreeStatsLoaded":
        setWorktreeStats({ files: message.files, additions: message.additions, deletions: message.deletions })
        break
    }
  }

  // Handle messages from extension
  onMount(() => {
    const unsubscribe = vscode.onMessage(handleExtensionMessage)
    onCleanup(unsubscribe)
  })

  // Event handlers
  function handleSessionCreated(session: SessionInfo, draftID?: string) {
    batch(() => {
      setStore("sessions", session.id, session)

      // Only initialize messages if none exist yet — a cloud session import
      // (handleCloudSessionImported) may have already populated messages for
      // this session ID. The SSE session.created event can race with the
      // cloudSessionImported message, and wiping to [] causes a flash of
      // the empty/welcome screen.
      if (!store.messages[session.id]?.length) {
        setStore("messages", session.id, [])
      }

      const pendingAgent = draftID ? store.agentSelections[draftID] : pendingAgentSelection()
      const pendingModel = draftID ? store.sessionOverrides[draftID] : undefined
      if (draftID) {
        const entries = transferVariants(store.variantSelections, draftID, session.id)
        for (const [key, value] of Object.entries(entries)) {
          setStore("variantSelections", key, value)
          vscode.postMessage({ type: "persistVariant", key, value })
        }
        if (pendingAgent) setStore("agentSelections", session.id, pendingAgent)
        if (pendingModel) setStore("sessionOverrides", session.id, pendingModel)
        setStore(
          "agentSelections",
          produce((agents) => {
            delete agents[draftID]
          }),
        )
        setStore(
          "sessionOverrides",
          produce((models) => {
            delete models[draftID]
          }),
        )
        setStore(
          "variantSelections",
          produce((variants) => {
            for (const key of sessionVariantKeys(variants, draftID)) delete variants[key]
          }),
        )
      } else if (pendingAgent && !store.agentSelections[session.id]) {
        setStore("agentSelections", session.id, pendingAgent)
        setPendingAgentSelection(null)
      }

      const active = currentSessionID()
      const draft = draftSessionID()
      if (!draftID || draft === draftID || active === draftID) {
        setCurrentSessionID(session.id)
        setDraftSessionID(session.id)
      }
    })
  }

  function patchPage(sessionID: string, patch: Partial<MessagePageState>) {
    setPages(sessionID, { ...(pages[sessionID] ?? emptyPageState), ...patch })
  }

  function mergeMessages(current: Message[], incoming: Message[], mode: Exclude<MessageLoadMode, "focus">) {
    if (mode === "reconcile") {
      // Tail reconcile: incoming is the authoritative newest-N snapshot.
      // Local state may already hold some of those IDs and may also hold
      // newer optimistic entries created after the fetch was taken. Merge
      // by id (server wins on collision) then sort by createdAt so new
      // server messages land in the right position and optimistic tail
      // entries stay at the end.
      const byId = new Map<string, Message>()
      for (const msg of current) byId.set(msg.id, msg)
      for (const msg of incoming) byId.set(msg.id, msg)
      return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    }
    const seen = new Set<string>()
    const source = mode === "prepend" ? [...incoming, ...current] : incoming
    return source.filter((msg) => {
      if (seen.has(msg.id)) return false
      seen.add(msg.id)
      return true
    })
  }

  function recoverPrefs(sessionID: string, messages: Message[], names = agentNames()) {
    const prefs = resolveMessagePrefs(messages, names)
    if (prefs.agent && !store.agentSelections[sessionID]) {
      setStore("agentSelections", sessionID, prefs.agent)
    }
    if (prefs.model && !store.sessionOverrides[sessionID]) {
      setStore("sessionOverrides", sessionID, prefs.model)
    }
    if (prefs.model && prefs.variant) {
      const agent = prefs.agent ?? store.agentSelections[sessionID] ?? defaultAgent()
      const key = variantKey(prefs.model, agent, sessionID)
      if (!store.variantSelections[key]) setStore("variantSelections", key, prefs.variant)
    }
  }

  function withPending(sessionID: string, messages: Message[]) {
    const pending = pendingOptimistic.get(sessionID)
    if (!pending || pending.size === 0) return messages
    const ids = new Set(messages.map((msg) => msg.id))
    const current = store.messages[sessionID] ?? []
    const orphans = current.filter((msg) => pending.has(msg.id) && !ids.has(msg.id))
    return [...messages, ...orphans]
  }

  // Cheap shape check: same ids in same order AND same part counts per message.
  // Short-circuits reconcile when the server snapshot matches local state
  // (the common case — SSE didn't actually miss anything), avoiding the
  // 80 setStore("parts", ...) calls per session switch.
  function sameReconcileShape(current: Message[], incoming: Message[]): boolean {
    if (current.length !== incoming.length) return false
    for (let i = 0; i < incoming.length; i++) {
      const c = current[i]!
      const n = incoming[i]!
      if (c.id !== n.id) return false
      if ((c.parts?.length ?? 0) !== (n.parts?.length ?? 0)) return false
    }
    return true
  }

  function handleMessagesLoaded(
    sessionID: string,
    messages: Message[],
    input: { mode?: Exclude<MessageLoadMode, "focus">; cursor?: string; hasMore?: boolean } = {},
  ) {
    const mode = input.mode ?? "replace"
    const reset = mode === "prepend"

    // Reconcile fast-path: if the tail matches local state shape-wise, every
    // message+part-count already agrees with the server. Skip the reactive
    // store churn entirely — virtualizer and rendering stay untouched.
    if (mode === "reconcile" && sameReconcileShape(store.messages[sessionID] ?? [], messages)) {
      patchPage(sessionID, { initialLoaded: true, lastMutation: "update" })
      return
    }

    // Replace fast-path: re-entering a session that already has the same
    // message list (same ids, same part counts) is the common case when the
    // user tabs back-and-forth between two sessions. Same shape => same parts
    // are already in either the reactive store or the stash, so the message
    // overwrite + N stash.put calls are pure waste. Mark loaded and update
    // pagination, then exit.
    if (mode === "replace" && sameReconcileShape(store.messages[sessionID] ?? [], messages)) {
      batch(() => {
        setLoaded((prev) => {
          if (prev.has(sessionID)) return prev
          const next = new Set(prev)
          next.add(sessionID)
          return next
        })
        if (sessionID === currentSessionID()) setLoading(false)
        setPages(sessionID, {
          initialLoaded: true,
          loadingInitial: false,
          loadingOlder: false,
          before: input.cursor,
          hasMore: input.hasMore ?? Boolean(input.cursor),
          lastMutation: mode,
        })
      })
      return
    }

    batch(() => {
      setLoaded((prev) => {
        if (prev.has(sessionID)) return prev
        const next = new Set(prev)
        next.add(sessionID)
        return next
      })
      if (sessionID === currentSessionID()) setLoading(false)

      const current = store.messages[sessionID] ?? []
      const merged =
        mode === "prepend" || mode === "reconcile"
          ? mergeMessages(current, messages, mode)
          : withPending(sessionID, messages)
      // The three load modes have different invariants — picking the right
      // store-write strategy matters because `reconcile` walks every message
      // in deep-diff mode, which dominated session-switch traces (~900ms).
      //
      // - "replace" (session switch / cloud import): the entire list is new.
      //   Direct assign; reconcile would do O(n) work to confirm "everything
      //   is new", which we already know.
      // - "prepend" (load earlier): mergeMessages produces incoming items at
      //   the front (plain objects with fresh IDs) followed by the current
      //   tail (existing Solid proxies, references preserved by spread). A
      //   direct assign keeps those tail proxies — Solid recognizes the
      //   same references and skips re-wrapping. New head items wrap lazily
      //   on access. stableMessageTurns then reuses existing turn objects
      //   for the unchanged tail because `old.user === turn.user` still
      //   holds. No deep diff needed.
      // - "reconcile" (background tail refresh): incoming server snapshot
      //   may have rewritten content for existing IDs (completed timestamps,
      //   finish reasons, edits). Need the deep diff to catch that without
      //   tearing down downstream consumers; reconcile updates fields in
      //   place on matching proxies.
      // On "replace" we're swapping the entire message list, so any
      // hiddenErrors entries pointing at message IDs no longer present are
      // dead weight — they're never read again, but the Set keeps growing
      // each time the user re-enters a session. Compute the diff against
      // `current` *before* the setStore overwrites it.
      if (mode === "replace") {
        const live = new Set(merged.map((m) => m.id))
        const dropped: string[] = []
        for (const m of current) if (!live.has(m.id)) dropped.push(m.id)
        if (dropped.length > 0) clearHiddenErrors(dropped)
      }

      timed(
        "loadMessages.setStore",
        () => {
          if (mode === "reconcile") {
            setStore("messages", sessionID, reconcile(merged, { key: "id" }))
          } else {
            setStore("messages", sessionID, merged)
          }
        },
        { mode, count: merged.length },
      )

      for (const msg of messages) {
        if (!msg.parts || msg.parts.length === 0) continue
        // Bulk-loaded parts won't trigger handlePartUpdated, so seed adjacency
        // here. registerSessionEdge no-ops on duplicates and only bumps the
        // family revision when a *new* edge appears.
        registerEdgesFromParts(sessionID, msg.parts)
        if (mode === "reconcile" && store.parts[msg.id]) {
          // Reconcile on a message already hydrated into the reactive store:
          // write parts directly so visible turns pick up the server-
          // authoritative state immediately instead of waiting for the
          // virtualizer to re-render.
          setStore("parts", msg.id, reconcile(msg.parts, { key: "id" }))
          stash.remove(msg.id)
        } else {
          // Stash parts outside the reactive store — they'll be hydrated
          // on demand when the virtualizer renders the corresponding turn.
          stash.put(msg.id, msg.parts)
        }
      }

      // "reconcile" is a background tail refresh, not a page navigation —
      // preserve the existing pagination cursor/hasMore so "load earlier"
      // keeps working.
      if (mode === "reconcile") {
        patchPage(sessionID, { initialLoaded: true, lastMutation: "update" })
      } else {
        setPages(sessionID, {
          initialLoaded: true,
          loadingInitial: false,
          loadingOlder: false,
          before: input.cursor,
          hasMore: input.hasMore ?? Boolean(input.cursor),
          lastMutation: mode,
        })
      }

      recoverPrefs(sessionID, merged)
    })
    if (reset) requestAnimationFrame(() => patchPage(sessionID, { lastMutation: undefined }))
  }

  function handleMessageCreated(message: Message) {
    // Message confirmed by server — no longer optimistic.
    // Clear placeholder parts so they don't duplicate alongside real parts
    // arriving via individual part.updated events (the server's message.updated
    // SSE event does NOT include parts).
    const pending = pendingOptimistic.get(message.sessionID)
    const wasOptimistic = pending?.has(message.id)
    pending?.delete(message.id)

    if (wasOptimistic) {
      setStore(
        "parts",
        produce((p) => {
          delete p[message.id]
        }),
      )
    }

    const exists = (store.messages[message.sessionID] ?? []).some((msg) => msg.id === message.id)
    setStore("messages", message.sessionID, (msgs = []) => {
      // Check if message already exists (optimistic or update case).
      // Since we now use the same messageID for optimistic and server messages,
      // this naturally handles the optimistic→real transition.
      const idx = msgs.findIndex((m) => m.id === message.id)
      if (idx >= 0) {
        const updated = [...msgs]
        updated[idx] = { ...msgs[idx], ...message }
        return updated
      }
      return [...msgs, message]
    })
    patchPage(message.sessionID, { initialLoaded: true, lastMutation: exists ? "update" : "append" })

    recoverPrefs(message.sessionID, [message])

    if (message.parts && message.parts.length > 0) {
      stash.remove(message.id)
      setStore("parts", message.id, message.parts)
      // Seed the parent→child adjacency from any task tool parts in this
      // freshly created message. mergePartUpdate also calls registerSessionEdge
      // for streamed updates, but the initial bulk parts arrive here.
      registerEdgesFromParts(message.sessionID, message.parts)
    }
  }

  /** Scan a part list for tool=task children and register the edges. Used
   *  by handleMessageCreated and handleMessagesLoaded so the adjacency map
   *  reflects history loaded outside the streaming path. */
  function registerEdgesFromParts(parentSid: string, parts: Part[]): void {
    for (const p of parts) {
      if (p.type !== "tool") continue
      const child = childID(
        p as {
          type: string
          tool?: string
          metadata?: { sessionId?: string }
          state?: { metadata?: { sessionId?: string } }
        },
      )
      if (child) registerSessionEdge(parentSid, child)
    }
  }

  function handlePartUpdated(
    sessionID: string | undefined,
    messageID: string | undefined,
    part: Part,
    delta?: PartDelta,
  ) {
    // Get messageID from the part itself if not provided in the message
    const effectiveMessageID = messageID || part.messageID

    if (!effectiveMessageID) {
      console.warn("[Kilo New] Part updated without messageID:", part.id, part.type)
      return
    }

    if (sessionID) patchPage(sessionID, { lastMutation: "update" })

    // Maintain the parent→child adjacency map at ingest. The parent is the
    // session that *owns this message* (sessionID arg), and the child (if
    // any) is the task tool's metadata.sessionId. Doing this here means
    // computeSessionFamily can be a pure cache lookup against `familyRev`
    // instead of a full BFS subscribed to store.messages / store.parts.
    if (sessionID && part.type === "tool") {
      const child = childID(
        part as {
          type: string
          tool?: string
          metadata?: { sessionId?: string }
          state?: { metadata?: { sessionId?: string } }
        },
      )
      if (child) registerSessionEdge(sessionID, child)
    }

    timed("handlePartUpdated", () => mergePartUpdate(effectiveMessageID, part, delta), { type: part.type })
  }

  /** Body of handlePartUpdated, extracted so timed() wraps the merge work without nesting. */
  function mergePartUpdate(effectiveMessageID: string, part: Part, delta?: PartDelta) {
    // Route the update based on whether the message has been hydrated into
    // the reactive store. A turn is "hydrated" once its VscodeSessionTurn
    // mounted and called hydrateParts(), which writes parts under the
    // message's key in store.parts. While off-screen we keep the parts in
    // the stash so streaming SSE deltas don't create reactive proxies for
    // content nobody is rendering. The drain happens in hydrateParts().

    // Pure text-delta against an existing part → enqueue for microtask flush
    // (see flushTextDeltas). This collapses N deltas-per-tick into a single
    // `+=` so ConsString depth stays bounded by deltas-per-microtask, not
    // by total deltas-since-last-render.
    if (
      delta?.type === "text-delta" &&
      delta.textDelta &&
      (part.type === "text" || part.type === "reasoning")
    ) {
      const present = effectiveMessageID in store.parts
        ? store.parts[effectiveMessageID]?.some((p) => p.id === part.id)
        : stash.peek(effectiveMessageID)?.some((p) => p.id === part.id)
      if (present) {
        enqueueTextDelta(undefined, effectiveMessageID, part.id, delta.textDelta)
        return
      }
      // Part not yet present — fall through so the snapshot is inserted now.
    }

    // Non-delta path: a full snapshot supersedes any pending deltas for this
    // part (their content is included in `part.text`). Drop them so the
    // microtask flush doesn't double-apply.
    dropPendingDeltasFor(effectiveMessageID, part.id)

    if (effectiveMessageID in store.parts) {
      setStore(
        "parts",
        produce((parts) => {
          const list = parts[effectiveMessageID]
          if (!list) {
            // Defensive: the key was present at the check above but the value
            // is missing. Treat as a fresh hydrated list.
            parts[effectiveMessageID] = [part]
            return
          }
          const idx = list.findIndex((p) => p.id === part.id)
          if (idx < 0) {
            list.push(part)
            return
          }
          list[idx] = part
        }),
      )
      return
    }

    // Off-screen: merge into the stash in place. PartStash exposes the
    // backing array via peek(); mutating it updates the stored value
    // because the stash holds the same reference.
    const stashed = stash.peek(effectiveMessageID)
    if (!stashed) {
      stash.put(effectiveMessageID, [part])
      return
    }
    const idx = stashed.findIndex((p) => p.id === part.id)
    if (idx < 0) {
      stashed.push(part)
      return
    }
    stashed[idx] = part
  }

  function handlePartRemoved(sessionID: string | undefined, messageID: string, partID: string) {
    if (sessionID) patchPage(sessionID, { lastMutation: "update" })

    // Drop any pending text-deltas for this part — the part is gone and
    // applying queued deltas would be a no-op at best, a phantom-text bug
    // if the part id is reused.
    dropPendingDeltasFor(messageID, partID)

    setStore(
      "parts",
      produce((parts) => {
        const list = parts[messageID]
        if (!list) return
        const idx = list.findIndex((p) => p.id === partID)
        if (idx < 0) return
        list.splice(idx, 1)
      }),
    )
  }

  function handleSessionStatus(
    sessionID: string,
    newStatus: SessionStatus,
    attempt?: number,
    message?: string,
    next?: number,
  ) {
    const prev = statusMap[sessionID] ?? { type: "idle" }
    const info: SessionStatusInfo =
      newStatus === "retry"
        ? { type: "retry", attempt: attempt ?? 0, message: message ?? "", next: next ?? 0 }
        : newStatus === "offline"
          ? { type: "offline", message: message ?? "" }
          : { type: newStatus }
    setStatusMap(sessionID, info)
    // Track busy start time
    if (prev.type === "idle" && newStatus !== "idle") {
      setBusySinceMap(sessionID, Date.now())
    }
    if (newStatus === "idle") {
      setBusySinceMap(
        produce((map) => {
          delete map[sessionID]
        }),
      )
      // Session is idle — any remaining pending optimistic IDs are either
      // already confirmed (messageCreated removed them) or orphaned (queued
      // callbacks were dropped on abort). Clean up the tracking set; the
      // messages themselves will be reconciled on the next messagesLoaded.
      pendingOptimistic.delete(sessionID)
    }
  }

  function handlePermissionRequest(permission: PermissionRequest) {
    setPermissions((prev) => upsertPermission(prev, permission))
  }

  function handlePermissionResolved(permissionID: string) {
    setPermissions((prev) => prev.filter((p) => p.id !== permissionID))
    setRespondingPermissions((prev) => {
      if (!prev.has(permissionID)) return prev
      const next = new Set(prev)
      next.delete(permissionID)
      return next
    })
  }

  function handlePermissionError(permissionID: string, stale?: boolean) {
    setRespondingPermissions((prev) => {
      if (!prev.has(permissionID)) return prev
      const next = new Set(prev)
      next.delete(permissionID)
      return next
    })
    if (stale) {
      setPermissions((prev) => prev.filter((p) => p.id !== permissionID))
      return
    }
    showToast({
      variant: "error",
      title: language.t("settings.permissions.toast.updateFailed.title"),
    })
  }

  function handleQuestionRequest(question: QuestionRequest) {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === question.id)
      if (idx === -1) return [...prev, question]
      const next = prev.slice()
      next[idx] = question
      return next
    })
  }

  function handleQuestionResolved(requestID: string) {
    setQuestions((prev) => prev.filter((q) => q.id !== requestID))
    setQuestionErrors((prev) => {
      const next = new Set(prev)
      next.delete(requestID)
      return next
    })
  }

  function handleQuestionError(requestID: string) {
    setQuestionErrors((prev) => new Set(prev).add(requestID))
  }

  function handleSuggestionRequest(suggestion: SuggestionRequest) {
    setSuggestions((prev) => {
      const idx = prev.findIndex((item) => item.id === suggestion.id)
      if (idx === -1) return [...prev, suggestion]
      const next = prev.slice()
      next[idx] = suggestion
      return next
    })
  }

  function handleSuggestionResolved(requestID: string) {
    setSuggestions((prev) => prev.filter((item) => item.id !== requestID))
    setRespondingSuggestions((prev) => {
      if (!prev.has(requestID)) return prev
      const next = new Set(prev)
      next.delete(requestID)
      return next
    })
    setSuggestionErrors((prev) => {
      if (!prev.has(requestID)) return prev
      const next = new Set(prev)
      next.delete(requestID)
      return next
    })
  }

  function handleSuggestionError(requestID: string) {
    setRespondingSuggestions((prev) => {
      if (!prev.has(requestID)) return prev
      const next = new Set(prev)
      next.delete(requestID)
      return next
    })
    setSuggestionErrors((prev) => new Set(prev).add(requestID))
  }

  /**
   * Route suggestion-related extension messages.
   * Extracted from the main message handler to stay within the complexity limit.
   */
  function routeSuggestionMessage(message: ExtensionMessage) {
    switch (message.type) {
      case "suggestionRequest":
        handleSuggestionRequest(message.suggestion)
        break
      case "suggestionResolved":
        handleSuggestionResolved(message.requestID)
        break
      case "suggestionError":
        handleSuggestionError(message.requestID)
        break
    }
  }

  /**
   * Handle a failed send: remove the optimistic message from the store
   * and show a toast. The PromptInput restores the draft text separately
   * by listening for the same sendMessageFailed event.
   */
  function handleSendMessageFailed(message: SendMessageFailedMessage) {
    if (message.sessionID && message.messageID) {
      pendingOptimistic.get(message.sessionID)?.delete(message.messageID)
      stash.remove(message.messageID)
      batch(() => {
        setStore("messages", message.sessionID!, (msgs = []) => msgs.filter((m) => m.id !== message.messageID))
        setStore(
          "parts",
          produce((parts) => {
            delete parts[message.messageID!]
          }),
        )
      })
    }

    showToast({
      variant: "error",
      title: language.t("prompt.toast.promptSendFailed.title") ?? "Failed to send message",
      description: message.error,
    })

    if (!message.sessionID && message.draftID) {
      setDraftSessionID(message.draftID)
    }
  }

  /**
   * Walk the parent→child adjacency map to discover all session IDs in a
   * session's family tree (self + subagents + sub-subagents).
   *
   * Previously this BFS read from store.messages / store.parts and got
   * subscribed (via the wrapping createMemo) to thousands of reactive
   * reads — every text-delta to any descendant re-ran the entire walk and
   * cascaded into 5+ downstream memos. Now adjacency is maintained
   * incrementally in handlePartUpdated / handleMessagesLoaded, the cache
   * is keyed on `familyRev`, and the only reactive dep is that single
   * counter signal. New child relationship → familyRev++ → memo re-runs;
   * everything else is a no-op.
   */
  function computeSessionFamily(rootID: string): Set<string> {
    const rev = familyRev()
    const cached = familyCache.get(rootID)
    if (cached && cached.rev === rev) return cached.v
    return timed(
      "sessionFamily",
      () => {
        const family = new Set<string>([rootID])
        const queue = [rootID]
        while (queue.length > 0) {
          const sid = queue.pop()!
          const kids = sessionChildren.get(sid)
          if (!kids) continue
          for (const c of kids) {
            if (family.has(c)) continue
            family.add(c)
            queue.push(c)
          }
        }
        familyCache.set(rootID, { v: family, rev })
        return family
      },
      { rootID },
    )
  }

  // Lazy, per-rootID memos for the family BFS and the scoped permission /
  // question / suggestion derivations. Each memo lives in its own detached
  // root so consumers don't accidentally dispose them when their component
  // unmounts, and so disposeFamilyMemosFor() can free them on session delete
  // or session switch. The memo only re-runs when its tracked reactive reads
  // (store.messages, store.parts, or the relevant signal) actually change.
  function getFamilyMemo(rootID: string): () => Set<string> {
    const cached = familyMemos.get(rootID)
    if (cached) return cached.memo
    const created = createRoot((dispose) => {
      const memo = createMemo(() => computeSessionFamily(rootID))
      return { memo, dispose }
    })
    familyMemos.set(rootID, created)
    return created.memo
  }

  function sessionFamily(rootID: string): Set<string> {
    return getFamilyMemo(rootID)()
  }

  /** Return permissions scoped to the given session's family (self + subagents). */
  function scopedPermissions(sessionID: string | undefined): PermissionRequest[] {
    if (!sessionID) return []
    const cached = scopedPermsMemos.get(sessionID)
    if (cached) return cached.memo()
    const created = createRoot((dispose) => {
      const family = getFamilyMemo(sessionID)
      const memo = createMemo<PermissionRequest[]>(
        () => {
          const fam = family()
          return permissions().filter((p) => fam.has(p.sessionID))
        },
        [],
        { equals: arraysShallowEqual },
      )
      return { memo, dispose }
    })
    scopedPermsMemos.set(sessionID, created)
    return created.memo()
  }

  /** Return questions scoped to the given session's family (self + subagents). */
  function scopedQuestions(sessionID: string | undefined): QuestionRequest[] {
    if (!sessionID) return []
    const cached = scopedQuestionsMemos.get(sessionID)
    if (cached) return cached.memo()
    const created = createRoot((dispose) => {
      const family = getFamilyMemo(sessionID)
      const memo = createMemo<QuestionRequest[]>(
        () => {
          const fam = family()
          return questions().filter((q) => fam.has(q.sessionID))
        },
        [],
        { equals: arraysShallowEqual },
      )
      return { memo, dispose }
    })
    scopedQuestionsMemos.set(sessionID, created)
    return created.memo()
  }

  function scopedSuggestions(sessionID: string | undefined): SuggestionRequest[] {
    if (!sessionID) return []
    const cached = scopedSuggestionsMemos.get(sessionID)
    if (cached) return cached.memo()
    const created = createRoot((dispose) => {
      const family = getFamilyMemo(sessionID)
      const memo = createMemo<SuggestionRequest[]>(
        () => {
          const fam = family()
          return suggestions().filter((item) => fam.has(item.sessionID))
        },
        [],
        { equals: arraysShallowEqual },
      )
      return { memo, dispose }
    })
    scopedSuggestionsMemos.set(sessionID, created)
    return created.memo()
  }

  function handleTodoUpdated(sessionID: string, items: TodoItem[]) {
    setStore("todos", sessionID, items)
  }

  function handleSessionsLoaded(loaded: SessionInfo[], preserve?: string[]) {
    const kept = preserve?.length ? new Set(preserve) : undefined
    batch(() => {
      // Reconcile: remove sessions not in the loaded list to prevent stale
      // entries from other projects accumulating in the store.
      // Sessions whose worktree directories failed to list are preserved —
      // their absence is transient, not a real deletion.
      const ids = new Set(loaded.map((s) => s.id))
      setStore(
        "sessions",
        produce((sessions) => {
          for (const id of Object.keys(sessions)) {
            if (id.startsWith("cloud:")) continue
            if (kept?.has(id)) continue
            if (!ids.has(id)) delete sessions[id]
          }
        }),
      )
      for (const s of loaded) {
        setStore("sessions", s.id, s)
      }
    })
  }

  function handleSessionDeleted(sessionID: string) {
    pendingOptimistic.delete(sessionID)
    batch(() => {
      // Collect message IDs so we can clean up their parts (store + stash)
      const msgs = store.messages[sessionID] ?? []
      const msgIds = msgs.map((m) => m.id)
      for (const id of msgIds) stash.remove(id)
      // Drop pending text-deltas keyed under any of this session's messages
      // so they don't leak across re-creation of an id (extremely rare but
      // possible when a deleted session's id is reused).
      for (const id of msgIds) dropPendingDeltasForMessage(id)
      clearHiddenErrors(msgIds)
      // Free per-session reactive subscriptions for family/scoped derivations.
      disposeFamilyMemosFor(sessionID)
      // Erase this session's parent→child adjacency entries so its memory
      // doesn't outlive the deletion and so familyRev triggers downstream
      // memos to refresh.
      dropAdjacencyFor(sessionID)

      // Drop the loaded marker for this session. Without this, a server-
      // initiated delete leaves the ID in `loaded` forever — a small but
      // unbounded leak across the webview's lifetime, and one that would
      // make selectSession() short-circuit with mode:"focus" for an ID the
      // server has already forgotten.
      setLoaded((prev) => {
        if (!prev.has(sessionID)) return prev
        const next = new Set(prev)
        next.delete(sessionID)
        return next
      })

      setStore(
        "sessions",
        produce((sessions) => {
          delete sessions[sessionID]
        }),
      )
      setStore(
        "messages",
        produce((messages) => {
          delete messages[sessionID]
        }),
      )
      setStore(
        "parts",
        produce((parts) => {
          for (const id of msgIds) {
            delete parts[id]
          }
        }),
      )
      setStore(
        "todos",
        produce((todos) => {
          delete todos[sessionID]
        }),
      )
      setPages(
        produce((map) => {
          delete map[sessionID]
        }),
      )
      setStore(
        "agentSelections",
        produce((selections) => {
          delete selections[sessionID]
        }),
      )
      // Drop any per-session model override and variant selections. The variant
      // store keys session-scoped entries with a `session/<id>/...` prefix; the
      // sessionVariantKeys helper enumerates them so we can purge in a single
      // produce call. Without this both maps retain entries indefinitely after
      // the source session is gone.
      setStore(
        "sessionOverrides",
        produce((overrides) => {
          delete overrides[sessionID]
        }),
      )
      setStore(
        "variantSelections",
        produce((variants) => {
          for (const key of sessionVariantKeys(variants, sessionID)) delete variants[key]
        }),
      )
      // Clean up pending questions/errors for the deleted session
      const deleted = questions()
        .filter((q) => q.sessionID === sessionID)
        .map((q) => q.id)
      if (deleted.length > 0) {
        setQuestions((prev) => prev.filter((q) => q.sessionID !== sessionID))
        setQuestionErrors((prev) => {
          const next = new Set(prev)
          for (const id of deleted) next.delete(id)
          if (next.size === prev.size) return prev
          return next
        })
      }
      const gone = suggestions()
        .filter((item) => item.sessionID === sessionID)
        .map((item) => item.id)
      if (gone.length > 0) {
        setSuggestions((prev) => prev.filter((item) => item.sessionID !== sessionID))
        setSuggestionErrors((prev) => {
          const next = new Set(prev)
          for (const id of gone) next.delete(id)
          if (next.size === prev.size) return prev
          return next
        })
        setRespondingSuggestions((prev) => {
          const next = new Set(prev)
          for (const id of gone) next.delete(id)
          if (next.size === prev.size) return prev
          return next
        })
      }
      setPermissions((prev) => removeSessionPermissions(prev, sessionID))
      setStatusMap(
        produce((map) => {
          delete map[sessionID]
        }),
      )
      setBusySinceMap(
        produce((map) => {
          delete map[sessionID]
        }),
      )
      if (currentSessionID() === sessionID) {
        setCurrentSessionID(undefined)
        setLoading(false)
      }
    })
  }

  // Splices the message from the store and deletes its parts.
  function handleMessageRemoved(sessionID: string, messageID: string) {
    setStore("messages", sessionID, (msgs = []) => msgs.filter((m) => m.id !== messageID))
    clearHiddenErrors([messageID])
    // Drop any queued text-deltas for this message — applying them post-removal
    // would either no-op or, worse, resurrect stale text on a recycled id.
    dropPendingDeltasForMessage(messageID)
    setStore(
      "parts",
      produce((parts) => {
        delete parts[messageID]
      }),
    )
    // Also clear any stashed parts for this message. Without this, a
    // removed-before-hydrated message leaks parts in the stash and can
    // resurface them via getParts() after the message is gone.
    stash.remove(messageID)
  }

  function handleCloudSessionDataLoaded(cloudSessionId: string, title: string, messages: Message[]) {
    if (cloudPreviewId() !== cloudSessionId) return
    const key = `cloud:${cloudSessionId}`
    batch(() => {
      setLoaded((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev)
        next.add(key)
        return next
      })
      setStore("sessions", key, {
        id: key,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      patchPage(key, { initialLoaded: true, hasMore: false, lastMutation: "replace" })
      setStore("messages", key, messages)
      for (const msg of messages) {
        if (msg.parts && msg.parts.length > 0) {
          setStore("parts", msg.id, msg.parts)
        }
      }
      setCurrentSessionID(key)
      setLoading(false)
    })
  }

  function handleCloudSessionImported(cloudSessionId: string, session: SessionInfo) {
    const cloudKey = `cloud:${cloudSessionId}`
    const cloudMessages = store.messages[cloudKey] ?? []
    batch(() => {
      setLoaded((prev) => {
        const next = new Set(prev)
        next.add(session.id)
        next.delete(cloudKey)
        return next
      })
      setStore("sessions", session.id, session)

      const pendingAgent = pendingAgentSelection()
      if (pendingAgent && !store.agentSelections[session.id]) {
        setStore("agentSelections", session.id, pendingAgent)
      }

      // Carry over cloud messages so there's no loading flash
      setStore("messages", session.id, cloudMessages)

      setCloudPreviewId(null)
      setCurrentSessionID(session.id)

      // Clean up synthetic cloud: entries from sessions/messages stores.
      //
      // Why we do NOT delete cloud parts here:
      //
      // During preview, parts are stored keyed by the original cloud message IDs
      // (e.g. store.parts["<cloud-msg-id>"] = [...]). When the import completes
      // we carry cloudMessages into the new local session (above) so the UI
      // renders immediately without a loading flash. Those carried-over message
      // objects still hold their original cloud IDs, so every SessionTurn
      // calls getParts("<cloud-msg-id>") — which means the parts must remain in
      // the store for now.
      //
      // If we deleted them here, every message would temporarily render with no
      // parts (parts().length === 0), showing only a loading shimmer until the
      // real data arrives.
      //
      // Instead, right after this batch we dispatch a "loadMessages" request
      // (below). When the extension responds with the "messagesLoaded" event,
      // handleMessagesLoaded() replaces the messages array with server-assigned
      // IDs and writes new parts keyed by those IDs. The old cloud-keyed part
      // entries become orphans — no message in the store references them anymore.
      // They remain in store.parts until the webview reloads or the store is
      // reset, which is a bounded, one-session-worth amount of data that does
      // not accumulate over time.
      setStore(
        "sessions",
        produce((sessions) => {
          delete sessions[cloudKey]
        }),
      )
      setStore(
        "messages",
        produce((messages) => {
          delete messages[cloudKey]
        }),
      )
    })
    // Load real messages in the background (picks up server-assigned IDs
    // and the new user message once the send completes via SSE)
    patchPage(session.id, { loadingInitial: true, before: undefined, hasMore: false })
    vscode.postMessage({ type: "loadMessages", sessionID: session.id, mode: "replace", limit: MESSAGE_PAGE_LIMIT })
  }

  // Actions
  function selectAgent(name: string, sessionID?: string) {
    const id = sessionID ?? currentSessionID()
    if (id) {
      setStore("agentSelections", id, name)
      // Clear per-session model override so the new mode's configured/default
      // model takes effect instead of the previous mode's override.
      setStore(
        "sessionOverrides",
        produce((overrides) => {
          delete overrides[id]
        }),
      )
    } else {
      setPendingAgentSelection(name)
      // When switching mode, initialize model for the new mode if the user
      // hasn't explicitly set one for it
      if (!userSetAgents()[name] && !store.modelSelections[name]) {
        setStore("modelSelections", name, resolveModel(name))
      }
    }
  }

  /** Create an optimistic user message + parts in the store so the UI updates instantly. */
  function addOptimistic(sid: string, messageID: string, text: string, files?: FileAttachment[]) {
    const now = Date.now()
    const temp: Message = {
      id: messageID,
      sessionID: sid,
      role: "user",
      createdAt: new Date(now).toISOString(),
      time: { created: now },
    }
    const pending = pendingOptimistic.get(sid) ?? new Set()
    pending.add(messageID)
    pendingOptimistic.set(sid, pending)

    const parts: Part[] = []
    if (text) {
      parts.push({ type: "text" as const, id: Identifier.ascending("part"), messageID, text })
    }
    for (const file of files ?? []) {
      parts.push({
        type: "file" as const,
        id: Identifier.ascending("part"),
        messageID,
        mime: file.mime,
        url: file.url,
        filename: file.filename,
        source: file.source,
      })
    }

    setStore("messages", sid, (msgs = []) => [...msgs, temp])
    setStore("parts", messageID, parts)
    patchPage(sid, { initialLoaded: true, lastMutation: "append" })
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("resumeAutoScroll")))
  }

  function sendMessage(
    text: string,
    providerID?: string,
    modelID?: string,
    files?: FileAttachment[],
    draftID?: string,
    context?: string,
  ) {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot send message: not connected")
      return
    }

    const messageID = Identifier.ascending("message")

    const preview = cloudPreviewId()
    if (preview) {
      const scope = draftID ?? currentSessionID()
      const agent = promptAgent(scope)
      vscode.postMessage({
        type: "importAndSend",
        cloudSessionId: preview,
        text,
        messageID,
        providerID,
        modelID,
        agent,
        variant: currentVariant(scope),
        files,
      })
      return
    }

    const sid = currentSessionID()
    const suggestion = scopedSuggestions(sid)[0]
    if (suggestion) dismissSuggestion(suggestion.id)
    for (const q of scopedQuestions(sid)) {
      rejectQuestion(q.id)
    }
    if (sid) addOptimistic(sid, messageID, text, files)

    const scope = draftID ?? sid
    const agent = promptAgent(scope)

    vscode.postMessage({
      type: "sendMessage",
      text,
      messageID,
      sessionID: sid,
      draftID,
      providerID,
      modelID,
      agent,
      variant: currentVariant(scope),
      files,
      agentManagerContext: context,
    })
  }

  function sendCommand(
    command: string,
    args: string,
    providerID?: string,
    modelID?: string,
    files?: FileAttachment[],
    draftID?: string,
    context?: string,
  ) {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot send command: not connected")
      return
    }

    // Cloud previews need import-then-command; post importAndSend with command metadata
    const preview = cloudPreviewId()
    if (preview) {
      const scope = draftID ?? currentSessionID()
      const agent = promptAgent(scope)
      vscode.postMessage({
        type: "importAndSend",
        cloudSessionId: preview,
        text: `/${command} ${args}`.trim(),
        messageID: Identifier.ascending("message"),
        providerID,
        modelID,
        agent,
        variant: currentVariant(scope),
        files,
        command,
        commandArgs: args,
      })
      return
    }

    const messageID = Identifier.ascending("message")
    const sid = currentSessionID()
    const suggestion = scopedSuggestions(sid)[0]
    if (suggestion) dismissSuggestion(suggestion.id)
    for (const q of scopedQuestions(sid)) {
      rejectQuestion(q.id)
    }

    if (sid) addOptimistic(sid, messageID, `/${command} ${args}`.trim(), files)

    const scope = draftID ?? sid
    const agent = promptAgent(scope)

    vscode.postMessage({
      type: "sendCommand",
      command,
      arguments: args,
      messageID,
      sessionID: sid,
      draftID,
      providerID,
      modelID,
      agent,
      variant: currentVariant(scope),
      files,
      agentManagerContext: context,
    })
  }

  function abort() {
    const sessionID = currentSessionID()
    if (!sessionID) {
      console.warn("[Kilo New] Cannot abort: no current session")
      return
    }

    vscode.postMessage({
      type: "abort",
      sessionID,
    })
  }

  function compact() {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot compact: not connected")
      return
    }

    const sessionID = currentSessionID()
    if (!sessionID) {
      console.warn("[Kilo New] Cannot compact: no current session")
      return
    }

    const sel = selected()
    vscode.postMessage({
      type: "compact",
      sessionID,
      providerID: sel?.providerID,
      modelID: sel?.modelID,
    })
  }

  function respondToPermission(
    permissionId: string,
    response: "once" | "always" | "reject",
    approvedAlways: string[],
    deniedAlways: string[],
  ) {
    // Resolve sessionID from the stored permission request
    const permission = permissions().find((p) => p.id === permissionId)
    const sessionID = permission?.sessionID ?? currentSessionID() ?? ""

    // Mark as responding so the UI disables the buttons.
    // The permission is removed when the server confirms via permission.replied SSE.
    setRespondingPermissions((prev) => new Set(prev).add(permissionId))

    vscode.postMessage({
      type: "permissionResponse",
      permissionId,
      sessionID,
      response,
      approvedAlways,
      deniedAlways,
    })
  }

  function clearQuestionError(requestID: string) {
    setQuestionErrors((prev) => {
      if (!prev.has(requestID)) return prev
      const next = new Set(prev)
      next.delete(requestID)
      return next
    })
  }

  function clearSuggestionError(requestID: string) {
    setSuggestionErrors((prev) => {
      if (!prev.has(requestID)) return prev
      const next = new Set(prev)
      next.delete(requestID)
      return next
    })
  }

  function replyToQuestion(requestID: string, answers: string[][]) {
    clearQuestionError(requestID)
    const question = questions().find((item) => item.id === requestID)
    const sessionID = question?.sessionID ?? currentSessionID() ?? ""
    vscode.postMessage({
      type: "questionReply",
      requestID,
      sessionID,
      answers,
    })
  }

  function rejectQuestion(requestID: string) {
    clearQuestionError(requestID)
    const question = questions().find((item) => item.id === requestID)
    const sessionID = question?.sessionID ?? currentSessionID() ?? ""
    vscode.postMessage({
      type: "questionReject",
      requestID,
      sessionID,
    })
  }

  function acceptSuggestion(requestID: string, index: number) {
    clearSuggestionError(requestID)
    setRespondingSuggestions((prev) => new Set(prev).add(requestID))
    const sid = suggestions().find((s) => s.id === requestID)?.sessionID ?? currentSessionID() ?? ""
    vscode.postMessage({
      type: "suggestionAccept",
      requestID,
      sessionID: sid,
      index,
    })
  }

  function dismissSuggestion(requestID: string) {
    clearSuggestionError(requestID)
    setRespondingSuggestions((prev) => new Set(prev).add(requestID))
    const sid = suggestions().find((s) => s.id === requestID)?.sessionID ?? currentSessionID() ?? ""
    vscode.postMessage({
      type: "suggestionDismiss",
      requestID,
      sessionID: sid,
    })
  }

  function createSession() {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot create session: not connected")
      return
    }

    // Reset agent selection to default for the new session (model overrides persist)
    setPendingAgentSelection(defaultAgent())
    vscode.postMessage({ type: "createSession" })
  }

  function clearCurrentSession() {
    setCurrentSessionID(undefined)
    setDraftSessionID(undefined)
    setCloudPreviewId(null)
    setLoading(false)
    setPendingAgentSelection(defaultAgent())
    vscode.postMessage({ type: "clearSession" })
  }

  function loadSessions() {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot load sessions: not connected")
      return
    }
    vscode.postMessage({ type: "loadSessions" })
  }

  function loadOlderMessages() {
    const id = currentSessionID()
    if (!id || !server.isConnected()) return
    const page = pages[id] ?? emptyPageState
    if (!page.hasMore || page.loadingOlder || page.loadingInitial || !page.before) return
    patchPage(id, { loadingOlder: true })
    vscode.postMessage({
      type: "loadMessages",
      sessionID: id,
      mode: "prepend",
      before: page.before,
      limit: MESSAGE_PAGE_LIMIT,
    })
  }

  /**
   * Move a session family's hydrated parts from the reactive store back into
   * the stash. Used on session switch to release the per-part reactive proxies
   * the previous session held without throwing away the data — when the user
   * comes back, the focus→reconcile path's sameReconcileShape() check stays
   * accurate (we don't touch store.messages), and the next VscodeSessionTurn
   * to render calls hydrateParts() to drain the stash back into the store.
   *
   * We don't dispose the family memos here on purpose: a permission/question
   * for a subagent of the parked session can still arrive and the scoped
   * derivations need to remain accurate. The BFS just sees an empty family
   * (no tool parts in the store) until re-hydration.
   */
  function parkSessionParts(sessionID: string) {
    const family = sessionFamily(sessionID)
    const toPark: Array<{ msgID: string; parts: Part[] }> = []
    for (const sid of family) {
      const msgs = store.messages[sid]
      if (!msgs) continue
      for (const msg of msgs) {
        const list = store.parts[msg.id]
        if (!list || list.length === 0) continue
        // Shallow snapshot — Solid's store proxies stay readable after the
        // entry is deleted, but we want a plain array for the stash to own.
        toPark.push({ msgID: msg.id, parts: [...list] })
      }
    }
    if (toPark.length === 0) {
      // Even when there's nothing to park, we still want to release the
      // family/scoped reactive memos for this session so they don't stay
      // subscribed to global signals across every other session visit.
      for (const sid of family) disposeFamilyMemosFor(sid)
      return
    }
    batch(() => {
      setStore(
        "parts",
        produce((parts) => {
          for (const { msgID } of toPark) delete parts[msgID]
        }),
      )
    })
    for (const { msgID, parts } of toPark) stash.put(msgID, parts)
    // Free the BFS + scoped memos for this session and any subagent in its
    // family — they're created lazily in getFamilyMemo/scopedPermissions/etc
    // on every session visit and, before this, only freed on session
    // *deletion*. Without this, navigating between 50 sessions accumulated
    // 50 detached Solid roots that re-ran BFS on every SSE batch.
    for (const sid of family) disposeFamilyMemosFor(sid)
  }

  function selectSession(id: string) {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot select session: not connected")
      return
    }
    if (id.startsWith("cloud:")) {
      console.warn("[Kilo New] Cannot select cloud preview session via selectSession")
      return
    }
    const prevID = currentSessionID()
    if (prevID && prevID !== id) {
      // Park the previous session's parts so its reactive subscriptions are
      // released. Skipped on no-op selects (same id) to avoid a needless
      // park/hydrate cycle on re-renders that re-call selectSession.
      parkSessionParts(prevID)
    }
    const ready = loaded().has(id)
    setCurrentSessionID(id)
    setDraftSessionID(id)
    setLoading(!ready)
    if (ready) {
      vscode.postMessage({ type: "loadMessages", sessionID: id, mode: "focus" })
      return
    }
    patchPage(id, { loadingInitial: true, loadingOlder: false, before: undefined, hasMore: false })
    vscode.postMessage({ type: "loadMessages", sessionID: id, mode: "replace", limit: MESSAGE_PAGE_LIMIT })
  }

  function selectCloudSession(cloudSessionId: string) {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot select cloud session: not connected")
      return
    }
    const key = `cloud:${cloudSessionId}`
    setCloudPreviewId(cloudSessionId)
    setCurrentSessionID(key)
    setDraftSessionID(key)
    setLoading(true)
    vscode.postMessage({ type: "requestCloudSessionData", sessionId: cloudSessionId })
  }

  function deleteSession(id: string) {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot delete session: not connected")
      return
    }
    // Optimistically remove from the list so the UI updates immediately
    setStore(
      "sessions",
      produce((sessions) => {
        delete sessions[id]
      }),
    )
    setLoaded((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    vscode.postMessage({ type: "deleteSession", sessionID: id })
  }

  function renameSession(id: string, title: string) {
    if (!server.isConnected()) {
      console.warn("[Kilo New] Cannot rename session: not connected")
      return
    }
    vscode.postMessage({ type: "renameSession", sessionID: id, title })
  }

  // Computed values
  const currentSession = () => {
    const id = currentSessionID()
    return id ? store.sessions[id] : undefined
  }

  const pageState = () => {
    const id = currentSessionID()
    return id ? (pages[id] ?? emptyPageState) : emptyPageState
  }

  const loadingOlderMessages = () => pageState().loadingOlder
  const hasOlderMessages = () => pageState().hasMore
  const messageMutation = () => pageState().lastMutation

  const messages = () => {
    const id = currentSessionID()
    return id ? store.messages[id] || [] : []
  }

  const getParts = (messageID: string) => {
    return store.parts[messageID] || stash.peek(messageID) || []
  }

  function hydrateParts(ids: string[]) {
    const pending = stash.take(ids, (id) => Boolean(store.parts[id]))
    if (Object.keys(pending).length === 0) return
    setStore(
      "parts",
      produce((p) => {
        for (const [id, parts] of Object.entries(pending)) p[id] = parts
      }),
    )
  }

  const allMessages = () => store.messages

  const allParts = () => store.parts

  const allStatusMap = () => statusMap as Record<string, SessionStatusInfo>

  const userMessages = createMemo<Message[]>(() => messages().filter((m) => m.role === "user"), [], {
    equals: arraysShallowEqual,
  })

  const revert = createMemo(() => {
    const id = currentSessionID()
    // revert can be null (cleared by unrevert) or undefined (never set) — treat both as "no revert"
    return id ? (store.sessions[id]?.revert ?? undefined) : undefined
  })

  const revertedCount = createMemo(() => {
    const boundary = revert()?.messageID
    if (!boundary) return 0
    return userMessages().filter((m) => m.id >= boundary).length
  })

  const summary = createMemo(() => {
    const id = currentSessionID()
    return id ? (store.sessions[id]?.summary ?? undefined) : undefined
  })

  function revertSession(messageID: string) {
    const id = currentSessionID()
    if (!id) return
    // Restore the reverted user message's prompt text into the input.
    // Dispatch as a window message so PromptInput picks it up via onMessage.
    const parts = store.parts[messageID]
    if (parts) {
      const text = parts
        .filter((p) => p.type === "text" && !(p as { synthetic?: boolean }).synthetic)
        .map((p) => (p as { text: string }).text ?? "")
        .join("")
      if (text) window.postMessage({ type: "setChatBoxMessage", text }, "*")
    }
    vscode.postMessage({ type: "revertSession", sessionID: id, messageID })
  }

  function unrevertSession() {
    const id = currentSessionID()
    if (!id) return
    // Clear the prompt input on full redo (matching TUI/desktop behavior)
    window.postMessage({ type: "setChatBoxMessage", text: "" }, "*")
    vscode.postMessage({ type: "unrevertSession", sessionID: id })
  }

  function syncSession(sessionID: string) {
    vscode.postMessage({ type: "syncSession", sessionID, parentSessionID: currentSessionID() })
  }

  const todos = () => {
    const id = currentSessionID()
    return id ? store.todos[id] || [] : []
  }

  const sessions = createMemo(() =>
    Object.values(store.sessions)
      .filter((s) => !s.id.startsWith("cloud:"))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
  )

  /**
   * Per-session **own cost** — reads `store.messages` for per-session
   * propagated totals and `store.sessions` for parent links so each
   * session's entry excludes the cost already propagated up from its
   * descendants by the CLI backend.
   */
  const familyCosts = createMemo<Map<string, number>>(() => {
    const id = currentSessionID()
    if (!id) return new Map()
    return buildFamilyCosts(sessionFamily(id), store.messages, store.sessions)
  })

  /** Child session labels — only reads store.parts (not message costs). */
  const familyLabels = createMemo<Map<string, string>>(() => {
    const id = currentSessionID()
    if (!id) return new Map()
    return buildFamilyLabels(sessionFamily(id), store.messages as any, store.parts as any)
  })

  /** Combined cost breakdown with labels. */
  const costBreakdown = createMemo<Array<{ label: string; cost: number }>>(() => {
    const id = currentSessionID()
    const costs = familyCosts()
    if (!id || costs.size === 0) return []
    return buildCostBreakdown(id, costs, familyLabels(), language.t("context.stats.thisSession"))
  })

  // Status text derived from last assistant message parts.
  //
  // The memo subscribes ONLY to fields computeStatus actually inspects
  // (.type, .tool, .synthetic, and — only when synthetic — .text). This
  // prevents streaming text-deltas to normal (non-synthetic) text parts
  // from re-running the memo and cascading to TaskHeader / DockPrompt
  // status surfaces. Without this gating, every text-delta invalidated
  // statusText even though the produced label was identical.
  const statusText = createMemo<string | undefined>(() => {
    if (status() === "idle") return undefined
    const fallback = language.t("ui.sessionTurn.status.consideringNextSteps")
    const id = currentSessionID()
    const msgs = messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "assistant") continue
      const parts = getParts(msgs[i].id)
      if (parts.length === 0) break
      const last = parts[parts.length - 1]
      const type = last.type
      const tool = (last as { tool?: string }).tool
      const synthetic = (last as { synthetic?: boolean }).synthetic
      // Only read .text when we know we'll inspect it (synthetic snapshot
      // detection). Text-deltas to non-synthetic parts won't track here.
      const text = synthetic && type === "text" ? (last as { text?: string }).text : undefined
      const raw = computeStatus({ type, tool, synthetic, text } as unknown as Part, language.t) ?? fallback
      // When delegating to a subagent and that subagent is blocked on a prompt,
      // replace the generic "Delegating work" label with a more informative one
      // so the user understands why nothing appears to be happening.
      if (raw === language.t("ui.sessionTurn.status.delegating")) {
        const scoped = scopedPermissions(id)
        if (scoped.length > 0) return language.t("ui.sessionTurn.status.delegatingWaitingPermission")
        const scopedQ = scopedQuestions(id)
        if (scopedQ.length > 0) return language.t("ui.sessionTurn.status.delegatingWaitingQuestion")
      }
      return raw
    }
    return fallback
  })

  const contextUsage = createMemo<ContextUsage | undefined>(() => {
    const msgs = messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant" || !m.tokens) continue
      const usage = calcContextUsage(m.tokens, undefined)
      if (usage.tokens === 0) continue
      const sel = selected()
      const model = sel ? provider.findModel(sel) : undefined
      const limit = model?.limit?.context ?? model?.contextLength
      return calcContextUsage(m.tokens, limit)
    }
    return undefined
  })

  const value: SessionContextValue = {
    currentSessionID,
    currentSession,
    setCurrentSessionID,
    sessions,
    status,
    statusInfo,
    statusText,
    busySince,
    loading,
    loadingOlderMessages,
    hasOlderMessages,
    messageMutation,
    messages,
    userMessages,
    getParts,
    isErrorHidden: (messageID: string) => hiddenErrors().has(messageID),
    hydrateParts,
    todos,
    permissions,
    respondingPermissions,
    questions,
    questionErrors,
    suggestions,
    suggestionErrors,
    respondingSuggestions,
    scopedPermissions,
    scopedQuestions,
    scopedSuggestions,
    selected,
    selectModel,
    hasModelOverride,
    clearModelOverride,
    costBreakdown,
    contextUsage,
    agents,
    allAgents,
    skills,
    refreshSkills,
    removeSkill,
    removeMode,
    removeMcp,
    mcpStatus,
    mcpLoading,
    connectMcp,
    disconnectMcp,
    authenticateMcp,
    refreshMcpStatus,
    selectedAgent: agentForScope,
    selectAgent,
    getSessionAgent: (sessionID: string) => store.agentSelections[sessionID] ?? defaultAgent(),
    getSessionModel: (sessionID: string) => {
      const override = store.sessionOverrides[sessionID]
      if (override) return override
      const agentName = store.agentSelections[sessionID] ?? defaultAgent()
      return resolveModel(agentName, store.modelSelections[agentName])
    },
    setSessionModel: (sessionID: string, providerID: string, modelID: string) => {
      // Only write per-session override — do NOT touch global modelSelections or
      // userSetAgents.  The override is what selected()/getSessionModel() actually
      // reads, and mutating the global map here is both redundant and harmful: the
      // agent may not yet be assigned (sendInitialMessage calls setSessionModel
      // before setSessionAgent), so the write would land on defaultAgent() and
      // corrupt the default mode's model for later sessions.
      const model = { providerID, modelID }
      setStore("sessionOverrides", sessionID, model)
    },
    setSessionAgent: (sessionID: string, name: string) => {
      setStore("agentSelections", sessionID, name)
    },
    setSessionVariant: (sessionID: string, providerID: string, modelID: string, value: string, agent?: string) => {
      const name = agent ?? store.agentSelections[sessionID] ?? defaultAgent()
      const key = variantKey({ providerID, modelID }, name, sessionID)
      setStore("variantSelections", key, value)
    },
    allMessages,
    allParts,
    allStatusMap,
    favoriteModels: () => store.favoriteModels,
    toggleFavorite,
    variantList,
    currentVariant,
    selectVariant,
    revert,
    revertedCount,
    summary,
    worktreeStats,
    revertSession,
    unrevertSession,
    sendMessage,
    sendCommand,
    abort,
    compact,
    respondToPermission,
    replyToQuestion,
    rejectQuestion,
    acceptSuggestion,
    dismissSuggestion,
    createSession,
    clearCurrentSession,
    loadSessions,
    loadOlderMessages,
    selectSession,
    deleteSession,
    renameSession,
    syncSession,
    cloudPreviewId,
    selectCloudSession,
    draftSessionID,
    setDraftSessionID,
  }

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error("useSession must be used within a SessionProvider")
  }
  return context
}
