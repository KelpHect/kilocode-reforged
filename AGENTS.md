# AGENTS.md

This is the repo-root `AGENTS.md` for the Kilo Code Reforged workspace. `AGENTS.md` is plain Markdown: a practical README for coding agents that captures the repo-specific context, commands, conventions, and safety rules needed while working here.

This fork exists to improve the **VS Code extension** first: performance, reliability, maintainability, sidebar chat, Agent Manager, autocomplete, settings, session history, and extension ↔ CLI integration.

## Instruction Scope

- This file applies repo-wide unless a closer `AGENTS.md` exists under the path being edited.
- Before editing in a subdirectory, check for nested `AGENTS.md` files. The closest file wins when instructions conflict.
- Explicit user instructions in chat override `AGENTS.md`.
- Keep instructions concrete and current. Remove stale process rules instead of preserving them for history.

## Core Priorities

- Performance first.
- Reliability first.
- Keep behavior predictable under load and during failures, including session restarts, reconnects, and partial streams.
- If a tradeoff is required, choose correctness and robustness over short-term convenience.
- Optimize for long VS Code extension sessions with large transcripts, many tool parts, streamed SSE updates, subagents, and repeated session switches.

## Maintainability

- Long term maintainability is a core priority.
- When adding functionality, first check whether shared logic can be extracted to a separate module.
- Duplicate logic across multiple files is a code smell and should be avoided.
- Do not take shortcuts by adding local one-off logic just to solve the immediate problem.
- Do not be afraid to change existing code when that is the clearer, more maintainable path.

## Product Focus

- Default to work in `packages/kilo-vscode/`.
- Read `packages/kilo-vscode/AGENTS.md` before planning or editing extension code. Its closer instructions are authoritative for extension work.
- Treat `packages/opencode/` as the backend/runtime dependency for the extension. Change it only when the extension cannot be made correct through extension-side code or the user explicitly asks for CLI/backend work.
- Do not spend time on JetBrains, docs, website, cloud, generic CLI/TUI behavior, GitHub project management, upstream merge workflow, or release-process chores unless the user explicitly asks.
- Agent Manager is part of the VS Code extension. It is not a separate product.

## Workspace Shape

This workspace is intentionally kept VS Code-focused. Use sparse checkout to keep only the extension and the packages needed for a fully functional extension build.

- Enable the focused workspace with `bun run workspace:vscode` from the repo root.
- Restore the full monorepo with `bun run workspace:full` only when broad cross-package work is explicitly needed.
- Keep the extension and its build/runtime dependencies available: `packages/kilo-vscode/`, `packages/kilo-ui/`, `packages/ui/`, `packages/kilo-i18n/`, `packages/kilo-indexing/`, `packages/kilo-gateway/`, `packages/plugin/`, `packages/sdk/`, `packages/core/`, `packages/opencode/`, `packages/kilo-telemetry/`, and `packages/script/`.
- Keep `packages/*/package.json` manifests for excluded workspaces so Bun sees the same workspace graph.
- Do not replace sparse checkout with symlinks or junctions to another clone.
- Do not remove a package from the focused workspace unless `bun run workspace:vscode`, `bun run --cwd packages/kilo-vscode typecheck`, and the relevant extension build still work.

