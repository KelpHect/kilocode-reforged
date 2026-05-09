/** @jsxImportSource solid-js */

/**
 * MessageList component
 * Scrollable turn-based message list with virtualization.
 * Each user message is rendered as a VscodeSessionTurn — a custom component that
 * renders all assistant parts as a flat, verbose list with no context grouping,
 * and fully expands sub-agent (task tool) parts inline.
 * Shows recent sessions in the empty state for quick resumption.
 */

import { type Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup, JSX } from "solid-js"
import { debounce, leadingAndTrailing, throttle } from "@solid-primitives/scheduled"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { createAutoScroll } from "@kilocode/kilo-ui/hooks"
import { useSession } from "../../context/session"
import { useServer } from "../../context/server"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
import { FeedbackDialog } from "./FeedbackDialog"
import { VscodeSessionTurn } from "./VscodeSessionTurn"
import { RevertBanner } from "./RevertBanner"
import { AccountSwitcher } from "../shared/AccountSwitcher"
import { KiloNotifications } from "./KiloNotifications"
import { WorkingIndicator } from "../shared/WorkingIndicator"
import { QuestionDock } from "./QuestionDock"
import { MessageVirtualizer } from "./MessageVirtualizer"
import { SuggestBar } from "./SuggestBar"
import {
  activeUserMessageID as getActiveUserMessageID,
  messageTurns,
  queuedUserMessageIDs,
  stableMessageTurns,
  type MessageTurn,
} from "../../context/session-queue"
import type { QuestionRequest, SuggestionRequest } from "../../types/messages"

/**
 * Compact placeholder for queued user turns. Queued turns haven't been
 * dispatched to the assistant yet, so they have no parts beyond the user's
 * own input. Mounting a full VscodeSessionTurn for each was wasteful — its
 * AssistantMessage tree (with its inner virtualizer + many reactive memos)
 * runs even though there's nothing to render. A flat card is enough until
 * the turn becomes active and gets re-rendered through the virtualizer.
 */
const QueuedTurnCard: Component<{ turn: MessageTurn }> = (props) => {
  const text = createMemo(() => {
    const parts = props.turn.user.parts ?? []
    let out = ""
    for (const p of parts) {
      if (p.type === "text") out += p.text
    }
    return out.trim()
  })
  return (
    <div data-component="queued-turn-card" data-slot="queued-turn-card">
      <Icon name="clock" size="small" />
      <span data-slot="queued-turn-card-text">{text()}</span>
    </div>
  )
}

const KiloLogo = (): JSX.Element => {
  const iconsBaseUri = (window as { ICONS_BASE_URI?: string }).ICONS_BASE_URI || ""
  const isLight =
    document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light")
  const iconFile = isLight ? "kilo-light.svg" : "kilo-dark.svg"

  return (
    <div class="kilo-logo">
      <img src={`${iconsBaseUri}/${iconFile}`} alt="Kilo Code" />
    </div>
  )
}

interface MessageListProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
  onForkMessage?: (sessionId: string, messageId: string) => void
  /** Non-tool question requests to render inline at the bottom of the message list */
  questions?: () => QuestionRequest[]
  /** Non-tool suggestion requests to render inline at the bottom of the message list */
  suggestions?: () => SuggestionRequest[]
  /** When true (subagent viewer), replace the welcome screen with an initializing indicator */
  readonly?: boolean
}

