# calldiff

Diff call stacks across git commits — like `git diff`, but for who-calls-whom.

Built for **agentic code review**: when an agent (or you) rewires call flow, plain line diffs bury the shape of the change. `calldiff` shows which callees appeared, disappeared, or moved under an entrypoint — across **22 languages**.

```diff
  PiService.createAgentSession(options)
- ├─ AuthStorage.create()
- ├─ new ModelRegistry
- ├─ createCodingTools()
+ ├─ PiService.getServices()
+ │  ├─ SettingsManager.create()
+ │  ├─ AuthStorage.create()
+ │  └─ new ModelRegistry
```

## Prompt for agents

Paste this when you want a walkthrough of call-flow changes:

> dearest clod, walk me through the code changes you made using `npx calldiff@latest`

## Install

```bash
npx calldiff@latest
# or
npm install -g calldiff
```

## Usage

```bash
# HEAD vs working tree
calldiff diff

# one ref vs working tree
calldiff diff main

# two commits / branches
calldiff diff abc123 def456
calldiff diff --from main --to feature

# force entrypoints (functionName or ClassName.method)
calldiff diff main feature --entry createAgentSession
calldiff diff main feature -e PiService.createAgentSession -e boot

# file as entrypoint (every export in that indexed source file)
calldiff tree --file src/routes.ts
calldiff tree -F packages/api/src/boot.ts
calldiff diff main HEAD --file src/routes.ts

# limit to paths (trailing positionals; leading -- also accepted)
calldiff diff main feature src/lib

# view a call tree (no diff) — requires --entry
calldiff tree -e createAgentSession
calldiff tree HEAD -e PiService.createAgentSession
calldiff tree main -e boot --max-depth 8 src/lib
calldiff tree -e runCheckout --locs examples/checkout

# find all call paths from one symbol to another — requires --entry and --to
calldiff reach -e runCheckout --to sendEmail
calldiff reach HEAD -e runCheckout --to sendEmail examples/checkout

# agent / machine-readable output (via incur)
calldiff diff --format json
calldiff --llms
calldiff skills add   # install agent skill files
calldiff mcp add      # register as MCP server
```

### `diff` semantics (git-diff shaped)

| Invocation | From | To |
|---|---|---|
| `calldiff diff` | `HEAD` | working tree |
| `calldiff diff <from>` | `<from>` | working tree |
| `calldiff diff <from> <to>` | `<from>` | `<to>` |

`-` lines were present in **from** and gone in **to**.  
`+` lines are new in **to**.

If you omit `--entry` / `--file`, calldiff infers exported functions whose expanded call trees changed (and may show several).

`--file` / `-F` takes an indexed source path and expands to every **exported** symbol defined in that file (useful in monorepos). Matching is exact path, or a unique suffix (`boot.ts` → `packages/api/src/boot.ts`). Ambiguous matches error so you can pass a more specific path. `--entry` / `-e` is symbols only.

### PR publication gate

Use `publication` before adding a call-flow excerpt to a PR description:

```sh
calldiff publication origin/main HEAD --format json
```

The command compares the merge base with the committed head. It reads changed
source files from Git at the repository root, even when invoked from a package
directory or sparse checkout. It accepts no path or entrypoint filters, so a
narrow excerpt cannot shrink the coverage denominator.

The gate measures two things across the complete PR:

- **Flow coverage** (`flowCoverage`): the fraction of added/removed call and
  control-flow nodes represented by the selected excerpts. Changes are counted
  at their source definitions, so expanding the same helper twice earns no extra
  credit. A function earns credit only when all its flow edits are visible;
  depth-clipped callback bodies do not count.
- **Breadth** (`coverage`): covered definitions divided by all definitions with
  executable AST changes. Argument and literal edits remain in this denominator.
  This prevents a two-method excerpt from representing a hundred-method change.

Comments, formatting, and erased TypeScript types do not count. Named nested
functions are separate definitions; inline callbacks belong to their enclosing
function. Module-level call flow has a `<module>` source unit. Pure module data
edits are outside these metrics. A uniquely matched function moved between files
with an identical body does not count as two behavioral edits.

The gate requires at least 50% flow coverage and 30% breadth, within two excerpts
and 60 total tree lines. Each excerpt must show connected changed definitions,
multiple changed operations with control flow, or at least three changed call
families. Two excerpts may instead show the same call moving between roots.
A fluent chain counts as one call family for this usefulness check, and logging
calls alone cannot qualify. These thresholds select a substantial portion of the
flow; they do not claim that a diagram explains every edit or the PR's intent.

