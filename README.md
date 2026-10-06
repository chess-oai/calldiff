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

Coverage is the number of changed functions whose complete direct call-flow
edits appear in the selected excerpts, divided by all functions with executable
AST changes. Each source function counts once. Comments, formatting, and erased
TypeScript types do not count; argument and literal fixes do count, even when
their call trees are unchanged. Nested named functions are counted separately
from their enclosing function. Matching uses file, enclosing function scope, and
name; moves and renames count as removals and additions.

The fixed initial gate requires:

- At least two directly changed functions connected in each excerpt, or one
  changed function with at least two distinct changed callees inside changed
  control flow (for example, a guarded retry)
- At least 80% coverage across the PR
- At most two excerpts and 30 total tree lines, including the separator
- At most four call edges below each root, with no credit for clipped bodies

Candidates come from definitions in the changed files. Selection maximizes
distinct covered functions, then minimizes lines, then uses stable source
identity order. Unchanged siblings are pruned unless needed to show the context
of a direct edit, such as reordered calls. Retained control-flow context keeps
its exits and calls visible, including the work following a retry.

The JSON result contains `decision`, `reasons`, `coverage` (a fraction),
`changedFunctions`, `coveredFunctions`, `excludedFiles`, `limits`, and `trees`.
Only `include` returns publishable `ascii`. `omit` means the gate did not pass.
`unsupported` has null coverage because the tool cannot certify the comparison;
its function inventory may be incomplete. Neither result should produce a
Calldiff section or diagnostic text in a PR description. An agent may omit an
eligible excerpt, but should not override a failed gate without author direction.

This first version supports TypeScript and TSX, including `.mts` and `.cts`.
It excludes declaration files, conventional test/spec and generated filenames,
and test, fixture, mock, generated (`gen` or `generated`), vendor, dependency,
and build directories. Excluded and unsupported file contents are not loaded.
These are path conventions, not a semantic classifier; inspect `excludedFiles`
when adopting the command in a repository with different conventions.

To avoid guessed call relationships, expansion follows only unambiguous lexical
definitions in the same changed file. Imported and dynamic targets remain
opaque leaves. Unchanged files are not indexed. Changed anonymous callbacks,
parse failures, and unsupported source languages prevent publication. Flow
changes involving constructs the publication outline does not model, including
loops, switch, ternaries, and short-circuit calls, also return `unsupported`.
Publication outlines preserve `await`, `try`/`catch`/`finally`, and `return`/`throw`.
Conditions appear in full as opaque expressions; calls inside them are not
expanded or credited as coverage of their callees. These are static source
outlines, not runtime traces. Module-level changes are outside the function
coverage metric.
These limits favor omission; the thresholds are starting policy, not a measured
guarantee that an excerpt explains the PR's purpose.

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
