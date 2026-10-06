---
name: calldiff
description: Diff call stacks across git commits — like git diff, but for who-calls-whom. Shows which callees appeared, disappeared, or moved under an entrypoint across 22 languages (diff, tree, and reach). Use for agentic code review when call flow changed and line diffs bury the shape of the change.
requires_bin: calldiff
command: calldiff
---

# PR descriptions

Before including call-flow output in a PR description, run:

```sh
calldiff publication <base-ref> <head-ref> --format json
```

The tool calculates coverage across the complete committed PR and selects
bounded excerpts. Publish only its selected `ascii` when `decision` is `include`
and the excerpt helps explain the PR. Do not select another stack to bypass the
gate. An explicit author request may override this publication policy.

For `omit` or `unsupported`, omit the entire Calldiff section. Keep reasons and
tool limitations in the investigation, not in the PR description. `unsupported`
does not mean no behavior changed. Publication supports TypeScript/TSX and JavaScript/JSX. Expansion follows
unambiguous lexical definitions and explicit named relative imports between
changed files. Callback bodies and passed references do not establish runtime
invocation timing.

`flowCoverage` measures represented call/control-flow edits; `coverage` measures
breadth across executable-changed definitions. Neither measures semantic
correctness or usefulness. Before publishing, check that the selected roots
explain the PR's central behavior. Veto a helper move, incidental configuration,
or cleanup excerpt when it misses the change the reviewer needs to understand.
Keep the excerpt's scope clear in the surrounding PR narrative.

The commands below remain available for investigation regardless of the gate.

# calldiff diff

Diff call stacks between two git trees

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from` | `string` | no | Before ref (default: HEAD) |
| `to` | `string` | no | After ref (default: working tree) |
| `paths` | `array` | no | Limit to these path prefixes |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--entry` | `unknown` |  | Entrypoint symbol(s): functionName or ClassName.method |
| `--file` | `unknown` |  | Entrypoint file(s): indexed source path; expands to that file's exports |
| `--maxDepth` | `number` | `12` | Max call-tree depth |
| `--locs` | `boolean` | `false` | Show call-site source locations (file:line) |
| `--from` | `string` |  | Left / "before" tree |
| `--to` | `string` |  | Right / "after" tree |

## Examples

```sh
# HEAD vs working tree
calldiff diff

# One ref vs working tree
calldiff diff main

# Two commits / branches
calldiff diff abc123 def456

# Force entrypoints
calldiff diff main feature --entry createAgentSession

# File expands to that file's exports
calldiff diff main feature --file src/routes.ts
```

> Semantics match git diff: no refs → HEAD vs worktree; one ref → that vs worktree; two refs → compare those trees.

---

# calldiff reach

Find all call paths from an entrypoint to a target symbol

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ref` | `string` | no | Git ref (default: working tree) |
| `paths` | `array` | no | Limit to these path prefixes |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--entry` | `unknown` |  | Entrypoint symbol(s): functionName or ClassName.method |
| `--file` | `unknown` |  | Entrypoint file(s): indexed source path; expands to that file's exports |
| `--to` | `string` |  | Target symbol to reach (functionName or ClassName.method) |
| `--maxDepth` | `number` | `12` | Max call-tree depth |
| `--locs` | `boolean` | `false` | Show call-site source locations (file:line) |

## Examples

```sh
# Paths in the working tree
calldiff reach --entry runCheckout --to sendEmail

# Paths at a commit, limited to a directory
calldiff reach HEAD examples/checkout --entry runCheckout --to sendEmail

# Paths from every export in a file
calldiff reach --file packages/api/src/flow.ts --to notify
```

---

# calldiff tree

View a call tree (no diff) for one or more entrypoints

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ref` | `string` | no | Git ref (default: working tree) |
| `paths` | `array` | no | Limit to these path prefixes |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--entry` | `unknown` |  | Entrypoint symbol(s): functionName or ClassName.method |
| `--file` | `unknown` |  | Entrypoint file(s): indexed source path; expands to that file's exports |
| `--maxDepth` | `number` | `12` | Max call-tree depth |
| `--locs` | `boolean` | `false` | Show call-site source locations (file:line) |

## Examples

```sh
# Tree from working tree
calldiff tree --entry createAgentSession

# Tree from a commit
calldiff tree HEAD --entry PiService.createAgentSession

# Every export in a file
calldiff tree --file packages/api/src/routes.ts
```
