/**
 * TaskTimeline — horizontal strip of colored bars representing session activity.
 *
 * Each bar = one Part from assistant messages.
 * Color  = part type (read=blue, write=dark blue, tool=indigo, error=red, text=gray).
 * Width  = proportional to time between parts.
 * Height = proportional to content length.
 *
 * Interactions: drag scroll, mouse wheel, auto-scroll to latest.
 *
 * No virtualization needed: SolidJS <Index> creates each element once and
 * updates bindings in place (unlike React). Even 1000+ bars are fine.
 */

import { Component, Index, createMemo, createEffect, on, onCleanup, onMount } from "solid-js"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useSession } from "../../context/session"
import { color, label } from "../../utils/timeline/colors"
import { sizes, MAX_HEIGHT } from "../../utils/timeline/sizes"
import type { Part, Message } from "../../types/messages"

export interface TimelineBar {
  bg: string
  tip: string
  width: number
  height: number
  idx: number
}

function buildBars(parts: Part[]): TimelineBar[] {
  const sz = sizes(parts)
  return parts.map((p, i) => ({
    bg: color(p),
    tip: label(p),
    width: sz[i]!.width,
    height: sz[i]!.height,
    idx: i,
  }))
}

export const TaskTimeline: Component = () => {
  const session = useSession()
  let ref: HTMLDivElement | undefined
  let dragging = false
  let startX = 0
  let startScroll = 0

  const messages = () => session.messages()

  // Walk session messages once and emit the timeline parts in order. This
  // memo's reactive deps are: the message list itself + per-message
  // store.parts[m.id]. Solid only invalidates when those *specific* entries
  // change — text-delta updates within a part don't touch any field this
  // memo reads, so streaming text never triggers a bar recompute. New tool
  // parts (which DO show up as new bars) bump the parts array length and
  // correctly invalidate.
  const rawParts = createMemo(() => {
    const msgs = messages()
    const result: Part[] = []
    for (const msg of msgs) {
      if (msg.role === "user") continue
      const ps = session.getParts(msg.id)
      for (const p of ps) {
        if (p.type === "step-start") continue
        result.push(p)
      }
    }
    return result
  })

  // Visual mapping is its own memo so it only recomputes when the part list
  // actually changes shape, not on every reactive tick of unrelated state.
  const bars = createMemo(() => buildBars(rawParts()))
  const busy = () => session.status() === "busy"

  // Auto-scroll to the latest bar when new bars appear
  let prev = 0
  createEffect(
    on(
      () => bars().length,
      (len) => {
        if (len > prev && ref) {
          ref.scrollLeft = ref.scrollWidth
        }
        prev = len
      },
    ),
  )

  // ── Drag scroll ──────────────────────────────────────────────────
  const onPointerDown = (e: PointerEvent) => {
    if (!ref) return
    dragging = true
    startX = e.clientX
    startScroll = ref.scrollLeft
    ref.setPointerCapture(e.pointerId)
    ref.style.cursor = "grabbing"
    ref.style.userSelect = "none"
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || !ref) return
    ref.scrollLeft = startScroll - (e.clientX - startX)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!ref) return
    dragging = false
    ref.releasePointerCapture(e.pointerId)
    ref.style.cursor = "grab"
    ref.style.userSelect = ""
  }

  // ── Wheel → horizontal scroll ────────────────────────────────────
  const onWheel = (e: WheelEvent) => {
    if (!ref) return
    e.preventDefault()
    ref.scrollLeft += e.deltaY || e.deltaX
  }

  // Bind once at mount — onMount avoids the subtle createEffect pattern where a
  // future maintainer could accidentally introduce a reactive read inside the
  // body, which would silently churn add/remove listeners.
  onMount(() => {
    if (!ref) return
    ref.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => ref?.removeEventListener("wheel", onWheel))
  })

  return (
    <div class="task-timeline-outer">
      <div
        ref={ref}
        class="task-timeline"
        style={{ height: `${MAX_HEIGHT}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Index each={bars()}>
          {(bar) => {
            const active = () => busy() && bar().idx === bars().length - 1
            return (
              <Tooltip value={bar().tip} placement="top">
                <div
                  class="task-timeline-bar"
                  style={{
                    width: `${bar().width}px`,
                    height: `${MAX_HEIGHT}px`,
                  }}
                >
                  <div
                    class="task-timeline-bar-fill task-timeline-bar-fill--new"
                    classList={{
                      "task-timeline-bar-fill--active": active(),
                    }}
                    style={{
                      background: bar().bg,
                      height: `${(bar().height / MAX_HEIGHT) * 100}%`,
                    }}
                  />
                </div>
              </Tooltip>
            )
          }}
        </Index>
      </div>
    </div>
  )
}