Selection prefers an existing changed caller over detached added/deleted helpers,
then chooses the shortest excerpt set meeting both coverage thresholds. Ties
prefer greater flow coverage, then stable source identity order.
Candidates include outlines with and without helper expansion, bounded to six
call edges; clipped edits never earn coverage. Only changed definitions are expanded. Unchanged context
is trimmed and marked `… unchanged`; relevant guards, exits, and neighboring
calls remain visible. Simple call arguments appear in labels to identify things
such as event names and callback references. Argument changes alone do not count
as call-flow changes.

The result contains `decision`, `reasons`, both coverage fractions,
`changedFlowNodes`, `coveredFlowNodes`, `changedFunctions`,
`flowChangedFunctions`, `coveredFunctions`, `excludedFiles`, `limits`, and
`trees`. Only `include` returns publishable `ascii`. `omit` means the gate did
not pass. `unsupported` has null coverage because parsing, ambiguous identities,
or an unsupported source language prevents a complete inventory. An unsupported
flow within a known definition stays in the denominator but earns no credit.
Neither failure result belongs in a PR description. An agent may veto an eligible
excerpt when it does not help explain the change.

Publication supports TypeScript/TSX and JavaScript/JSX, including `.mts`, `.cts`,
`.mjs`, and `.cjs`. It reuses their AST extractors and models callbacks, module
registrations, loops, switch arms, ternaries, short-circuit expressions, await,
try/catch/finally, and exits. Callback bodies and passed references are labeled
explicitly; their invocation timing is not inferred. Generator flow remains
unsupported. Complex expressions in guards are printed as opaque expressions,
not expanded or credited as calls to other definitions. These are static source
outlines, not runtime traces or data-flow proofs.

Expansion follows unambiguous lexical definitions and explicit named relative
imports between changed files. Package imports, aliases, re-exports, and dynamic
targets remain opaque. Declaration files, conventional test/spec and generated
filenames, and test, fixture, mock, generated (`gen` or `generated`), vendor,
dependency, and build directories are excluded before loading their contents.
Inspect `excludedFiles` when adopting the command in a repository with different
conventions.

### `tree`

| Invocation | Tree from |
|---|---|
| `calldiff tree -e <name>` | working tree |
| `calldiff tree <ref> -e <name>` | that commit/ref |

Prints a plain ASCII call tree (no `+/−` markers). `--entry` / `-e` or `--file` / `-F` is required.
With `--locs`, each node shows a source location: the root uses the definition
`file:line`, and children use the **call site** in the parent (`file:line` or
`file:line-line`) — same idea as LSP Call Hierarchy `fromRanges`, not Go to
Definition.

### `reach`

| Invocation | Paths from |
|---|---|
| `calldiff reach -e <from> --to <target>` | working tree |
| `calldiff reach <ref> -e <from> --to <target>` | that commit/ref |

Prints every call path from the entrypoint to the target (including alternate `if` / `else` arms). `--entry` / `-e` or `--file` / `-F`, plus `--to`, are required.

### Labels

- `functionName` — free function
- `ClassName.method` — class method
- `new ClassName` — constructor / `new` call
- `Component` — JSX/TSX component tags (`<Button />`); children nest under the parent
- `if (cond)` / `else` / `else if (cond)` — conditional arms (no continuing `│` rail)
- `file:line` — call-site (or root definition) location; enable with `--locs` (default off)

### Supported languages

TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java, Ruby, C, C++, C#, PHP, Kotlin, Swift, Scala, Lua, Elixir, Bash, Haskell, Zig, Solidity, OCaml.

## Output

- **Default:** colored ASCII callstack trees (TTY) / colorless ASCII when piped — same shape as before.
- **`--format json|yaml|md|jsonl`:** structured result (`from`/`to`/`trees` or `paths` with nested nodes + per-entry `ascii`) for agents and scripts.
- Built on [incur](https://github.com/wevm/incur): `skills add`, `mcp add`, `--llms`, CTAs after diffs, typed flags.

## How it works

1. Reads source from both git trees (`git show` / working tree)
2. Detects language by file extension, loads a [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar (bundled or on-demand into `~/.cache/calldiff/grammars`), and parses
3. Builds per-function callee lists and expands them into call trees
4. Diffs the trees, prints a tree, or searches paths — plus structured output for agents

Grammars install on first use (override cache with `CALLDIFF_GRAMMAR_CACHE`). This is syntactic (AST-based), not a full typechecker — dynamic calls won’t resolve.

## Dev

```bash
npm run dev -- diff main HEAD --entry PiService.createAgentSession
npm run dev -- tree -e runCheckout -- examples/checkout
npm run dev -- reach -e runCheckout --to sendEmail -- examples/checkout
```
