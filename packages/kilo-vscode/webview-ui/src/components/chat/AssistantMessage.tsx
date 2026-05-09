/**
 * AssistantMessage component
 * Renders all parts of an assistant message as a flat list — no context grouping.
 * Unlike the upstream AssistantParts, this renders each read/glob/grep/list tool
 * individually for maximum verbosity in the VS Code sidebar context.
 *
 * Active questions render inline via QuestionDock; permissions are in the bottom dock.
 */

import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { Part, PART_MAPPING, ToolRegistry } from "@kilocode/kilo-ui/message-part"
import type { MessageFeedbackControls } from "@kilocode/kilo-ui/message-part"
import type {
  AssistantMessage as SDKAssistantMessage,
  Part as SDKPart,
  Message as SDKMessage,
  ToolPart,
} from "@kilocode/sdk/v2"
import { useData } from "@kilocode/kilo-ui/context/data"
import { useSession } from "../../context/session"
import { useDisplay } from "../../context/display"
import { useConfig } from "../../context/config"
import { snapshotProgress } from "../../context/session-utils"
import { QuestionDock } from "./QuestionDock"
import { SuggestBar } from "./SuggestBar"

const LARGE_PART_THRESHOLD = 12
const ASSISTANT_PART_ESTIMATE = 80
const ASSISTANT_PART_OVERSCAN = 3

const isFirefox = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("firefox")

// Tools that the upstream message-part renderer suppresses (returns null for).
// We render these ourselves via ToolRegistry when they complete,
// so the user can see what the AI set up.
export const UPSTREAM_SUPPRESSED_TOOLS = new Set(["todowrite", "todoread"])

function isRenderable(part: SDKPart): boolean {
  if (part.type === "tool") {
    const tool = (part as SDKPart & { tool: string }).tool
    const state = (part as SDKPart & { state: { status: string } }).state
    if (UPSTREAM_SUPPRESSED_TOOLS.has(tool)) {
      // Show todo parts only when completed (permissions are now in the dock)
      return state.status === "completed"
    }
    // Always render question tool parts — active ones get the inline QuestionDock
    return true
  }
  if (part.type === "text") return !snapshotProgress(part) && !!(part as SDKPart & { text: string }).text?.trim()
  if (part.type === "reasoning") return !!(part as SDKPart & { text: string }).text?.trim()
  return !!PART_MAPPING[part.type]
}

/**
 * Build a callID:messageID lookup map for a request list. The previous
 * matchToolRequest helper was called per-part inside two memos, doing an
 * O(Q) linear scan for every renderable part on every reactive tick — for
 * 80 parts × 4 questions that's 640 .find() walks per question keystroke.
 * Building the map once per dock change makes per-part lookup O(1).
 */
type ToolRequest<T = unknown> = { tool?: { callID: string; messageID: string } } & T

function buildToolRequestIndex<T extends { tool?: { callID: string; messageID: string } }>(
  name: string,
  requests: T[],
): Map<string, T> {
  const m = new Map<string, T>()
  for (const r of requests) {
    if (r.tool) m.set(`${name}:${r.tool.callID}:${r.tool.messageID}`, r)
  }
  return m
}

/** Look up a request by tool part. O(1) against an index built by buildToolRequestIndex. */
function lookupToolRequest<T>(part: SDKPart, name: string, index: Map<string, T>): T | undefined {
  if (part.type !== "tool") return undefined
  const tp = part as unknown as ToolPart
  if (tp.tool !== name) return undefined
  return index.get(`${name}:${tp.callID}:${tp.messageID}`)
}

interface AssistantMessageProps {
  message: SDKAssistantMessage
  showAssistantCopyPartID?: string | null
  feedback?: MessageFeedbackControls
}

// SAFETY: ToolRegistry.render returns a Component<unknown> that varies by tool;
// Dynamic dispatches at runtime by tool name. Local `any` typing here mirrors
// the upstream message-part renderer's type contract — narrowing further would
// require a discriminated union per tool name.
type ToolState = { input?: unknown; metadata?: unknown; output?: unknown; status?: string }

function TodoToolCard(props: { part: ToolPart }) {
  const render = ToolRegistry.render(props.part.tool)
  const state = props.part.state as ToolState
  return (
    <Show when={render}>
      {(renderFn) => (
        <Dynamic
          component={renderFn() as unknown as Component<Record<string, unknown>>}
          input={state?.input ?? {}}
          metadata={state?.metadata ?? {}}
          tool={props.part.tool}
          output={state?.output}
          status={state?.status}
          defaultOpen
          reveal={false}
        />
      )}
    </Show>
  )
}

