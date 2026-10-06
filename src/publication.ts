import { buildCallTreeFromInfo } from "./calltree.js";
import { treeHasChanges } from "./diff.js";
import { buildIndex } from "./extract.js";
import { readPublicationSnapshots } from "./git.js";
import { diffPinnedEntry } from "./infer.js";
import { listSupportedExtensions } from "./languages/registry.js";
import { inspectPublicationSource } from "./publication-source.js";
import { renderDiff } from "./render.js";
import type { PublicationFunction } from "./publication-source.js";
import type { CallNode, CallStep, DiffNode, DiffTreeResult } from "./types.js";

export type PublicationResult = {
  mode: "publication";
  from: string;
  to: string;
  decision: "include" | "omit" | "unsupported";
  reasons: string[];
  coverage: number | null;
  changedFunctions: string[];
  coveredFunctions: string[];
  excludedFiles: string[];
  limits: typeof limits;
  trees: DiffTreeResult[];
  ascii: string;
};

type Candidate = { result: DiffTreeResult; covered: Set<string>; lines: number };

const limits = Object.freeze({ coverage: 0.8, excerpts: 2, lines: 30, depth: 4 });
const excluded =
  /(^|\/)(?:__tests__|__fixtures__|__mocks__|tests?|fixtures?|generated|gen|vendor|node_modules|dist)(\/|$)|\.(?:test|spec|generated|gen)\.[^/]+$|\.d\.(?:ts|mts|cts)$/i;
const supported = /\.(?:ts|tsx|mts|cts)$/i;
const sourceExtensions = new Set(listSupportedExtensions());

