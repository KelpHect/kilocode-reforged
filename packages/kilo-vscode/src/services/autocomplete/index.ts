import * as vscode from "vscode"
import type { AutocompleteServiceManager } from "./AutocompleteServiceManager"
import { ensureBackendForAutocomplete } from "./ensure-backend"
import type { KiloConnectionService } from "../cli-backend"

const CONFIG_SECTION = "kilo-code.new.autocomplete"

/**
 * Register inline completion / commands without eagerly constructing the
 * AutocompleteServiceManager. The manager class is heavy — its constructor
 * builds an `AutocompleteInlineCompletionProvider` (loads the inline engine),
 * subscribes to connection state, and runs `load()` (config read +
 * `setContext` IPC + status bar). For users that never invoke autocomplete,
 * none of that work needs to happen at activation.
 *
 * Deferred construction triggers on:
 *   1. The user invokes any kilo-code.new.autocomplete.* command.
 *   2. `kilo-code.new.autocomplete` config is mutated AND the result enables
 *      auto-trigger (so users disabling autocomplete don't pay either).
 *   3. The first time VS Code asks our shim inline-completion provider for a
 *      suggestion — i.e. the first text edit while auto-trigger is on.
 *
 * Once constructed, the manager remains alive for the rest of the session.
 */
export const registerAutocompleteProvider = (
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
) => {
  let manager: AutocompleteServiceManager | null = null
  const getManager = (): AutocompleteServiceManager => {
    if (manager) return manager
    const { AutocompleteServiceManager: AM } =
      require("./AutocompleteServiceManager") as typeof import("./AutocompleteServiceManager")
    manager = new AM(context, connectionService)
    context.subscriptions.push(manager)
    // Quick-fix code action provider registers globally for all files, so it
    // belongs alongside the manager — registering eagerly added an extension-
    // host subscription on every file even when the user has autocomplete off.
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider("*", manager.codeActionProvider, {
        providedCodeActionKinds: Object.values(manager.codeActionProvider.providedCodeActionKinds),
      }),
    )
    return manager
  }

  // Commands lazy-construct on invocation. Most are user-initiated (palette,
  // notification action, keybinding) — paying construction cost on first
  // invoke is fine because the user is already waiting for a response.
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.autocomplete.reload", async () => {
      await getManager().load()
    }),
    vscode.commands.registerCommand("kilo-code.new.autocomplete.codeActionQuickFix", async () => {
      // No-op stub kept for backwards compatibility with declared
      // codeActionQuickFix entries; constructing the manager would be wasted.
    }),
    vscode.commands.registerCommand("kilo-code.new.autocomplete.cancelSuggestions", () => {
      vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
      vscode.commands.executeCommand("setContext", "kilo-code.new.autocomplete.hasSuggestions", false)
    }),
    vscode.commands.registerCommand("kilo-code.new.autocomplete.generateSuggestions", async () => {
      await getManager().codeSuggestion()
    }),
    vscode.commands.registerCommand("kilo-code.new.autocomplete.showIncompatibilityExtensionPopup", async () => {
      await getManager().showIncompatibilityExtensionPopup()
    }),
    vscode.commands.registerCommand("kilo-code.new.autocomplete.disable", async () => {
      await getManager().disable()
    }),
  )

  // Re-load when autocomplete settings change. Only construct the manager
  // when the user has actually enabled auto-trigger — flipping any other
  // autocomplete setting (e.g. model choice) before enabling auto-trigger
  // is wasted work for users who keep autocomplete off.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return
      const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enableAutoTrigger") ?? true
      // If autocomplete is disabled and we never constructed the manager, do
      // nothing. If we have a manager already, hand the change off so it can
      // tear down its inline completion registration and status bar.
      if (!enabled && !manager) return
      ensureBackendForAutocomplete(connectionService)
      void getManager().load()
    }),
  )

  // If auto-trigger is on at activation, eagerly construct the manager so the
  // first text edit doesn't pay an extra round-trip. Auto-trigger off — and
  // it's the *user's* choice — keeps construction deferred until first
  // command/setting change.
  const initialAutoTrigger = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enableAutoTrigger") ?? true
  if (initialAutoTrigger) {
    // Defer past activation — first onDidChangeTextDocument is enough; there's
    // no interactive user wait yet, and aligning with the prewarm in
    // extension.ts means autocomplete spins up at the same moment as the CLI.
    const firstEdit = vscode.workspace.onDidChangeTextDocument(() => {
      firstEdit.dispose()
      getManager()
    })
    context.subscriptions.push(firstEdit)
  }
}