export const MessageList: Component<MessageListProps> = (props) => {
  const session = useSession()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()

  const autoScroll = createAutoScroll({
    working: () => session.status() !== "idle",
  })

  // Resume auto-scroll when a bottom-dock permission/question is dismissed
  const onResumeAutoScroll = () => autoScroll.resume()
  window.addEventListener("resumeAutoScroll", onResumeAutoScroll)
  onCleanup(() => window.removeEventListener("resumeAutoScroll", onResumeAutoScroll))

  let loaded = false
  createEffect(() => {
    if (!loaded && server.isConnected() && session.sessions().length === 0) {
      loaded = true
      session.loadSessions()
    }
  })

  const [scrollEl, setScrollEl] = createSignal<HTMLElement>()
  // FIFO-bounded — `positions` previously grew with every visited session for
  // the lifetime of the webview. Map iteration preserves insertion order, so
  // we evict the oldest entry once we exceed POSITION_LIMIT.
  const POSITION_LIMIT = 50
  const positions = new Map<string, { top: number; userScrolled: boolean }>()

  const boundary = () => session.revert()?.messageID

  // One memo computes the entire turn-derived view (full list, visible/queued
  // partition, active user ID) instead of the prior 5-memo chain. Each
  // separate memo allocated a fresh array/Set on every recompute and fanned
  // out to the next, so a single SSE part change cascaded through 4 O(n)
  // filters even when the *content* of the partition was unchanged. Here we
  // compute everything in one pass and short-circuit (return `prev`) when
  // every relevant input matches the previous tick — Solid then skips
  // notifying every downstream consumer (virtualizer included). Streaming
  // text deltas (which never affect the partition) become a no-op past this
  // memo boundary.
  interface TurnMeta {
    all: MessageTurn[]
    visible: MessageTurn[]
    queued: MessageTurn[]
    activeID: string | undefined
    /** Index of activeID inside `visible`. -1 if no active turn or not in visible.
     *  Computed inline during the partition loop so consumers don't pay a separate
     *  `findIndex` on every active-id change. */
    activeIndex: number
    /** Internal: prior queuedIDs snapshot used for short-circuit comparison. */
    _queuedIDs: string[]
  }

  const sameStringArrays = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  const turnMeta = createMemo<TurnMeta>((prev) => {
    const msgs = session.messages()
    const status = session.statusInfo()
    const b = boundary()

    const all = stableMessageTurns(messageTurns(msgs, b), prev?.all)
    const queuedIDsArr = queuedUserMessageIDs(msgs, status)
    const activeID = getActiveUserMessageID(msgs, status)

    // Short-circuit: if every input that affects the partition matches the
    // previous result (turn array identity preserved by stableMessageTurns,
    // queued IDs unchanged, active ID unchanged), reuse the entire prev
    // object. Reference equality short-circuits all downstream memos.
    if (
      prev &&
      prev.all === all &&
      prev.activeID === activeID &&
      sameStringArrays(prev._queuedIDs, queuedIDsArr)
    ) {
      return prev
    }

    const queuedSet = new Set(queuedIDsArr)
    const visible: MessageTurn[] = []
    const queued: MessageTurn[] = []
    let activeIndex = -1
    for (const turn of all) {
      if (queuedSet.has(turn.user.id)) queued.push(turn)
      else {
        if (turn.user.id === activeID) activeIndex = visible.length
        visible.push(turn)
      }
    }
    return { all, visible, queued, activeID, activeIndex, _queuedIDs: queuedIDsArr }
  })

  const turns = () => turnMeta().all
  const visibleTurns = () => turnMeta().visible
  const queuedTurns = () => turnMeta().queued
  const activeUserID = () => turnMeta().activeID

  const isEmpty = () => turns().length === 0 && !session.loading() && !boundary()

  // session.sessions() is already sorted updatedAt-desc by the SessionProvider;
  // re-sorting allocated and sorted a 1200-element array on every welcome render.
  const recent = createMemo(() => session.sessions().slice(0, 3))

  // Sourced directly from turnMeta's single-pass partition — no separate
  // findIndex over visibleTurns on every recompute.
  const activeUserIndex = () => turnMeta().activeIndex

  const save = (id: string | undefined) => {
    const el = scrollEl()
    if (!id || !el) return
    // Re-set bumps insertion order; trim oldest if we exceed the cap.
    if (positions.has(id)) positions.delete(id)
    positions.set(id, { top: el.scrollTop, userScrolled: autoScroll.userScrolled() })
    if (positions.size > POSITION_LIMIT) {
      const first = positions.keys().next().value
      if (first) positions.delete(first)
    }
  }

  const maybeLoadOlder = () => {
    const el = scrollEl()
    if (!el || el.scrollTop > 600) return
    session.loadOlderMessages()
  }

  // Scroll fires faster than the renderer can usefully respond — easily
  // 100+ events/sec on a fast wheel/trackpad. Two distinct schedules:
  //
  //   - autoScroll bookkeeping is throttled to ~60fps with leading-and-
  //     trailing edges. The leading edge keeps the response feeling
  //     immediate (the user-scrolled flag flips on the first event of a
  //     gesture, not 16ms later); the trailing edge guarantees we observe
  //     the final scrollTop when the gesture ends.
  //   - maybeLoadOlder triggers a network fetch, so we debounce it (no
  //     leading edge) to coalesce a burst of events into one decision
  //     once the user pauses near the top.
  //
  // @solid-primitives/scheduled clears its internal timer on root dispose,
  // so we don't need an explicit onCleanup.
  const throttledAutoScroll = leadingAndTrailing(throttle, () => autoScroll.handleScroll(), 16)
  const debouncedMaybeLoadOlder = debounce(() => maybeLoadOlder(), 250)

  const handleScroll = () => {
    throttledAutoScroll()
    debouncedMaybeLoadOlder()
  }

  const setScrollRef = (el: HTMLElement | undefined) => {
    setScrollEl(el)
    autoScroll.scrollRef(el)
  }

  const [pendingRestore, setPendingRestore] = createSignal<string>()

  createEffect(
    on(session.currentSessionID, (id, prev) => {
      save(prev)
      setPendingRestore(id)
    }),
  )

  createEffect(() => {
    const id = pendingRestore()
    if (!id || session.loading()) return
    turns().length
    // Double-rAF: the first frame lets the browser paint the new DOM from
    // the messagesLoaded batch. The second frame restores scroll position
    // without forcing a synchronous layout reflow mid-paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pendingRestore() !== id) return
        const el = scrollEl()
        if (!el) return
        const pos = positions.get(id)
        if (pos?.userScrolled) {
          el.scrollTop = pos.top
          autoScroll.pause()
          maybeLoadOlder()
        } else {
          autoScroll.forceScrollToBottom()
        }
        setPendingRestore(undefined)
      })
    })
  })

  onCleanup(() => save(session.currentSessionID()))

  return (
    <div class="message-list-container">
      <Show when={isEmpty()}>
        <div class="welcome-header">
          <AccountSwitcher class="account-switcher-welcome" />
          <KiloNotifications />
        </div>
      </Show>
      <div ref={setScrollRef} onScroll={handleScroll} class="message-list" role="log" aria-live="polite">
        <div ref={autoScroll.contentRef} class={isEmpty() ? "message-list-content-empty" : "message-list-content"}>
          <Show when={session.loading()}>
            <div class="message-list-loading" role="status">
              <Spinner />
              <span>{language.t("session.messages.loading")}</span>
            </div>
          </Show>
          <Show when={isEmpty() && props.readonly}>
            <div class="message-list-empty">
              <p class="kilo-about-text">{language.t("session.messages.initializing")}</p>
            </div>
          </Show>
          <Show when={isEmpty() && !props.readonly}>
            <div class="message-list-empty">
              <KiloLogo />
              <p class="kilo-about-text">{language.t("session.messages.welcome")}</p>
              <Show when={recent().length > 0 && props.onSelectSession}>
                <div class="recent-sessions">
                  <span class="recent-sessions-label">{language.t("session.recent")}</span>
                  <For each={recent()}>
                    {(s) => (
                      <button class="recent-session-item" onClick={() => props.onSelectSession?.(s.id)}>
                        <span class="recent-session-title">{s.title || language.t("session.untitled")}</span>
                        <span class="recent-session-date">{formatRelativeDate(s.updatedAt)}</span>
                      </button>
                    )}
                  </For>
                  <Show when={props.onShowHistory}>
                    <button class="show-history-btn" onClick={() => props.onShowHistory?.()}>
                      <Icon name="history" size="small" />
                      {language.t("session.showHistory")}
                    </button>
                  </Show>
                </div>
              </Show>
              <button class="feedback-button" onClick={() => dialog.show(() => <FeedbackDialog />)}>
                <Icon name="bubble-5" size="small" />
                {language.t("feedback.button")}
              </button>
            </div>
          </Show>
          <Show when={!session.loading() && !isEmpty()}>
            <Show when={session.loadingOlderMessages()}>
              <div class="message-list-page-loader" role="status">
                <Spinner />
                <span>{language.t("session.messages.loadingEarlier")}</span>
              </div>
            </Show>
            <Show when={session.hasOlderMessages() && !session.loadingOlderMessages()}>
              <button class="message-list-load-older" onClick={() => session.loadOlderMessages()}>
                {language.t("session.messages.loadEarlier")}
              </button>
            </Show>
            <Show when={scrollEl()}>
              <MessageVirtualizer
                data={visibleTurns()}
                scrollRef={scrollEl()}
                shift={session.messageMutation() === "prepend"}
                overscan={12}
                itemSize={260}
                getItemKey={(_, turn) => turn.user.id}
              >
                {(turn, index) => {
                  const queued = createMemo(() => {
                    const active = activeUserIndex()
                    if (active === -1) return false
                    return index() > active
                  })

                  return <VscodeSessionTurn turn={turn} queued={queued()} onForkMessage={props.onForkMessage} />
                }}
              </MessageVirtualizer>
            </Show>
            <Show when={boundary()}>
              <RevertBanner />
            </Show>
            {/* Queued turns haven't run yet — they have no assistant content
                to render. The full VscodeSessionTurn mount-cost (AssistantMessage
                tree, virtualizer scaffold, reactive subscriptions) is wasted
                for every empty queued slot. Render a compact placeholder card
                instead so a 20-deep queue doesn't drag down session-switch. */}
            <For each={queuedTurns()}>{(turn) => <QueuedTurnCard turn={turn} />}</For>
            <WorkingIndicator />
            <For each={props.questions?.()}>{(req) => <QuestionDock request={req} />}</For>
            <For each={props.suggestions?.()}>{(req) => <SuggestBar request={req} />}</For>
          </Show>
        </div>
      </div>

      <Show when={autoScroll.userScrolled()}>
        <button
          class="scroll-to-bottom-button"
          onClick={() => autoScroll.resume()}
          aria-label={language.t("session.messages.scrollToBottom")}
        >
          <Icon name="arrow-down-to-line" />
        </button>
      </Show>
    </div>
  )
}
