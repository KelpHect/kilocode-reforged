import * as vscode from "vscode"
import type { KiloProvider } from "../../KiloProvider"
import type { AgentManagerProvider } from "../../agent-manager/AgentManagerProvider"
import { getEditorContext } from "./editor-utils"
import { createPrompt } from "./support-prompt"

export function registerCodeActions(
  context: vscode.ExtensionContext,
  provider: KiloProvider,
  /** Getter so the AgentManagerProvider can be lazy-constructed at activation
   *  time and only resolved when a code-action command actually fires. */
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
    vscode.commands.registerCommand("kilo-code.new.explainCode", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("EXPLAIN", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        userInput: "",
      })
      await reveal()
      provider.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.fixCode", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("FIX", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        diagnostics: ctx.diagnostics,
        userInput: "",
      })
      await reveal()
      provider.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.improveCode", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("IMPROVE", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        userInput: "",
      })
      await reveal()
      provider.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.addToContext", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("ADD_TO_CONTEXT", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
      })
      const view = target()
      if (view === provider) {
        await reveal()
      }
      view.postMessage({ type: "appendChatBoxMessage", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.focusChatInput", async () => {
      const view = target()
      if (view === provider) {
        await reveal()
      }
      view.postMessage({ type: "action", action: "focusInput" })
    }),
  )
}
