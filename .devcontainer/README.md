# Kilo Code Dev Container

This container is the preferred Linux development environment for Windows hosts.
It matches CI's Node 24 line, pins Bun to the repo's `packageManager`, keeps
Linux line endings, and includes the native/tooling dependencies needed for
extension builds, unit tests, Storybook, Playwright visual tests, GitHub scripts,
and Docker-backed workflows.

## Personal VS Code Extensions

The extensions in `devcontainer.json` are only project essentials that need to
run inside the container, such as Bun, ESLint, Prettier, and EditorConfig.

You can still use your own extensions. UI-only extensions continue to run in
your local VS Code window. Extensions that need workspace files, terminals, or
language servers must also be installed in the container. Use Settings Sync,
Dev Containers: Install Local Extensions in Container, or your user-level
`dev.containers.defaultExtensions` setting for personal tools like Codex.

## Common Commands

```bash
bun run workspace:vscode
bun run --cwd packages/kilo-vscode typecheck
bun run --cwd packages/kilo-vscode lint
bun run --cwd packages/kilo-vscode test:unit
bun run --cwd packages/kilo-vscode build-storybook
```

For VS Code/Electron tests that need a display, run them through `xvfb-run`:

```bash
cd packages/kilo-vscode
xvfb-run -a bun run test
```
