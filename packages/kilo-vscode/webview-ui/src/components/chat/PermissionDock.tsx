/**
 * PermissionDock component
 * Displays permission requests from the AI assistant in the dock above the prompt input.
 * Uses kilo-ui's DockPrompt component for proper surface styling.
 *
 * Per-rule toggles allow users to approve/deny individual permission rules for future requests.
 * For bash, the hierarchical rules from metadata.rules are shown.
 * For other tools, the always array is shown so users can configure per-tool permissions.
 * The command buttons (Deny / Run) control the current command.
 */

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { Button } from "@kilocode/kilo-ui/button"
import { DockPrompt } from "@kilocode/kilo-ui/dock-prompt"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useConfig } from "../../context/config"
import { describePatterns, resolveLabel, savedRuleStates, type RuleDecision } from "./permission-dock-utils"
import { PermissionCommand } from "./PermissionCommand"
import { PermissionDiff } from "./PermissionDiff"
import { permissionDiffs } from "./permission-diff-utils"
import type { PermissionRequest } from "../../types/messages"

let rulesExpandedPreference = false
const RULE_VIRTUAL_THRESHOLD = 50
const RULE_ESTIMATE_SIZE = 28

export const PermissionDock: Component<{
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "reject", approvedAlways: string[], deniedAlways: string[]) => void
}> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const { config } = useConfig()

  const fromChild = () => props.request.sessionID !== session.currentSessionID()
  // Bash sends fine-grained rules via metadata.rules; other tools use the always array.
  const rules = () => props.request.args?.rules ?? props.request.always ?? []
  // Rules like "git *" or "git log *" — strip the trailing wildcard for display.
  // A bare "*" (global wildcard) becomes empty so only the tool name shows.
  const label = (rule: string) => (rule === "*" ? "" : rule.replace(/ \*$/, ""))
  const command = () => {
    const cmd = props.request.args?.command
    return typeof cmd === "string" ? cmd : undefined
  }
  const description = createMemo(() =>
    command() ? null : describePatterns(props.request.toolName, props.request.patterns, language.t),
  )

  const diffs = createMemo(() => permissionDiffs(props.request))

  // Pre-populate toggle states from existing config rules so previously
  // approved/denied patterns show their saved state immediately.
  //
  // Backed by createStore (not createSignal) so that toggling rule N only
  // invalidates the subscribers that actually read `decisions[N]`. With a
  // signal, every rule row reading `decisions()[i]` re-runs on every toggle
  // — O(n) re-execution per click in a 50+ rule list. The store gives us
  // fine-grained per-key reactivity for free.
  const saved = config().permission?.[props.request.toolName]
  const loadState = savedRuleStates(rules(), saved)
  const [decisions, setDecisions] = createStore<Record<number, RuleDecision>>(loadState)
  const [expanded, setExpanded] = createSignal(rulesExpandedPreference)
  const [rulesEl, setRulesEl] = createSignal<HTMLElement>()

  let root!: HTMLDivElement

  const hasRules = () => rules().length > 0
  const virtualRules = () => rules().length > RULE_VIRTUAL_THRESHOLD

  const ruleVirtualizer = createVirtualizer<HTMLElement, HTMLElement>({
    get count() {
      return virtualRules() ? rules().length : 0
    },
    getScrollElement: () => rulesEl() ?? null,
    estimateSize: () => RULE_ESTIMATE_SIZE,
    overscan: 10,
    gap: 2,
    measureElement: (element) => element?.getBoundingClientRect().height ?? RULE_ESTIMATE_SIZE,
    getItemKey: (index) => `${index}:${rules()[index] ?? ""}`,
  })

  const virtualRuleItems = createMemo(() => ruleVirtualizer.getVirtualItems())

  const toggleExpanded = () => {
    const next = !expanded()
    rulesExpandedPreference = next
    setExpanded(next)
  }

  const collectRules = () => {
    const all = rules()
    const approved: string[] = []
    const denied: string[] = []
    for (const [i, d] of Object.entries(decisions)) {
      const rule = all[Number(i)]
      if (!rule) continue
      if (d === "approved") approved.push(rule)
      else if (d === "denied") denied.push(rule)
    }
    return { approved, denied }
  }

  const toggleRule = (index: number, decision: RuleDecision) => {
    setDecisions(
      produce((map) => {
        const current = map[index] ?? "pending"
        map[index] = current === decision ? "pending" : decision
      }),
    )
  }

  const decision = (index: number): RuleDecision => decisions[index] ?? "pending"

  const approveTooltip = (index: number) =>
    decision(index) === "approved"
      ? language.t("ui.permission.rule.removeFromAllowed")
      : language.t("ui.permission.rule.addToAllowed")

  const denyTooltip = (index: number) =>
    decision(index) === "denied"
      ? language.t("ui.permission.rule.removeFromDenied")
      : language.t("ui.permission.rule.addToDenied")

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.toolName}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const title = () =>
    fromChild() ? language.t("notification.permission.titleSubagent") : language.t("notification.permission.title")

  const focusPrompt = () => requestAnimationFrame(() => window.dispatchEvent(new Event("focusPrompt")))

  const submit = (response: "once" | "reject") => {
    if (props.responding) return
    const { approved, denied } = collectRules()
    props.onDecide(response, approved, denied)
    focusPrompt()
  }

  const element = (e: KeyboardEvent) => (e.target instanceof Element ? e.target : undefined)

  const control = (target: Element | undefined) =>
    !!target?.closest(
      "button, input, select, textarea, a[href], [contenteditable='true'], [role='button'], [role='menu'], [role='menuitem'], [role='listbox'], [role='option'], [role='combobox'], [role='textbox']",
    )

  const plain = (e: KeyboardEvent) =>
    e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing

  const skip = (e: KeyboardEvent, target: Element | undefined) => {
    const local = !!target?.closest("[data-component='permission-shortcuts']")
    const prompt = !!target?.closest("textarea.prompt-input")
    const modal = !!target?.closest("[data-component='dialog'], [data-component='dropdown-menu-content']")
    if (local) return e.key === "Enter"
    if (modal) return true
    if (prompt) return false
    return control(target)
  }

  const handle = (e: KeyboardEvent, response: "once" | "reject") => {
    e.preventDefault()
    e.stopPropagation()
    submit(response)
  }

  const onRoot = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      handle(e, "reject")
      return
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (!document.hasFocus()) return
    if (e.defaultPrevented) return
    if (root.getClientRects().length === 0) return

    const target = element(e)

    // Preserve normal Enter behavior for controls inside the permission card,
    // while allowing the shortcut when the prompt input still has focus.
    if (skip(e, target)) return

    if (e.key === "Escape") {
      handle(e, "reject")
      return
    }

    if (plain(e)) {
      handle(e, "once")
      return
    }
  }

  // Listen only while this permission is rendered. This keeps shortcuts working
  // when the prompt input owns focus without forcing focus onto the dock.
  // onKey reads `props.request.id` lazily, so we don't need to rebind the
  // listener every time the id changes — that just churned add/removeEventListener
  // and risked dropping a queued keystroke during the rebind window.
  onMount(() => document.addEventListener("keydown", onKey, true))
  onCleanup(() => document.removeEventListener("keydown", onKey, true))

  const renderRule = (rule: string, index: number) => (
    <div data-slot="permission-rule-row" data-decision={decision(index)}>
      <div data-slot="permission-rule-actions">
        <Tooltip value={approveTooltip(index)} placement="top">
          <button
            data-slot="permission-rule-toggle"
            data-variant="approve"
            data-active={decision(index) === "approved" ? "" : undefined}
            disabled={props.responding}
            onClick={() => toggleRule(index, "approved")}
            aria-label={approveTooltip(index)}
          >
            <Icon name="check-small" size="small" />
          </button>
        </Tooltip>
        <Tooltip value={denyTooltip(index)} placement="top">
          <button
            data-slot="permission-rule-toggle"
            data-variant="deny"
            data-active={decision(index) === "denied" ? "" : undefined}
            disabled={props.responding}
            onClick={() => toggleRule(index, "denied")}
            aria-label={denyTooltip(index)}
          >
            <Icon name="close-small" size="small" />
          </button>
        </Tooltip>
      </div>
      <code data-slot="permission-rule">
        {command()
          ? label(rule)
          : rule === "*"
            ? resolveLabel(props.request.toolName, language.t)
            : `${resolveLabel(props.request.toolName, language.t)} ${rule}`}
      </code>
    </div>
  )

  return (
    <div ref={root} data-component="permission-shortcuts" onKeyDown={onRoot}>
      <DockPrompt
        kind="permission"
        header={
          <div data-slot="permission-row" data-variant="header">
            <span data-slot="permission-icon">
              <Icon name="warning" size="small" />
            </span>
            <div data-slot="permission-header-title">{title()}</div>
          </div>
        }
        footer={
          <Show when={hasRules()}>
            <div data-slot="permission-rules-section">
              <button
                type="button"
                data-slot="permission-rules-header"
                data-open={expanded() ? "" : undefined}
                onClick={toggleExpanded}
                aria-expanded={expanded()}
              >
                <span data-slot="permission-rules-header-chevron" data-open={expanded() ? "" : undefined}>
                  <Icon name="chevron-down" size="small" />
                </span>
                <span data-slot="permission-rules-header-title">{language.t("ui.permission.manageAutoApprove")}</span>
              </button>

              <div data-slot="permission-rules-collapse" data-open={expanded() ? "" : undefined}>
                <div data-slot="permission-rules-collapse-inner">
                  <div ref={setRulesEl} data-slot="permission-rules" data-virtualized={virtualRules() ? "" : undefined}>
                    <Show
                      when={virtualRules()}
                      fallback={<For each={rules()}>{(rule, index) => renderRule(rule, index())}</For>}
                    >
                      <div
                        data-slot="permission-rules-virtual"
                        style={{
                          height: `${ruleVirtualizer.getTotalSize()}px`,
                          position: "relative",
                          width: "100%",
                        }}
                      >
                        <For each={virtualRuleItems()}>
                          {(item) => {
                            const rule = createMemo(() => rules()[item.index])
                            return (
                              <Show when={rule()}>
                                {(value) => (
                                  <div
                                    ref={(el) => ruleVirtualizer.measureElement(el)}
                                    data-index={item.index}
                                    data-slot="permission-rule-virtual-row"
                                    style={{
                                      position: "absolute",
                                      top: 0,
                                      left: 0,
                                      width: "100%",
                                      transform: `translateY(${item.start}px)`,
                                    }}
                                  >
                                    {renderRule(value(), item.index)}
                                  </div>
                                )}
                              </Show>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        }
      >
        <Show when={command()}>{(cmd) => <PermissionCommand command={cmd()} />}</Show>

        {(() => {
          const desc = description()
          if (!desc)
            return !command() && toolDescription() ? <div data-slot="permission-hint">{toolDescription()}</div> : null
          if (desc.kind === "single") return <div data-slot="permission-hint">{desc.text}</div>
          return (
            <div data-slot="permission-patterns">
              <span data-slot="permission-patterns-title">{desc.title}</span>
              <For each={desc.paths}>{(path) => <code data-slot="permission-pattern">{path}</code>}</For>
            </div>
          )
        })()}

        <Show when={diffs().length > 0}>
          <div data-slot="permission-diffs" data-count={diffs().length}>
            {/* Eagerly mount the first 5 diffs (covers the common case where
                the user can see them all at once); lazy-mount the rest behind
                an expand toggle so a 40-file multiedit doesn't pay 40×
                PermissionDiff render cost on dock open. */}
            <For each={diffs().slice(0, 5)}>{(diff) => <PermissionDiff filediff={diff} />}</For>
            <Show when={diffs().length > 5}>
              {(() => {
                const [showAll, setShowAll] = createSignal(false)
                return (
                  <>
                    <Show
                      when={showAll()}
                      fallback={
                        <button
                          data-slot="permission-diff-show-more"
                          type="button"
                          onClick={() => setShowAll(true)}
                        >
                          {`+ ${diffs().length - 5} more`}
                        </button>
                      }
                    >
                      <For each={diffs().slice(5)}>{(diff) => <PermissionDiff filediff={diff} />}</For>
                    </Show>
                  </>
                )
              })()}
            </Show>
          </div>
        </Show>

        <div data-slot="permission-actions">
          <Button
            variant="primary"
            size="small"
            onClick={() => {
              const { approved, denied } = collectRules()
              props.onDecide("once", approved, denied)
            }}
            disabled={props.responding}
          >
            {language.t("ui.permission.run")}
          </Button>
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              const { approved, denied } = collectRules()
              props.onDecide("reject", approved, denied)
            }}
            disabled={props.responding}
          >
            {language.t("ui.permission.deny")}
          </Button>
        </div>
      </DockPrompt>
    </div>
  )
}