## General Rules

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch is `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing information or safety/irreversibility.
- Make changes only in the current working directory.
- Do not revert user changes unless the user explicitly asks.
- Never run root `bun test`; use package-level tests instead.

## Build and Dev

- **Launch extension**: `bun run extension` from the repo root, or from `packages/kilo-vscode/`. Pass `--no-build` to skip the build.
- **Extension typecheck**: `bun run typecheck` from `packages/kilo-vscode/`
- **Extension lint**: `bun run lint` from `packages/kilo-vscode/`
- **Extension unit tests**: `bun run test:unit` from `packages/kilo-vscode/`
- **Extension compile/package**: `bun run compile` or `bun run package` from `packages/kilo-vscode/` when touching build, packaging, SDK, webview integration, or CLI bundling paths.
- **SDK regen**: after changing server endpoints in `packages/opencode/src/server/`, run `./script/generate.ts` from the repo root to regenerate `packages/sdk/js/`.
- **Backend testing**: when a backend change is needed for extension behavior, see [TESTING.md](./TESTING.md) for local `bun dev serve` testing.

## Quality Checks

Before saying an implementation is ready, run the smallest relevant checks that can catch failures in the touched area. Fix failures you introduced, or state exactly what still fails or could not be run.

| Area | Checks |
|---|---|
| VS Code extension | From `packages/kilo-vscode/`: `bun run typecheck`, `bun run lint`, `bun run test:unit` or targeted tests |
| Extension build/package | From `packages/kilo-vscode/`: `bun run compile` or `bun run package` |
| SDK/backend API | `./script/generate.ts`, then extension typecheck/build checks |
| Root docs/scripts | Targeted script check, such as `bun run script/check-md-table-padding.ts AGENTS.md packages/kilo-vscode/AGENTS.md` |

## Architecture Pointers

Kilo VS Code Extension (`packages/kilo-vscode/`) is the primary product. It bundles a CLI binary, spawns `kilo serve`, and communicates with it over HTTP + SSE using `@kilocode/sdk`.

| Package | Purpose |
|---|---|
| `packages/kilo-vscode/` | Primary extension code, webview UI, Agent Manager, extension services |
| `packages/opencode/` | CLI backend/runtime used by the extension |
| `packages/sdk/js/` | Generated TypeScript SDK for the backend API |
| `packages/kilo-ui/` | SolidJS component library used by the extension webview |
| `packages/ui/` | Shared UI primitives used by kilo-ui |
| `packages/kilo-i18n/` | Translation strings |
| `packages/kilo-gateway/` | Auth/provider routing/API integration |
| `packages/kilo-telemetry/` | Telemetry used by the CLI/runtime |
| `packages/plugin/` | Plugin/tool interface definitions |

Extension-specific settings should live in the Kilo extension settings, not default VS Code settings, unless they are intentionally VS Code-wide.

## Style Guide

- Prefer existing local patterns over new abstractions.
- Keep edits scoped to the extension goal.
- Prefer `const` over `let`.
- Prefer early returns over `else`.
- Avoid unnecessary destructuring; `obj.value` often preserves context better than `const { value } = obj`.
- Avoid `any`.
- Avoid `try`/`catch` unless the error is handled usefully; never leave an empty `catch`.
- Use Bun APIs when they are a good fit.
- Rely on type inference unless explicit types improve exports or clarity.
- Prefer short, clear names. Single-word names are good when they remain readable.

## TypeScript Best Practices

Curated rules — apply in code review and when authoring new code. References at the bottom.

### Types & inference
- **Annotate exported function signatures (params + return); let locals infer.** Public surface is a contract; locals lose nothing from inference.
- **Annotate object literals at declaration, not via `as`.** `const cfg: Cfg = { ... }` catches missing/renamed fields; `{ ... } as Cfg` swallows them.
- **Prefer narrowing via `typeof` / `instanceof` / `in` over assertions.** `if (x instanceof Foo) x.foo()` is checked at runtime; `(x as Foo).foo()` is not.
- **Use `unknown`, never `{}` or `Object`, for opaque values.** `{}` accepts every non-nullish value; `unknown` forces a narrow.
- **Use lowercase primitives (`string`/`number`/`boolean`).** Boxed `String`/`Number`/`Boolean` describe wrapper objects.

### Type construction
- **Default to `interface` for object shapes; reserve `type` for unions, tuples, mapped/conditional, and primitives.** Interfaces dedupe via merging and produce better errors.
- **Extend interfaces instead of intersecting types.** `interface A extends B, C {}` is cached and conflict-detected; `type A = B & C` is recomputed and can silently produce `never`.
- **Mark never-reassigned fields `readonly` and array params `readonly T[]`.** Documents intent and unblocks engine optimizations.
- **Reach for `as const` for literal tuples and string-union sources.** `const ROLES = ['user','assistant'] as const` lets you derive `type Role = (typeof ROLES)[number]`.
- **Forbid empty interfaces and unused generic params.** Both are lies about the API.
- **Prefer plain `enum` (or `as const` objects) over `const enum`.** `const enum` breaks isolated-module builds.
- **Avoid generics whose only use is in the return type.** Caller must supply `<X>` explicitly; otherwise inferred as `unknown`.
- **Extract and name complex conditional/mapped types.** Inline conditionals are recomputed per instantiation; aliases get cached.

### Null safety & runtime guards
- **Use `field?: T`, never `field: T | undefined`, for optional properties.** Optional means "may be omitted"; explicit `| undefined` forces every consumer to pass `undefined`.
- **Forbid the non-null assertion `!`.** Replace `user!.name` with `if (!user) return …`; `!` carries no runtime check and rots silently.
- **Compare enum/number values explicitly, not via truthiness.** `state !== State.None`, not `if (state)` (the zero-th member is falsy). `== null` for combined null+undefined is the one allowed loose check.
- **Use exhaustive `switch` on discriminated unions with a `never` default.** `default: const _: never = kind` makes adding a new variant a compile error everywhere.
- **Validate every external boundary at runtime.** webview ↔ host messages, provider responses, file contents, SSE chunks — parse via zod / type predicate / explicit shape check before trusting the type.

### Performance (compile- and run-time)
- **Keep hot-path call sites monomorphic.** Don't pass mixed-shape objects through the same function on streaming/render/scroll paths. V8 deoptimizes polymorphic and megamorphic sites measurably.
- **Initialize all object fields in the same order at construction; never assign later or `delete` them.** Reusing one hidden class keeps property access at fixed offsets; `delete` triggers a slow-property dictionary transition that's not reversible.
- **Don't allocate closures, arrays, or option objects inside tight loops.** Hoist them; allocations dominate streaming render budgets.
- **Use `import type { … }` for type-only imports.** Required for `isolatedModules`, eliminates the value at runtime, improves tree-shaking.
- **Run independent async work with `Promise.all` (or `allSettled`); never serialize independent awaits.**
- **Keep generics shallow and deeply-nested conditional types broken into named aliases.** Deep recursion blows up `tsc` memory.
- **Strings: array-of-chunks + single `.join('')` for SSE delta accumulation, not `+=`.** Each `+=` builds a ConsString tree; subsequent `.length`/`.slice`/`.indexOf` flattens O(total length).
- **Don't index into freshly-concatenated strings on hot paths.** `s[i]` / `.charCodeAt(i)` on a ConsString forces a flatten + full character copy.
- **Pre-fill arrays via `Array.from({length:n}, () => 0)` or push-from-empty, not `new Array(n)`.** `new Array(n)` produces HOLEY elements that never transition back to PACKED.

### API design / declarations
- **Use `void` for callbacks whose return value is ignored.** `cb: () => void` documents that the result is discarded; never `() => any`.
- **Declare callback parameters as required, not optional.** Callers may always omit trailing params; marking them `?` only confuses readers.
- **Replace overload sets with optional params or unions.** Don't write three overloads that differ only by trailing args; use `(a: string, b?: string)` or `(a: number | string)`.
- **When overloads are unavoidable, list specific signatures before general ones.** TS picks the first match.
- **Co-locate runtime schemas with their types and derive the type from the schema.** `type X = z.infer<typeof XSchema>` keeps one source of truth.

### Anti-patterns to reject in review
- **Never `as any` or `as unknown as T`.** Both bypass the checker. Isolate genuine escape hatches in a single helper with a `// SAFETY:` comment.
- **Never `@ts-ignore`; use `@ts-expect-error` with a reason.** `expect-error` becomes a build failure once the underlying error is fixed.
- **Never use wrapper constructors `new String/Number/Boolean/Array/Object`.** They produce objects whose semantics surprise everyone (`new Boolean(false)` is truthy). Use literals + `String(x)`, `Number(x)`, `Boolean(x)`.
- **Never use `Function` as a type.** Use a specific signature `(arg: T) => R`.
- **Don't spread potentially-`undefined` into arrays/objects.** `[...maybe]` throws if undefined.
- **Getters must be pure.** A getter that mutates, fetches, or logs surprises every consumer.

### References

Sources synthesized: [Google TS Style Guide](https://google.github.io/styleguide/tsguide.html), [TS Handbook Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html), [TS Wiki Performance](https://github.com/microsoft/Typescript/wiki/Performance), [V8 hidden classes](https://v8.dev/blog/fast-properties), [V8 elements kinds](https://v8.dev/blog/elements-kinds), [V8 string internals](https://iliazeus.lol/articles/js-string-optimizations-en/), [Builder.io monomorphism](https://www.builder.io/blog/monomorphic-javascript), plus W3Schools / Codiga / AWS / Medium hot-path coverage.

## Testing

- Avoid mocks when practical.
- Tests should exercise real implementation behavior, not duplicate the logic under test.
- For performance work, include or run checks that exercise long transcripts, many parts, large diffs, session switches, reconnects, or streamed updates when relevant.

## Markdown Tables

Do not pad Markdown table cells for visual alignment. Use compact tables:

```md
| Command | What it runs |
|---|---|
| `bun run extension` | Builds and launches the extension. |
```

Run this after editing Markdown tables:

```bash
bun run script/check-md-table-padding.ts --fix AGENTS.md packages/kilo-vscode/AGENTS.md
```
