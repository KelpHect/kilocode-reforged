/** @jsxImportSource solid-js */

/**
 * Chat performance fixtures.
 *
 * These stories exist to put load on the chat pipeline (virtualizer,
 * stableMessageTurns, sessionFamily memo, AssistantMessage rendering, the
 * autoScroll hook, etc.) so we can measure heap footprint, frame time, and
 * scroll smoothness with Chrome DevTools attached. They're not meant to look
 * pretty — the goal is realistic *shape* (mix of text / tool / reasoning
 * parts, varied lengths, occasional long blocks) at varying scale.
 *
 * The transcript generator is seeded so two runs of the same story produce
 * identical data — important if you want to compare a "before" and "after"
 * heap snapshot at the same scroll position.
 *
 * To benchmark:
 *   1. `bun --cwd packages/kilo-vscode storybook` (port 6007)
 *   2. Open the story
 *   3. Chrome DevTools → Performance → record while scrolling top↔bottom
 *   4. Chrome DevTools → Memory → heap snapshot at idle, mid-scroll, after
 *      session-switch (use the "Cycle 500-turn ↔ 100-turn" story for that)
 *
 * Targets per the optimization plan:
 *   - 500-turn fixture: <150MB heap peak, <30MB delta between snapshots
 *   - Sustained 60fps during fast scroll (no frames >16.6ms)
 *   - Streaming SSE replay: no UI freeze >50ms
 *   - Diff-heavy fixture: collapsed summaries do not mount diff viewers
 *   - Large-part fixture: assistant messages over 12 parts stay windowed
 */

import { createSignal, type Component } from "solid-js"
import type { Meta, StoryObj } from "storybook-solidjs-vite"
import { StoryProviders, defaultMockData, mockSessionValue } from "./StoryProviders"
import { MessageList } from "../components/chat/MessageList"
import { SessionContext } from "../context/session"
import type { Message, Part } from "../types/messages"

const SESSION_ID = "story-session-perf-001"

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic across runs so heap diffs are
// directly comparable.
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = [
  "the",
  "session",
  "store",
  "virtualizer",
  "reactive",
  "proxy",
  "stash",
  "hydrate",
  "render",
  "memo",
  "effect",
  "scroll",
  "viewport",
  "overscan",
  "prepend",
  "reconcile",
  "tool",
  "bash",
  "diff",
  "patch",
  "queue",
  "subagent",
  "permission",
  "question",
  "auto",
  "follow",
  "throttle",
  "debounce",
  "frame",
  "paint",
  "layout",
  "measure",
  "mount",
  "stable",
  "key",
  "index",
  "offset",
  "transform",
  "absolute",
  "container",
]

function lorem(rand: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    out.push(VOCAB[Math.floor(rand() * VOCAB.length)]!)
  }
  out[0] = (out[0]![0]!.toUpperCase() + out[0]!.slice(1)) as string
  return out.join(" ") + "."
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface GenOptions {
  /** Number of user→assistant turns. */
  turns: number
  /** Seed for deterministic output. */
  seed: number
  /**
   * Likelihood (0..1) that any given assistant turn includes a tool part.
   * Tool-heavy fixtures push past 0.7 to stress the tool-card render path.
   */
  toolDensity?: number
  /** Likelihood that a turn includes a reasoning block. */
  reasoningDensity?: number
  /** Likelihood that a user turn includes a diff summary. */
  diffDensity?: number
  /** Number of diff files to attach when a turn gets a summary. */
  diffsPerTurn?: number
  /** Every N turns, add a large burst of assistant parts to stress inner virtualization. */
  largePartEvery?: number
  /** Number of parts in each large assistant burst. */
  largePartCount?: number
}

interface Generated {
  messages: Message[]
  parts: Record<string, Part[]>
}

