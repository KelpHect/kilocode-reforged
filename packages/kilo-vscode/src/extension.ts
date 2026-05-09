import * as vscode from "vscode"
import { KiloProvider } from "./KiloProvider"
import type { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import type { VscodeHost } from "./agent-manager/vscode-host"
import type { KiloClawProvider } from "./kiloclaw/KiloClawProvider"
import type { DiffViewerProvider } from "./diff/DiffViewerProvider"
import type { DiffSourceCatalog } from "./diff/sources/catalog"
import { DiffVirtualProvider } from "./DiffVirtualProvider"
import type { SettingsEditorProvider } from "./SettingsEditorProvider"
import type { SubAgentViewerProvider } from "./SubAgentViewerProvider"
import { EXTENSION_DISPLAY_NAME } from "./constants"
import { KiloConnectionService } from "./services/cli-backend"
import { registerAutocompleteProvider } from "./services/autocomplete"
import { ensureBackendForAutocomplete } from "./services/autocomplete/ensure-backend"
import { AutocompleteServiceManager } from "./services/autocomplete/AutocompleteServiceManager"
import { BrowserAutomationService } from "./services/browser-automation"
import { TelemetryProxy } from "./services/telemetry"
import { registerCommitMessageService } from "./services/commit-message"
import { registerCodeActions, registerTerminalActions, KiloCodeActionProvider } from "./services/code-actions"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"
import { markWorkspace } from "./util/spotlight"

let agentManager: AgentManagerProvider | undefined

const panelTitleHandler = (panel: vscode.WebviewPanel) => (title: string) => {
  panel.title = title || EXTENSION_DISPLAY_NAME
}

/** Memoise a constructor so the heavy class is only instantiated on first use.
 *  Returns the same instance on every subsequent call (typical extension lifetime).
 *  Used for providers that the user may never trigger (Agent Manager, KiloClaw,
 *  diff viewer, settings editor, sub-agent viewer) — eager construction at
 *  activation cost ~30 MB of class instances + their pollers/listeners. */
const lazy = <T>(make: () => T): (() => T) => {
  let instance: T | undefined
  return () => {
    if (instance === undefined) instance = make()
    return instance
  }
}

// Activated via "onStartupFinished" (package.json) so that commands, code actions, keybindings,
// autocomplete, commit-message generation, and URI deep links all work immediately — without
// requiring the user to open a Kilo sidebar or panel first. The CLI backend is NOT spawned here;
// it starts lazily when a webview connects or when ensureBackendForAutocomplete() triggers it.
//
// Heavy providers (Agent Manager, KiloClaw, diff viewer, settings editor, sub-agent viewer) are
// lazy-constructed via the `lazy()` helper. Their command handlers and serializers retain references
// to the getters; the actual classes are only instantiated when the user runs the corresponding
// command or VS Code restores a previously open panel. Profile data attached to those instances
// (GitStatsPoller, PRStatusBridge, marketplace cache, auto-approve bridge) stays out of the heap
// for users who don't use those features in a given session.
export function activate(context: vscode.ExtensionContext) {
  console.log("Kilo Code extension is now active")

  const telemetry = TelemetryProxy.getInstance()

  // Create shared connection service (one server for all webviews)
  const connectionService = new KiloConnectionService(context)

  // Browser automation service. The class itself is small; `syncWithSettings`
  // queries config and registers an MCP server, which only matters once the
  // CLI is connected. Defer the initial sync to the connection callback below.
  const browserAutomationService = new BrowserAutomationService(connectionService)

  // Create remote status service (one status bar item for all webviews)
  const remoteService = new RemoteStatusService()
  context.subscriptions.push(remoteService)
  connectionService.setRemoteService(remoteService)

  // Tracks whether the initial browser-automation sync has run. The sync
  // reads config and (when enabled) calls `mcp.add` on the SDK client, so it
  // only does anything useful once a server config is available — paying the
  // cost at activation when the CLI hadn't even connected yet was wasted.
  let browserSynced = false

  // Re-register browser automation MCP server on CLI backend reconnect, configure telemetry,
  // set remote service client, and reload autocomplete so it picks up the now-available backend connection.
  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      if (!browserSynced) {
        browserSynced = true
        browserAutomationService.syncWithSettings()
      } else {
        browserAutomationService.reregisterIfEnabled()
      }
      const config = connectionService.getServerConfig()
      if (config) {
        telemetry.configure(config.baseUrl, config.password)
        // Sync the CLI's PostHog client with the current consent state. The
        // CLI reads KILO_TELEMETRY_LEVEL once at spawn, so without this call
        // a fresh CLI started while VS Code telemetry was off would stay
        // opted out for the rest of the session.
        telemetry.setEnabled(vscode.env.isTelemetryEnabled)
      }
      try {
        remoteService.setClient(connectionService.getClient())
        console.log("[Kilo New] CLI connected, calling remoteService.refresh()")
        remoteService.refresh().catch((err) => console.warn("[Kilo New] initial remote refresh failed:", err))
      } catch {
        remoteService.setClient(null)
      }
      AutocompleteServiceManager.getInstance()?.load()
    } else {
      remoteService.clearState()
      remoteService.setClient(null)
    }
  })

  // Propagate runtime telemetry consent changes to the CLI subprocess so its
  // PostHog client stays in sync with the user's VS Code telemetry setting.
  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled((enabled) => {
      telemetry.setEnabled(enabled)
    }),
  )

  // Prewarm the CLI backend on first editor activity instead of unconditionally
  // at activation. The CLI binary is ~158 MB on disk and forks a long-lived
  // child process; spawning it eagerly burdened workspaces where the user
  // never touches autocomplete. A one-shot listener on the next text-edit
  // covers the autocomplete prewarm requirement at the right moment.
  const prewarmListener = vscode.workspace.onDidChangeTextDocument(() => {
    prewarmListener.dispose()
    ensureBackendForAutocomplete(connectionService)
  })
  context.subscriptions.push(prewarmListener)

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void markWorkspace(folder.uri.fsPath, (msg) => console.warn(`[Kilo New] ${msg}`))
  }

  // Track all open tab panel providers so toolbar button commands can target them.
  // NOTE: The editor/title toolbar for tab panels intentionally omits Agent Manager
  // and Marketplace buttons (unlike the sidebar). Too many icons causes VS Code to
  // collapse them into a "..." overflow menu, hiding important buttons like Settings.
  const tabPanels = new Map<vscode.WebviewPanel, KiloProvider>()
  const activeTabProvider = () => {
    for (const [panel, p] of tabPanels) {
      if (panel.active) return p
    }
    return undefined
  }

  // Create the provider with shared service
  const provider = new KiloProvider(context.extensionUri, connectionService, context)
  provider.setRemoteService(remoteService)

  // Register the webview view provider for the sidebar.
  // retainContextWhenHidden keeps the webview alive when switching to other sidebar panels.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KiloProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Ensure Agent Manager navigation keybindings work when a VS Code terminal has focus.
  // The terminal intercepts all keystrokes unless the command is listed in
  // terminal.integrated.commandsToSkipShell, which only contains built-in
  // commands by default.
  // Cache the install-once flag in globalState so we don't re-inspect/update
  // user settings on every activation. The set we install rarely changes;
  // bumping the version suffix invalidates the cache when it does.
  const SKIP_SHELL_INSTALLED_KEY = "kilo.commandsSkipShellInstalled.v1"
  if (!context.globalState.get<boolean>(SKIP_SHELL_INSTALLED_KEY)) {
    const skip = ["kilo-code.new.agentManagerOpen", "kilo-code.new.agentManager.showTerminal"]
    if (process.platform === "darwin") skip.push("kilo-code.new.agentManager.runScript")
    ensureCommandsSkipShell(skip)
    void context.globalState.update(SKIP_SHELL_INSTALLED_KEY, true)
  }

  // ---------------------------------------------------------------------------
  // Lazy provider construction
  //
  // Each `getX()` returns the singleton, constructing it on first call. The
  // class imports above are type-only (`import type`) so the runtime modules
  // load only when the getter actually runs. With current bundler settings
  // this still ends up in the same `extension.js` chunk, but the eager
  // instantiation cost (class fields + per-provider pollers) is gated.
  // ---------------------------------------------------------------------------

  // Diff virtual provider is lightweight and used by KiloProvider's permission
  // approval path on every tool that produces a diff — keep eager.
  const diffVirtualProvider = new DiffVirtualProvider(context.extensionUri)
  provider.setDiffVirtualProvider(diffVirtualProvider)
  context.subscriptions.push(diffVirtualProvider)

  const getAgentManagerHost = lazy(() => {
    const { VscodeHost } = require("./agent-manager/vscode-host") as typeof import("./agent-manager/vscode-host")
    const host = new VscodeHost(context.extensionUri, connectionService, context)
    host.setDiffVirtualProvider(diffVirtualProvider)
    if (autoApprove) host.setAutoApproveController(autoApprove)
    return host
  })

  const getAgentManager = lazy(() => {
    const { AgentManagerProvider } =
      require("./agent-manager/AgentManagerProvider") as typeof import("./agent-manager/AgentManagerProvider")
    const am = new AgentManagerProvider(getAgentManagerHost(), connectionService)
    agentManager = am
    context.subscriptions.push(am)
    // Wire sidebar handoffs now that AM exists. Setting these after the
    // sidebar provider has already been created is fine — the sidebar stores
    // them and only invokes them when the user triggers worktree actions.
    provider.setContinueInWorktreeHandler((sessionId, progress) => am.continueFromSidebar(sessionId, progress))
    provider.setCreateWorktreeHandler((baseBranch, branchName) => am.createFromSidebar(baseBranch, branchName))
    return am
  })

  const getKiloClaw = lazy(() => {
    const { KiloClawProvider } = require("./kiloclaw/KiloClawProvider") as typeof import("./kiloclaw/KiloClawProvider")
    const kc = new KiloClawProvider(context.extensionUri, connectionService)
    context.subscriptions.push(kc)
    return kc
  })

  const getDiffSourceCatalog = lazy(() => {
    const { DiffSourceCatalog } = require("./diff/sources/catalog") as typeof import("./diff/sources/catalog")
    const cat = new DiffSourceCatalog(connectionService)
    context.subscriptions.push(cat)
    return cat
  })

  const getDiffViewer = lazy(() => {
    const { DiffViewerProvider } = require("./diff/DiffViewerProvider") as typeof import("./diff/DiffViewerProvider")
    const dv = new DiffViewerProvider(context.extensionUri, connectionService, getDiffSourceCatalog(), {
      sessionIdProvider: () => provider.getCurrentSessionId(),
    })
    dv.setCommentHandler((comments, autoSend) => {
      void provider.appendReviewComments(comments, autoSend)
    })
    context.subscriptions.push(dv)
    return dv
  })

  const getSettingsEditor = lazy(() => {
    const { SettingsEditorProvider } =
      require("./SettingsEditorProvider") as typeof import("./SettingsEditorProvider")
    const se = new SettingsEditorProvider(context.extensionUri, connectionService, context)
    se.setRemoteService(remoteService)
    context.subscriptions.push(se)
    return se
  })

  const getSubAgentViewer = lazy(() => {
    const { SubAgentViewerProvider } =
      require("./SubAgentViewerProvider") as typeof import("./SubAgentViewerProvider")
    const sv = new SubAgentViewerProvider(context.extensionUri, connectionService, context)
    context.subscriptions.push(sv)
    return sv
  })

  // Register toggle auto-approve shortcut (Ctrl+Alt+A / Cmd+Alt+A).
  // Auto-approve dirs are sourced from both the sidebar and AM; the AM lookup
  // is lazy via `agentManager?.getSessionDirectories()` so we don't trigger
  // AM construction just to gather directory hints.
  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const autoApprove = registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        const dir =
          provider.getSessionDirectories().get(sessionId) ?? agentManager?.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const dir of provider.getSessionDirectories().values()) dirs.add(dir)
      const am = agentManager
      if (am) for (const dir of am.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )
  provider.setAutoApproveController(autoApprove)
  // AM host applies autoApprove inside its lazy constructor (see getAgentManagerHost).

  // Register serializer so Agent Manager restores when VS Code restarts.
  // Restoration triggers AM construction — the user already had a panel open,
  // so paying the construction cost now matches the pre-restart state.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("kilo-code.new.AgentManagerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const am = getAgentManager()
        const host = getAgentManagerHost()
        const ctx = host.wrapExistingPanel(panel, {
          onBeforeMessage: (msg) => am.handleMessage(msg),
        })
        am.deserializePanel(ctx)
        return Promise.resolve()
      },
    }),
  )

  // Register serializer so KiloClaw panel restores when VS Code restarts.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("kilo-code.new.KiloClawPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        getKiloClaw().restorePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  // Register serializer so "Open in Tab" restores when VS Code restarts.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("kilo-code.new.TabPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
          tabTitle: panelTitleHandler(panel),
        })
        tabProvider.setRemoteService(remoteService)
        tabProvider.setAutoApproveController(autoApprove)
        // Wire AM handoffs on demand — only resolves the AM provider if the
        // user actually triggers a worktree action from the restored tab.
        tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
          getAgentManager().continueFromSidebar(sessionId, progress),
        )
        tabProvider.setCreateWorktreeHandler((baseBranch, branchName) =>
          getAgentManager().createFromSidebar(baseBranch, branchName),
        )
        tabProvider.setDiffVirtualProvider(diffVirtualProvider)
        tabProvider.resolveWebviewPanel(panel)
        tabPanels.set(panel, tabProvider)
        panel.onDidDispose(
          () => {
            console.log("[Kilo New] Tab panel restored from restart disposed")
            tabPanels.delete(panel)
            tabProvider.dispose()
          },
          null,
          context.subscriptions,
        )
        return Promise.resolve()
      },
    }),
  )

  // Register serializers so settings/diff/sub-agent panels restore on restart.
  const settingsViews = ["settingsPanel", "profilePanel", "marketplacePanel"] as const
  for (const suffix of settingsViews) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(`kilo-code.new.${suffix}`, {
        deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          getSettingsEditor().deserializePanel(panel)
          return Promise.resolve()
        },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("kilo-code.new.DiffViewerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        getDiffViewer().deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  // Sub-agent viewer can't be recovered after restart because the session ID
  // isn't persisted; dispose the stale panel cleanly without constructing the
  // provider class at all.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("kilo-code.new.SubAgentViewerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  // Register toolbar button command handlers
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.plusButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "plusButtonClicked" })
      else provider.postMessage({ type: "action", action: "plusButtonClicked" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManagerOpen", () => {
      getAgentManager().openPanel()
    }),
    vscode.commands.registerCommand("kilo-code.new.marketplaceButtonClicked", (directory?: string) => {
      getSettingsEditor().openPanel("marketplace", undefined, directory)
    }),
    vscode.commands.registerCommand("kilo-code.new.kiloClawOpen", () => {
      getKiloClaw().openPanel()
    }),
    vscode.commands.registerCommand("kilo-code.new.historyButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "historyButtonClicked" })
      else provider.postMessage({ type: "action", action: "historyButtonClicked" })
    }),
    vscode.commands.registerCommand("kilo-code.new.cycleAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cycleAgentMode" })
      else provider.postMessage({ type: "action", action: "cycleAgentMode" })
      // Only forward to AM if it has actually been constructed — otherwise
      // there's nothing for the action to reach.
      agentManager?.postMessage({ type: "action", action: "cycleAgentMode" })
    }),
    vscode.commands.registerCommand("kilo-code.new.cyclePreviousAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      else provider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      agentManager?.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
    }),
    vscode.commands.registerCommand("kilo-code.new.profileButtonClicked", () => {
      getSettingsEditor().openPanel("profile")
    }),
    vscode.commands.registerCommand("kilo-code.new.settingsButtonClicked", (tab?: string) => {
      getSettingsEditor().openPanel("settings", tab)
    }),
    vscode.commands.registerCommand("kilo-code.new.openIndexingSettings", () => {
      getSettingsEditor().openPanel("settings", "indexing")
    }),
    // legacy-migration start
    vscode.commands.registerCommand("kilo-code.new.openMigrationWizard", () => {
      provider.postMessage({ type: "migrationState", needed: true })
    }),
    // legacy-migration end
    vscode.commands.registerCommand("kilo-code.new.generateTerminalCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Describe the terminal command you want to generate",
        placeHolder: "e.g., find all .ts files modified in the last 24 hours",
      })
      if (!input) return
      await vscode.commands.executeCommand("kilo-code.SidebarProvider.focus")
      await provider.waitForReady()
      provider.postMessage({ type: "triggerTask", text: `Generate a terminal command: ${input}` })
    }),
    vscode.commands.registerCommand("kilo-code.new.toggleRemote", () => {
      remoteService.toggle().catch((err) => console.error("[Kilo New] toggleRemote command failed:", err))
    }),
    vscode.commands.registerCommand("kilo-code.new.openInTab", () => {
      return openKiloInNewTab(context, connectionService, getAgentManager, tabPanels, diffVirtualProvider, remoteService, autoApprove)
    }),
    vscode.commands.registerCommand(
      "kilo-code.new.showChanges",
      (arg?: { sessionId?: string; turnId?: string; initialSourceId?: string }) => {
        getDiffViewer().openFromCommand(arg)
      },
    ),
    vscode.commands.registerCommand("kilo-code.new.openSubAgentViewer", (sessionID: string, title?: string) => {
      getSubAgentViewer().openPanel(sessionID, title)
    }),
    // ---------------------------------------------------------------------------
    // Agent Manager panel-only commands.
    //
    // All forward to `agentManager?.postMessage(...)`. When the panel is closed
    // the keybindings are gated by `when:` clauses, so the command body runs
    // rarely; the optional-chain skips the work entirely if AM has never been
    // constructed (e.g. user has never opened it). When AM is open these
    // become single property dispatches — same cost as before, but without
    // the eager construction.
    // ---------------------------------------------------------------------------
    vscode.commands.registerCommand("kilo-code.new.agentManager.previousSession", () => {
      agentManager?.postMessage({ type: "action", action: "sessionPrevious" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.nextSession", () => {
      agentManager?.postMessage({ type: "action", action: "sessionNext" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.previousTab", () => {
      agentManager?.postMessage({ type: "action", action: "tabPrevious" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.nextTab", () => {
      agentManager?.postMessage({ type: "action", action: "tabNext" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.showTerminal", () => {
      agentManager?.postMessage({ type: "action", action: "showTerminal" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.runScript", () => {
      agentManager?.postMessage({ type: "action", action: "runScript" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.toggleDiff", () => {
      agentManager?.postMessage({ type: "action", action: "toggleDiff" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.showShortcuts", () => {
      agentManager?.postMessage({ type: "action", action: "showShortcuts" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.newTab", () => {
      agentManager?.postMessage({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.newTerminal", () => {
      agentManager?.postMessage({ type: "action", action: "newTerminal" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.closeTab", () => {
      agentManager?.postMessage({ type: "action", action: "closeTab" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.newWorktree", () => {
      agentManager?.postMessage({ type: "action", action: "newWorktree" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.openWorktree", () => {
      agentManager?.postMessage({ type: "action", action: "openWorktree" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.closeWorktree", () => {
      agentManager?.postMessage({ type: "action", action: "closeWorktree" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.advancedWorktree", () =>
      getAgentManager().openAdvancedWorktree(),
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`kilo-code.new.agentManager.jumpTo${i + 1}`, () => {
        agentManager?.postMessage({ type: "action", action: `jumpTo${i + 1}` })
      }),
    ),
  )

  // Register URI handler for session imports (vscode://kilocode.kilo-code/kilocode/s/{sessionId})
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const match = uri.path.match(/^\/kilocode\/s\/([a-zA-Z0-9_-]+)$/)
        if (!match) return
        const sessionId = match[1]
        if (!sessionId) return
        console.log("[Kilo New] URI handler: opening cloud session:", sessionId)
        await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
        provider.openCloudSession(sessionId)
      },
    }),
  )

  // Register autocomplete provider
  registerAutocompleteProvider(context, connectionService)

  // Register commit message generation
  registerCommitMessageService(context, connectionService)

  registerHeapSnapshot(context, connectionService)

  // Register code actions (editor context menus, terminal context menus, keyboard shortcuts).
  // Pass a getter so the AM provider is resolved at command-fire time rather than at activation.
  registerCodeActions(context, provider, () => agentManager)
  registerTerminalActions(context, provider, () => agentManager)

  // Register CodeActionProvider (lightbulb quick fixes)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  // Dispose services when extension deactivates. Synchronous fallback for
  // when VS Code disposes context.subscriptions without waiting — the async
  // path in deactivate() runs first and finishes the heavy work; this just
  // re-runs as a defensive net for synchronous teardown contexts.
  context.subscriptions.push({
    dispose: () => {
      unsubscribeStateChange()
      browserAutomationService.dispose()
      provider.dispose()
      connectionService.dispose()
    },
  })

  // Stash the connection service so deactivate() can await its async teardown.
  // VS Code awaits deactivate() before unloading the extension host, so this
  // path guarantees the spawned CLI process actually exits — without it,
  // SIGTERM was sent fire-and-forget and the process tree could outlive the
  // extension on Windows.
  connectionForDeactivate = connectionService
}

let connectionForDeactivate: KiloConnectionService | undefined

export async function deactivate() {
  await agentManager?.shutdown()
  if (connectionForDeactivate) {
    await connectionForDeactivate.disposeAsync()
    connectionForDeactivate = undefined
  }
  TelemetryProxy.getInstance().shutdown()
}

async function openKiloInNewTab(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  getAgentManager: () => AgentManagerProvider,
  tabPanels: Map<vscode.WebviewPanel, KiloProvider>,
  diffVirtualProvider: DiffVirtualProvider,
  remoteService: RemoteStatusService,
  autoApprove: ReturnType<typeof registerToggleAutoApprove>,
) {
  const lastCol = Math.max(...vscode.window.visibleTextEditors.map((e) => e.viewColumn || 0), 0)
  const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

  if (!hasVisibleEditors) {
    await vscode.commands.executeCommand("workbench.action.newGroupRight")
  }

  const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

  const panel = vscode.window.createWebviewPanel("kilo-code.new.TabPanel", EXTENSION_DISPLAY_NAME, targetCol, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  })

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-light.svg"),
    dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-dark.svg"),
  }

  const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
    tabTitle: panelTitleHandler(panel),
  })
  tabProvider.setRemoteService(remoteService)
  tabProvider.setAutoApproveController(autoApprove)
  tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
    getAgentManager().continueFromSidebar(sessionId, progress),
  )
  tabProvider.setCreateWorktreeHandler((baseBranch, branchName) =>
    getAgentManager().createFromSidebar(baseBranch, branchName),
  )
  tabProvider.setDiffVirtualProvider(diffVirtualProvider)
  tabProvider.resolveWebviewPanel(panel)
  tabPanels.set(panel, tabProvider)

  // Wait for the new panel to become active before locking the editor group.
  // This avoids the race where VS Code hasn't switched focus yet.
  await waitForWebviewPanelToBeActive(panel)
  await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

  panel.onDidDispose(
    () => {
      console.log("[Kilo New] Tab panel disposed")
      tabPanels.delete(panel)
      tabProvider.dispose()
    },
    null,
    context.subscriptions,
  )
}

/**
 * Add extension commands to terminal.integrated.commandsToSkipShell so they
 * work when a VS Code terminal has focus. The setting only ships with built-in
 * commands; extension commands must be added explicitly.
 */
function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  // Update whichever scope already carries an override so we don't
  // shadow workspace settings or leak workspace values into global.
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}

function waitForWebviewPanelToBeActive(panel: vscode.WebviewPanel): Promise<void> {
  if (panel.active) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const disposable = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.active) {
        return
      }
      disposable.dispose()
      resolve()
    })
  })
}