function BashToolCard(props: { part: ToolPart; defaultOpen: boolean }) {
  const render = ToolRegistry.render(props.part.tool)
  const state = props.part.state as ToolState
  return (
    <Show when={render}>
      {(card) => (
        <Dynamic
          component={card() as unknown as Component<Record<string, unknown>>}
          input={state?.input ?? {}}
          metadata={state?.metadata ?? {}}
          partMetadata={props.part.metadata ?? {}}
          tool={props.part.tool}
          partID={props.part.id}
          callID={props.part.callID}
          output={state?.output}
          status={state?.status}
          defaultOpen={props.defaultOpen}
          animate
          reveal={state?.status === "pending" || state?.status === "running"}
        />
      )}
    </Show>
  )
}

type PartKind =
  | { kind: "question"; req: ToolRequest }
  | { kind: "suggest"; req: ToolRequest }
  | { kind: "bash" }
  | { kind: "todo" }
  | { kind: "default" }
  | { kind: "skip" }

interface PartRowProps {
  part: SDKPart
  message: SDKAssistantMessage
  showAssistantCopyPartID?: string | null
  feedback?: MessageFeedbackControls
  questionIndex: Map<string, ToolRequest>
  suggestionIndex: Map<string, ToolRequest>
  open: boolean
  reasoningAutoCollapse: boolean
}

/**
 * Per-part row component. Extracting this from inline JSX inside the
 * <For each={virtualItems}> callback gives each row its own owner — the
 * `classify` memo and any descendant effects dispose with the row when the
 * virtualizer recycles or unmounts it. Inline rendering would attach those
 * memos to the parent's owner and let them accumulate across scroll.
 */
