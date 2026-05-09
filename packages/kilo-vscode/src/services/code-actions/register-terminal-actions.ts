import * as vscode from "vscode"
import type { KiloProvider } from "../../KiloProvider"
import type { AgentManagerProvider } from "../../agent-manager/AgentManagerProvider"
import { createPrompt } from "./support-prompt"
import { getTerminalContents } from "../terminal/context"

export function registerTerminalActions(
  context: vscode.ExtensionContext,
  provider: KiloProvider,
  /** Getter so the AgentManagerProvider can be lazy-constructed at activation
   *  time and only resolved when a terminal-action command actually fires. */
  getAgentManager?: () => AgentManagerProvider | undefined,
): void {
  const target = () => {
    const am = getAgentManager?.()
    return am?.isActive() ? am : provider
  }
  const reveal = async () => {
    await vscode.commands.executeCommand("kilo-code.SidebarProvider.focus")
    await provider.waitForReady()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.terminalAddToContext", async (args: any) => {
      let content = args?.selection as string | undefined
      if (!content) {
        content = (await getTerminalContents(-1)).content
      }
      if (!content) {
        vscode.window.showInformationMessage("No terminal content available. Select text in the terminal first.")
        return
      }
      const prompt = createPrompt("TERMINAL_ADD_TO_CONTEXT", {
        terminalContent: content,
        userInput: "",
      })
      const view = target()
      if (view === provider) {
        await reveal()
      }
      view.postMessage({ type: "appendChatBoxMessage", text: prompt })
      view.postMessage({ type: "action", action: "focusInput" })
    }),

    vscode.commands.registerCommand("kilo-code.new.terminalFixCommand", async (args: any) => {
      let content = args?.selection as string | undefined
      if (!content) {
        content = (await getTerminalContents(1)).content
      }
      if (!content) {
        vscode.window.showInformationMessage("No terminal content available. Select text in the terminal first.")
        return
      }
      const prompt = createPrompt("TERMINAL_FIX", {
        terminalContent: content,
        userInput: "",
      })
      const view = target()
      if (view === provider) {
        await reveal()
      }
      view.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.terminalExplainCommand", async (args: any) => {
      let content = args?.selection as string | undefined
      if (!content) {
        content = (await getTerminalContents(1)).content
      }
      if (!content) {
        vscode.window.showInformationMessage("No terminal content available. Select text in the terminal first.")
        return
      }
      const prompt = createPrompt("TERMINAL_EXPLAIN", {
        terminalContent: content,
        userInput: "",
      })
      const view = target()
      if (view === provider) {
        await reveal()
      }
      view.postMessage({ type: "triggerTask", text: prompt })
    }),
  )
}