function generate(opts: GenOptions): Generated {
  const rand = rng(opts.seed)
  const toolP = opts.toolDensity ?? 0.4
  const reasoningP = opts.reasoningDensity ?? 0.2
  const diffP = opts.diffDensity ?? 0
  const diffsPerTurn = opts.diffsPerTurn ?? 3

  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}
  // Anchor "now" so timestamps look real but stay deterministic.
  const t0 = 1_700_000_000_000
  let cursor = t0

  for (let i = 0; i < opts.turns; i++) {
    cursor += 1000 + Math.floor(rand() * 4000)
    const userID = `perf-user-${i.toString().padStart(5, "0")}`
    const asstID = `perf-asst-${i.toString().padStart(5, "0")}`

    const userMessage: Message = {
      id: userID,
      sessionID: SESSION_ID,
      role: "user",
      createdAt: new Date(cursor).toISOString(),
      time: { created: cursor },
    }
    if (rand() < diffP) {
      userMessage.summary = { diffs: makeDiffs(i, diffsPerTurn) }
    }
    messages.push(userMessage)
    parts[userID] = [
      {
        id: `${userID}-text`,
        sessionID: SESSION_ID,
        messageID: userID,
        type: "text",
        text: lorem(rand, 4 + Math.floor(rand() * 12)),
      },
    ]

    cursor += 500
    messages.push({
      id: asstID,
      sessionID: SESSION_ID,
      role: "assistant",
      parentID: userID,
      createdAt: new Date(cursor).toISOString(),
      time: { created: cursor, completed: cursor + 2000 },
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      mode: "default",
      agent: "code",
      path: { cwd: "/project", root: "/project" },
    })

    const asstParts: Part[] = []

    if (rand() < reasoningP) {
      asstParts.push({
        id: `${asstID}-reasoning`,
        sessionID: SESSION_ID,
        messageID: asstID,
        type: "reasoning",
        text: lorem(rand, 30 + Math.floor(rand() * 60)),
      })
    }

    // Always at least one text part.
    asstParts.push({
      id: `${asstID}-text-1`,
      sessionID: SESSION_ID,
      messageID: asstID,
      type: "text",
      text: lorem(rand, 8 + Math.floor(rand() * 40)),
    })

    if (rand() < toolP) {
      const callID = `${asstID}-call-1`
      const cmd = ["pwd", "git status", "ls -la", "cat package.json"][Math.floor(rand() * 4)]!
      asstParts.push({
        id: `${asstID}-tool-1`,
        sessionID: SESSION_ID,
        messageID: asstID,
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: cmd, description: cmd },
          output: lorem(rand, 20 + Math.floor(rand() * 80)),
          title: cmd,
        },
      } as Part)

      // 30% chance of a follow-up text part summarizing the tool result.
      if (rand() < 0.3) {
        asstParts.push({
          id: `${asstID}-text-2`,
          sessionID: SESSION_ID,
          messageID: asstID,
          type: "text",
          text: lorem(rand, 12 + Math.floor(rand() * 30)),
        })
      }
      void callID
    }

    if (opts.largePartEvery && i % opts.largePartEvery === 0) {
      const count = opts.largePartCount ?? 24
      for (let j = 0; j < count; j++) {
        if (j % 4 === 0) {
          asstParts.push({
            id: `${asstID}-burst-tool-${j}`,
            sessionID: SESSION_ID,
            messageID: asstID,
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${j}`, description: `echo ${j}` },
              output: lorem(rand, 12 + Math.floor(rand() * 28)),
              title: `echo ${j}`,
            },
          } as Part)
          continue
        }
        asstParts.push({
          id: `${asstID}-burst-text-${j}`,
          sessionID: SESSION_ID,
          messageID: asstID,
          type: "text",
          text: lorem(rand, 10 + Math.floor(rand() * 25)),
        })
      }
    }

    parts[asstID] = asstParts
  }

  return { messages, parts }
}

function makeDiffs(turn: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const file = `src/perf/turn-${turn.toString().padStart(4, "0")}/file-${i}.ts`
    return {
      file,
      patch: [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1,3 +1,4 @@",
        ` const turn = ${turn}`,
        `-export const before${i} = "old-${turn}-${i}"`,
        `+export const before${i} = "new-${turn}-${i}"`,
        `+export const added${i} = "extra-${turn}-${i}"`,
        " console.log(turn)",
        "",
      ].join("\n"),
      additions: 2,
      deletions: 1,
      status: "modified" as const,
    }
  })
}

// ---------------------------------------------------------------------------
// Story scaffold
// ---------------------------------------------------------------------------

const meta: Meta = {
  title: "Chat / Performance",
  parameters: { layout: "fullscreen" },
}
export default meta
type Story = StoryObj

interface PerfFixtureProps {
  turns: number
  seed: number
  toolDensity?: number
  reasoningDensity?: number
  diffDensity?: number
  diffsPerTurn?: number
  largePartEvery?: number
  largePartCount?: number
  height?: string
}

const PerfFixture: Component<PerfFixtureProps> = (props) => {
  // generate() is pure — derive once at render time. (Storybook re-mounts on
  // controls change, so we don't need a memo here.)
  const { messages, parts } = generate({
    turns: props.turns,
    seed: props.seed,
    toolDensity: props.toolDensity,
    reasoningDensity: props.reasoningDensity,
    diffDensity: props.diffDensity,
    diffsPerTurn: props.diffsPerTurn,
    largePartEvery: props.largePartEvery,
    largePartCount: props.largePartCount,
  })

  const data = {
    ...defaultMockData,
    message: { [SESSION_ID]: messages },
    part: parts,
  }

  const session = {
    ...mockSessionValue({ id: SESSION_ID, status: "idle" }),
    messages: () => messages,
    userMessages: () => messages.filter((m) => m.role === "user"),
    getParts: (id: string) => parts[id] ?? [],
  }

  return (
    <StoryProviders data={data} sessionID={SESSION_ID} status="idle" noPadding>
      <SessionContext.Provider value={session as any}>
        <div
          style={{
            height: props.height ?? "100vh",
            display: "flex",
            "flex-direction": "column",
          }}
        >
          <MessageList />
        </div>
      </SessionContext.Provider>
    </StoryProviders>
  )
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Turns100: Story = {
  name: "100 turns — baseline",
  render: () => <PerfFixture turns={100} seed={42} />,
}

export const Turns500: Story = {
  name: "500 turns — primary target",
  render: () => <PerfFixture turns={500} seed={42} />,
}

export const Turns1000: Story = {
  name: "1000 turns — stress",
  render: () => <PerfFixture turns={1000} seed={42} />,
}

export const Turns500ToolHeavy: Story = {
  name: "500 turns — tool-heavy",
  render: () => <PerfFixture turns={500} seed={42} toolDensity={0.85} reasoningDensity={0.4} />,
}

export const Turns500DiffHeavy: Story = {
  name: "500 turns — diff-heavy",
  render: () => <PerfFixture turns={500} seed={42} diffDensity={0.85} diffsPerTurn={3} />,
}

export const Turns500LargeAssistantParts: Story = {
  name: "500 turns — large assistant parts",
  render: () => (
    <PerfFixture
      turns={500}
      seed={42}
      toolDensity={0.75}
      reasoningDensity={0.35}
      largePartEvery={2}
      largePartCount={24}
    />
  ),
}

// ---------------------------------------------------------------------------
// Session-switch cycle: simulates the "switch A → B → A" workflow that
// Phase 1.2's parkSessionParts cleanup is supposed to handle. Click the
// button to swap sessions; do this a few times with DevTools' heap profiler
// open to verify reactive proxies are released across switches.
// ---------------------------------------------------------------------------

const SessionSwitchHarness: Component = () => {
  const { messages: aMessages, parts: aParts } = generate({ turns: 500, seed: 42 })
  const { messages: bMessages, parts: bParts } = generate({ turns: 100, seed: 4242 })

  const SESSION_A = "story-session-perf-A"
  const SESSION_B = "story-session-perf-B"

  // Re-key messages to per-session IDs so the two transcripts don't collide.
  const reKey = (msgs: Message[], parts: Record<string, Part[]>, sid: string) => {
    const newParts: Record<string, Part[]> = {}
    const newMsgs = msgs.map((m) => {
      const newID = `${sid}-${m.id}`
      const oldParts = parts[m.id] ?? []
      newParts[newID] = oldParts.map((p) => ({ ...p, sessionID: sid, messageID: newID }))
      return {
        ...m,
        id: newID,
        sessionID: sid,
        parentID: m.parentID ? `${sid}-${m.parentID}` : undefined,
      }
    })
    return { messages: newMsgs, parts: newParts }
  }

  const a = reKey(aMessages, aParts, SESSION_A)
  const b = reKey(bMessages, bParts, SESSION_B)

  const [active, setActive] = createSignal<string>(SESSION_A)

  const messagesFor = () => (active() === SESSION_A ? a.messages : b.messages)
  const partsFor = () => (active() === SESSION_A ? a.parts : b.parts)

  const data = () => ({
    ...defaultMockData,
    message: {
      [SESSION_A]: a.messages,
      [SESSION_B]: b.messages,
    },
    part: { ...a.parts, ...b.parts },
  })

  const session = () => ({
    ...mockSessionValue({ id: active(), status: "idle" }),
    currentSessionID: active,
    messages: messagesFor,
    userMessages: () => messagesFor().filter((m) => m.role === "user"),
    getParts: (id: string) => partsFor()[id] ?? [],
  })

  return (
    <StoryProviders data={data()} sessionID={active()} status="idle" noPadding>
      <SessionContext.Provider value={session() as any}>
        <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
          <div style={{ padding: "8px", "border-bottom": "1px solid var(--vscode-panel-border)" }}>
            <button
              onClick={() => setActive((s) => (s === SESSION_A ? SESSION_B : SESSION_A))}
              style={{ padding: "4px 12px" }}
            >
              Switch to {active() === SESSION_A ? "B (100 turns)" : "A (500 turns)"}
            </button>
            <span style={{ "margin-left": "12px", "font-family": "monospace", "font-size": "12px" }}>
              Active: {active()}
            </span>
          </div>
          <MessageList />
        </div>
      </SessionContext.Provider>
    </StoryProviders>
  )
}

export const SessionSwitchCycle: Story = {
  name: "Session switch — 500 ↔ 100 turns",
  render: () => <SessionSwitchHarness />,
}