const PartRow: Component<PartRowProps> = (props) => {
  const classify = createMemo<PartKind>(() => {
    const part = props.part
    const isUpstreamSuppressed =
      part.type === "tool" && UPSTREAM_SUPPRESSED_TOOLS.has((part as SDKPart & { tool: string }).tool)
    if (part.type === "tool") {
      const tp = part as unknown as ToolPart
      const q = lookupToolRequest(part, "question", props.questionIndex)
      if (q) return { kind: "question", req: q as ToolRequest }
      const s = lookupToolRequest(part, "suggest", props.suggestionIndex)
      if (s) return { kind: "suggest", req: s as ToolRequest }
      if (tp.tool === "bash" && tp.state?.status !== "error") return { kind: "bash" }
      if (isUpstreamSuppressed) return { kind: "todo" }
    }
    return PART_MAPPING[part.type] ? { kind: "default" } : { kind: "skip" }
  })

  return (
    <Show when={classify().kind !== "skip"}>
      <div data-component="tool-part-wrapper" data-part-type={props.part.type}>
        <Switch>
          <Match when={classify().kind === "question" && (classify() as { req: unknown }).req}>
            {(req) => <QuestionDock request={req() as never} />}
          </Match>
          <Match when={classify().kind === "suggest" && (classify() as { req: unknown }).req}>
            {(req) => <SuggestBar request={req() as never} />}
          </Match>
          <Match when={classify().kind === "bash"}>
            <BashToolCard part={props.part as unknown as ToolPart} defaultOpen={props.open} />
          </Match>
          <Match when={classify().kind === "todo"}>
            <TodoToolCard part={props.part as unknown as ToolPart} />
          </Match>
          <Match when={classify().kind === "default"}>
            <Part
              part={props.part}
              message={props.message as SDKMessage}
              showAssistantCopyPartID={props.showAssistantCopyPartID}
              reasoningAutoCollapse={props.reasoningAutoCollapse}
              feedback={props.feedback}
              animate={
                props.part.type === "tool" &&
                ((props.part as unknown as ToolPart).state?.status === "pending" ||
                  (props.part as unknown as ToolPart).state?.status === "running")
              }
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

interface VirtualPartRowProps extends PartRowProps {
  index: number
  start: number
  scrollMargin: number
  measureElement: (el: HTMLElement | null) => void
}

/**
 * Virtualized variant of PartRow — wraps PartRow in the absolutely-positioned
 * container the virtualizer expects and registers measureElement.
 *
 * Using a component (vs. inline JSX in the virtualizer's render callback)
 * isolates the row's reactive owner. Per-row memos and effects dispose
 * when the row unmounts, preventing accumulation across scroll.
 */
const VirtualPartRow: Component<VirtualPartRowProps> = (props) => {
  return (
    <div
      ref={(el) => props.measureElement(el)}
      data-index={props.index}
      data-slot="assistant-part-virtual-row"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${props.start - props.scrollMargin}px)`,
      }}
    >
      <PartRow
        part={props.part}
        message={props.message}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        feedback={props.feedback}
        questionIndex={props.questionIndex}
        suggestionIndex={props.suggestionIndex}
        open={props.open}
        reasoningAutoCollapse={props.reasoningAutoCollapse}
      />
    </div>
  )
}

export const AssistantMessage: Component<AssistantMessageProps> = (props) => {
  const data = useData()
  const session = useSession()
  const display = useDisplay()
  const { config } = useConfig()
  const open = createMemo(() => config().terminal_command_display !== "collapsed")
  const [root, setRoot] = createSignal<HTMLElement>()
  const [scrollMargin, setScrollMargin] = createSignal(0)

  const parts = createMemo(() => {
    const stored = data.store.part?.[props.message.id]
    if (!stored) return []
    return (stored as SDKPart[]).filter((part) => isRenderable(part))
  })

  const large = () => parts().length > LARGE_PART_THRESHOLD
  const scrollElement = () => root()?.closest(".message-list") as HTMLElement | null

  let frame: number | undefined
  const measureOffset = () => {
    const el = root()
    const scroll = scrollElement()
    if (!el || !scroll) return
    const rect = el.getBoundingClientRect()
    const scrollRect = scroll.getBoundingClientRect()
    setScrollMargin(Math.max(0, rect.top - scrollRect.top + scroll.scrollTop))
  }
  const scheduleMeasure = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      measureOffset()
    })
  }

  onMount(scheduleMeasure)
  createEffect(on(() => parts().length, scheduleMeasure))
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
    get count() {
      return large() ? parts().length : 0
    },
    getScrollElement: scrollElement,
    estimateSize: () => ASSISTANT_PART_ESTIMATE,
    get overscan() {
      return ASSISTANT_PART_OVERSCAN
    },
    get scrollMargin() {
      return scrollMargin()
    },
    measureElement: isFirefox
      ? undefined
      : (element) => element?.getBoundingClientRect().height ?? ASSISTANT_PART_ESTIMATE,
    getItemKey: (index) => parts()[index]?.id ?? index,
  })

  const virtualItems = createMemo(() => virtualizer.getVirtualItems())

  // Hoist the question/suggestion lookups to one Map per AssistantMessage
  // rather than allocating two createMemos per part per render. Previously
  // each renderPart() call subscribed to session.questions()/suggestions()
  // and did an O(Q) .find() — for an 80-part assistant message with a
  // 4-question dock that was 640 scans per question keystroke. Now: build
  // index once when the dock changes, O(1) lookup per part.
  const questionIndex = createMemo<Map<string, ToolRequest>>(
    () => buildToolRequestIndex("question", session.questions()) as Map<string, ToolRequest>,
  )
  const suggestionIndex = createMemo<Map<string, ToolRequest>>(
    () => buildToolRequestIndex("suggest", session.suggestions()) as Map<string, ToolRequest>,
  )

  return (
    <div ref={setRoot} data-component="assistant-message-parts" data-virtualized={large() ? "" : undefined}>
      <Show
        when={large()}
        fallback={
          <For each={parts()}>
            {(part) => (
              <PartRow
                part={part}
                message={props.message}
                showAssistantCopyPartID={props.showAssistantCopyPartID}
                feedback={props.feedback}
                questionIndex={questionIndex()}
                suggestionIndex={suggestionIndex()}
                open={open()}
                reasoningAutoCollapse={display.reasoningAutoCollapse()}
              />
            )}
          </For>
        }
      >
        <div
          data-slot="assistant-parts-virtual"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          <For each={virtualItems()}>
            {(item) => {
              const part = parts()[item.index]
              if (!part) return null
              return (
                <VirtualPartRow
                  part={part}
                  message={props.message}
                  showAssistantCopyPartID={props.showAssistantCopyPartID}
                  feedback={props.feedback}
                  questionIndex={questionIndex()}
                  suggestionIndex={suggestionIndex()}
                  open={open()}
                  reasoningAutoCollapse={display.reasoningAutoCollapse()}
                  index={item.index}
                  start={item.start}
                  scrollMargin={scrollMargin()}
                  measureElement={(el) => el && virtualizer.measureElement(el)}
                />
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