/** Decide whether a complete PR has a compact, representative call-flow excerpt. */
export function runPublication(options: {
  base: string;
  head: string;
  cwd?: string;
}): PublicationResult {
  const snapshots = readPublicationSnapshots(
    options.cwd ?? process.cwd(),
    options.base,
    options.head,
    (file) => !excluded.test(file) && supported.test(file),
  );
  const reasons: string[] = [];
  const excludedFiles = snapshots.paths.filter((file) => excluded.test(file));
  const files = snapshots.paths.filter(
    (file) => !excluded.test(file) && sourceExtensions.has(file.slice(file.lastIndexOf("."))),
  );
  const before = new Map<string, PublicationFunction>();
  const after = new Map<string, PublicationFunction>();
  for (const file of files) {
    if (!supported.test(file)) {
      reasons.push(`unsupported-language:${file}`);
      continue;
    }
    try {
      const left = inspectPublicationSource(file, snapshots.before.get(file) ?? "");
      const right = inspectPublicationSource(file, snapshots.after.get(file) ?? "");
      if (left.anonymous !== right.anonymous) reasons.push(`unrepresented-callback:${file}`);
      for (const [source, destination] of [
        [left, before],
        [right, after],
      ] as const) {
        for (const fn of source.functions) {
          if (destination.has(fn.id)) reasons.push(`ambiguous-function:${fn.id}`);
          destination.set(fn.id, fn);
        }
      }
    } catch (error) {
      reasons.push(
        `parse-failed:${file}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const changedFunctions = [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => before.get(id)?.body !== after.get(id)?.body)
    .sort();
  const flowChanged = new Set(
    changedFunctions.filter(
      (id) => (before.get(id)?.flow ?? "[]") !== (after.get(id)?.flow ?? "[]"),
    ),
  );
  for (const id of flowChanged) {
    if (before.get(id)?.unsupported || after.get(id)?.unsupported)
      reasons.push(`unsupported-flow:${id}`);
  }
  const result: PublicationResult = {
    mode: "publication",
    from: snapshots.from,
    to: snapshots.to,
    decision: "unsupported",
    reasons,
    coverage: null,
    changedFunctions,
    coveredFunctions: [],
    excludedFiles,
    limits,
    trees: [],
    ascii: "",
  };
  if (reasons.length > 0) return result;

  const beforeIndex = publicationIndex(before);
  const afterIndex = publicationIndex(after);
  const candidates: Candidate[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = beforeIndex.get(id);
    const right = afterIndex.get(id);
    const diff = diffPinnedEntry(id, left, right, beforeIndex, afterIndex, limits.depth);
    if (!diff) continue;
    const leftComplete = left
      ? completeFunctions(buildCallTreeFromInfo(left, beforeIndex, limits.depth), before)
      : new Set<string>();
    const rightComplete = right
      ? completeFunctions(buildCallTreeFromInfo(right, afterIndex, limits.depth), after)
      : new Set<string>();
    if (
      [...leftComplete].some((key) => before.get(key)?.unsupported) ||
      [...rightComplete].some((key) => after.get(key)?.unsupported)
    )
      continue;
    const covered = new Set(
      [...flowChanged].filter(
        (key) =>
          (!before.has(key) || leftComplete.has(key)) &&
          (!after.has(key) || rightComplete.has(key)),
      ),
    );
    // Two isolated local edits do not become explanatory merely by sharing a budget.
    if (covered.size < 2) continue;
    const tree = prune(diff);
    const ascii = renderDiff(tree, { color: false });
    const lines = ascii.split("\n").length;
    if (lines > limits.lines) continue;
    candidates.push({ result: { entry: id, tree, ascii }, covered, lines });
  }

  let selected: Candidate[] = [];
  let covered = new Set<string>();
  let lineCount = Infinity;
  const consider = (items: Candidate[]) => {
    const lines = items.reduce((sum, item) => sum + item.lines, items.length - 1);
    if (lines > limits.lines) return;
    const union = new Set(items.flatMap((item) => [...item.covered]));
    if (union.size > covered.size || (union.size === covered.size && lines < lineCount)) {
      selected = items;
      covered = union;
      lineCount = lines;
    }
  };
  // Sorted source identities make ties stable without model-selected entrypoints.
  for (let i = 0; i < candidates.length; i++) {
    consider([candidates[i]!]);
    for (let j = i + 1; j < candidates.length; j++) consider([candidates[i]!, candidates[j]!]);
  }
  result.coveredFunctions = [...covered].sort();
  result.coverage = changedFunctions.length ? covered.size / changedFunctions.length : 0;
  result.decision = result.coverage >= limits.coverage ? "include" : "omit";
  if (!changedFunctions.length) reasons.push("no-executable-function-changes");
  else if (!flowChanged.size) reasons.push("no-call-flow-changes");
  else if (!candidates.length) reasons.push("no-compact-connected-excerpt");
  else if (result.decision === "omit") reasons.push("insufficient-coverage");
  if (result.decision === "include") {
    result.trees = selected.map((item) => item.result);
    result.ascii = result.trees.map((tree) => tree.ascii).join("\n\n");
  }
  return result;
}

function publicationIndex(functions: Map<string, PublicationFunction>) {
  const definitions = [...functions.values()];
  return buildIndex(
    definitions.map((fn) => {
      const steps = (items: CallStep[]): CallStep[] =>
        items.map((step) => {
          // Expand only lexical definitions in this file. Imported/dynamic calls remain
          // opaque leaves; the ordinary graph's global name fallback cannot prove identity.
          const shadowed = definitions.some(
            (owner) =>
              owner.info.file === fn.info.file &&
              owner.info.start <= fn.info.start &&
              owner.info.end >= fn.info.end &&
              (owner.shadowed.has(step.key) || owner.shadowed.has(step.key.split(".")[0]!)),
          );
          const matches =
            step.type === "call" && !shadowed
              ? definitions.filter(
                  (target) =>
                    target.info.file === fn.info.file &&
                    target.info.key === step.key &&
                    (!target.info.local ||
                      definitions.some(
                        (owner) =>
                          owner.info.file === fn.info.file &&
                          owner.info.start < target.info.start &&
                          owner.info.end >= target.info.end &&
                          owner.info.start <= fn.info.start &&
                          owner.info.end >= fn.info.end,
                      )),
                )
              : [];
          const target = matches.length === 1 ? matches[0] : undefined;
          return {
            ...step,
            key: target?.id ?? step.key,
            ...(step.type === "branch" || step.children
              ? { children: steps(step.children ?? []) }
              : {}),
          };
        });
      return { ...fn.info, key: fn.id, steps: steps(fn.info.steps) };
    }),
  );
}

function completeFunctions(
  tree: CallNode,
  functions: Map<string, PublicationFunction>,
): Set<string> {
  const complete = new Set<string>();
  const visit = (node: CallNode, depth: number) => {
    if (functions.has(node.key) && depth < limits.depth && !node.label.endsWith(" ⇄"))
      complete.add(node.key);
    for (const child of node.children) visit(child, depth + (node.kind === "branch" ? 0 : 1));
  };
  visit(tree, 0);
  return complete;
}

function prune(node: DiffNode): DiffNode {
  const directChange = node.children.some((child) => child.status !== "same");
  return {
    ...node,
    children: node.children
      .filter((child) => directChange || treeHasChanges(child))
      .map((child) => (treeHasChanges(child) ? prune(child) : { ...child, children: [] })),
  };
}
