#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"

const mode = process.argv.includes("--full") ? "full" : "vscode"

// Keep every workspace package needed for a fully functional VS Code extension
// build, including the bundled CLI binary path. This is intentionally larger
// than "webview source only": removing opencode, telemetry, script, or SDK
// breaks normal compile/package flows.
const paths = [
  ".changeset",
  ".github",
  "patches",
  "script",
  "packages/core",
  "packages/kilo-gateway",
  "packages/kilo-i18n",
  "packages/kilo-indexing",
  "packages/kilo-telemetry",
  "packages/kilo-ui",
  "packages/kilo-vscode",
  "packages/opencode",
  "packages/plugin",
  "packages/script",
  "packages/sdk",
  "packages/ui",
]

const patterns = [
  "/*",
  "!/*/",
  "/.changeset/**",
  "/.github/**",
  "/patches/**",
  "/script/**",
  "/packages/",
  "!/packages/*/",
  "/packages/*/package.json",
  ...paths.filter((path) => path.startsWith("packages/")).map((path) => `/${path}/**`),
]

function log(msg: string) {
  console.log(`[workspace-vscode] ${msg}`)
}

async function assertKept() {
  const missing: string[] = []
  for (const path of paths) {
    if (path === ".changeset") continue
    if (existsSync(path)) continue
    missing.push(path)
  }
  if (missing.length === 0) return
  throw new Error(`sparse checkout is missing required VS Code workspace paths: ${missing.join(", ")}`)
}

if (mode === "full") {
  await $`git sparse-checkout disable`
  log("restored full checkout")
  process.exit(0)
}

await $`git sparse-checkout init --no-cone`
const proc = Bun.spawn(["git", "sparse-checkout", "set", "--no-cone", "--stdin"], {
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
})
proc.stdin.write(patterns.join("\n") + "\n")
proc.stdin.end()
const code = await proc.exited
if (code !== 0) throw new Error(`git sparse-checkout set failed with exit code ${code}`)
await assertKept()
log("enabled VS Code-focused sparse checkout")
log(`kept ${paths.length} root/package paths plus root files and workspace manifests`)
