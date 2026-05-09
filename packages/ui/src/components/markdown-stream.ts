import { marked, type Token, type Tokens } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live"
}

function refs(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

/**
 * Token types whose `raw` byte sequence is reliably stable once emitted.
 * Marked emits these strictly left-to-right — once a paragraph or heading
 * token closes (paragraph by `\n\n`, heading by `\n`), no future content
 * can re-open and extend it.
 *
 * NOT stable across appends: list, table, html, def (the lexer may merge
 * continuation lines into earlier tokens). Anything in those types stays in
 * the head as a single chunk to preserve correctness over speed.
 */
function isStableBlockType(type: Token["type"]): boolean {
  return (
    type === "paragraph" ||
    type === "heading" ||
    type === "code" ||
    type === "hr" ||
    type === "blockquote" ||
    type === "space"
  )
}

function allStable(tokens: Token[]): boolean {
  for (let i = 0; i < tokens.length; i++) if (!isStableBlockType(tokens[i].type)) return false
  return true
}

export function stream(text: string, live: boolean) {
  if (!live) return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  const src = heal(text)
  if (refs(text)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src, mode: "live" }] satisfies Block[]

  // Path 1: unclosed code block as the tail — preserved from the original
  // implementation. `open()` distinguishes a streaming code block from a
  // fully-closed one so we don't churn the cache when the closing fence
  // arrives later.
  if (last.type === "code") {
    const code = last as Tokens.Code
    if (!open(code.raw)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
    const head = tokens
      .slice(0, tail)
      .map((token) => token.raw)
      .join("")
    if (!head) return [{ raw: code.raw, src: code.raw, mode: "live" }] satisfies Block[]
    return [
      { raw: head, src: heal(head), mode: "live" },
      { raw: code.raw, src: code.raw, mode: "live" },
    ] satisfies Block[]
  }

  // Path 2: peel a stable head off when ALL preceding tokens are types whose
  // raw bytes don't shift on append (paragraph, heading, code, hr, blockquote,
  // space). The tail token itself is always treated as live — it's the one
  // currently being extended. This produces cache hits on the head across
  // all deltas within the live token, instead of re-parsing the entire
  // accumulated transcript per delta.
  //
  // Skipping when an unstable block type (list/table/html/def) appears
  // anywhere in the head is intentional: those types let later content
  // merge into earlier tokens and a stable byte-prefix split would produce
  // wrong HTML at boundaries.
  if (tail > 0 && isStableBlockType(last.type) && allStable(tokens.slice(0, tail))) {
    const head = tokens
      .slice(0, tail)
      .map((token) => token.raw)
      .join("")
    if (head) {
      const tailRaw = last.raw
      return [
        { raw: head, src: heal(head), mode: "live" },
        { raw: tailRaw, src: heal(tailRaw), mode: "live" },
      ] satisfies Block[]
    }
  }

  return [{ raw: text, src, mode: "live" }] satisfies Block[]
}
