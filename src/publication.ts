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
  flowCoverage: number | null;
  flowChangedFunctions: string[];
  changedFlowUnits: number;
  coveredFlowUnits: number;
  changedFunctions: string[];
  coveredFunctions: string[];
  excludedFiles: string[];
  limits: typeof limits;
  trees: DiffTreeResult[];
  ascii: string;
};

type Candidate = {
  result: DiffTreeResult;
  covered: Set<string>;
  lines: number;
  useful: boolean;
  added: Set<string>;
  removed: Set<string>;
};

const limits = Object.freeze({
  coverage: 0.3,
  flowCoverage: 0.5,
  excerpts: 2,
  lines: 60,
  depth: 6,
});
const excluded =
  /(^|\/)(?:__tests__|__fixtures__|__mocks__|tests?|fixtures?|generated|gen|vendor|node_modules|dist)(\/|$)|\.(?:test|spec|generated|gen)\.[^/]+$|\.d\.(?:ts|mts|cts)$/i;
const supported = /\.(?:[cm]?[tj]s|[tj]sx)$/i;
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

  const moved = new Set<string>();
  for (const left of before.values()) {
    if (after.has(left.id) || left.info.key === "<module>") continue;
    const matches = [...after.values()].filter(
      (right) =>
        !before.has(right.id) && right.info.key === left.info.key && right.body === left.body,
    );
    if (
      matches.length === 1 &&
      [...before.values()].filter(
        (other) =>
          !after.has(other.id) && other.info.key === left.info.key && other.body === left.body,
      ).length === 1
    ) {
      moved.add(left.id);
      moved.add(matches[0]!.id);
    }
  }
  const changedFunctions = [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => !moved.has(id))
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
    flowCoverage: null,
    flowChangedFunctions: [...flowChanged].sort(),
    changedFlowUnits: 0,
    coveredFlowUnits: 0,
    changedFunctions,
    coveredFunctions: [],
    excludedFiles,
    limits,
    trees: [],
    ascii: "",
  };
  if (reasons.some((reason) => !reason.startsWith("unsupported-flow:"))) return result;

  const beforeIndex = publicationIndex(before, flowChanged);
  const afterIndex = publicationIndex(after, flowChanged);
  const emptyIndex = buildIndex([]);
  const edits = new Map(
    [...flowChanged].map((id) => {
      const direct = diffPinnedEntry(
        id,
        beforeIndex.get(id),
        afterIndex.get(id),
        emptyIndex,
        emptyIndex,
        Infinity,
      );
      return [id, direct ? changedNodes(direct) : new Set<string>()];
    }),
  );
  // A new/removed definition is one structural change. Counting every node in
  // its body lets an extracted helper outweigh the caller behavior being changed.
  const flowWeight = (id: string) => (before.has(id) && after.has(id) ? edits.get(id)!.size : 1);
  result.changedFlowUnits = [...flowChanged].reduce((sum, id) => sum + flowWeight(id), 0);
  const candidates: Candidate[] = [];
  for (const id of [...flowChanged].sort()) {
    const left = beforeIndex.get(id);
    const right = afterIndex.get(id);
    for (const [leftIndex, rightIndex] of [
      [beforeIndex, afterIndex],
      [emptyIndex, emptyIndex],
    ] as const) {
      const diff = diffPinnedEntry(id, left, right, leftIndex, rightIndex, limits.depth);
      if (!diff) continue;
      const leftComplete = left
        ? completeFunctions(buildCallTreeFromInfo(left, leftIndex, limits.depth), before)
        : new Set<string>();
      const rightComplete = right
        ? completeFunctions(buildCallTreeFromInfo(right, rightIndex, limits.depth), after)
        : new Set<string>();
      const tree = prune(diff);
      const visible = changedNodes(tree);
      const covered = new Set(
        [...flowChanged].filter(
          (key) =>
            (!before.has(key) || leftComplete.has(key)) &&
            (!after.has(key) || rightComplete.has(key)) &&
            [...edits.get(key)!].every((edit) => visible.has(edit)),
        ),
      );
      if (
        !covered.size ||
        [...covered].some((key) => before.get(key)?.unsupported || after.get(key)?.unsupported)
      )
        continue;
      const added = new Set<string>();
      const removed = new Set<string>();
      let changedControl = false;
      const visit = (node: DiffNode): void => {
        if (node.key.startsWith("reference:")) return;
        if (node.kind === "branch" && node.status !== "same") changedControl = true;
        if (
          node.kind !== "branch" &&
          !/(?:^|[.])(?:logger|log|console)(?:[.(]|$)/i.test(node.key)
        ) {
          if (node.status === "added") added.add(node.key);
          if (node.status === "removed") removed.add(node.key);
        }
        for (const child of node.children) visit(child);
      };
      const direct = diffPinnedEntry(id, left, right, emptyIndex, emptyIndex, Infinity);
      for (const child of direct?.children ?? []) visit(child);
      const changedCalls = new Set([...added, ...removed].map((key) => key.replace(/\(\).*$/, "")));
      const useful =
        covered.size >= 2 || (changedCalls.size >= 2 && changedControl) || changedCalls.size >= 3;
      const ascii = renderDiff(tree, { color: false });
      const lines = ascii.split("\n").length;
      if (lines > limits.lines) continue;
      candidates.push({
        result: { entry: id, tree, ascii },
        covered,
        lines,
        useful,
        added,
        removed,
      });
    }
  }

  let selected: Candidate[] = [];
  let covered = new Set<string>();
  let lineCount = Infinity;
  let coveredEdits = 0;
  let eligible = false;
  let hasExistingRoot = false;
  const consider = (items: Candidate[]) => {
    if (items.length === 2 && items[0]!.result.entry === items[1]!.result.entry) return;
    // Moving the same call between roots is useful even when each half alone
    // is a trivial leaf edit (for example, moving a component under a provider).
    if (
      !items.every((item) => item.useful) &&
      !(
        items.length === 2 &&
        items.some((item, i) =>
          [...item.added].some(
            (key) =>
              !item.removed.has(key) &&
              items[1 - i]!.removed.has(key) &&
              !items[1 - i]!.added.has(key),
          ),
        )
      )
    )
      return;
    const lines = items.reduce((sum, item) => sum + item.lines, items.length - 1);
    if (lines > limits.lines) return;
    const union = new Set(items.flatMap((item) => [...item.covered]));
    const editCount = [...union].reduce((sum, key) => sum + flowWeight(key), 0);
    const passes =
      union.size / changedFunctions.length >= limits.coverage &&
      editCount / result.changedFlowUnits >= limits.flowCoverage;
    const existingRoot = items.some(
      (item) => before.has(item.result.entry) && after.has(item.result.entry),
    );
    // Prefer the changed call site over a detached added/deleted helper, then
    // stop expanding once a representative explanation fits.
    if (
      (passes && !eligible) ||
      (passes === eligible &&
        (passes
          ? (existingRoot && !hasExistingRoot) ||
            (existingRoot === hasExistingRoot &&
              (lines < lineCount || (lines === lineCount && editCount > coveredEdits)))
          : editCount > coveredEdits || (editCount === coveredEdits && lines < lineCount)))
    ) {
      eligible = passes;
      hasExistingRoot = existingRoot;
      coveredEdits = editCount;
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
  result.coveredFlowUnits = coveredEdits;
  result.flowCoverage = result.changedFlowUnits ? coveredEdits / result.changedFlowUnits : 0;
  result.decision =
    result.coverage >= limits.coverage && result.flowCoverage >= limits.flowCoverage
      ? "include"
      : "omit";
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

function publicationIndex(functions: Map<string, PublicationFunction>, changed: Set<string>) {
  const definitions = [...functions.values()];
  return buildIndex(
    definitions.map((fn) => {
      const steps = (items: CallStep[]): CallStep[] =>
        items.map((step) => {
          // Expand only proven lexical or named relative-import targets; the ordinary
          // graph's global name fallback cannot prove identity.
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
                          owner.info.start >= 0 &&
                          owner.info.start < target.info.start &&
                          owner.info.end >= target.info.end &&
                          owner.info.start <= fn.info.start &&
                          owner.info.end >= fn.info.end,
                      )),
                )
              : [];
          const imported = fn.imports.get(step.key);
          if (step.type === "call" && !shadowed && imported && !matches.length) {
            const stem = imported.path.replace(/\.[cm]?[jt]sx?$/, "");
            matches.push(
              ...definitions.filter(
                (target) =>
                  target.info.exported &&
                  target.info.key === imported.name &&
                  [stem, `${stem}/index`].includes(target.info.file.replace(/\.[cm]?[jt]sx?$/, "")),
              ),
            );
          }
          const target = matches.length === 1 ? matches[0] : undefined;
          return {
            ...step,
            key: target && changed.has(target.id) ? target.id : step.key,
            ...(step.type === "branch" || step.children
              ? { children: steps(step.children ?? []) }
              : {}),
          };
        });
      return {
        ...fn.info,
        key: fn.id,
        steps: changed.has(fn.id) ? steps(fn.info.steps) : [],
      };
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
  const changed = node.children.map(treeHasChanges);
  const keep = changed.map((value, i) => value || changed[i - 1] || changed[i + 1]);
  for (let i = 0; i < node.children.length; i++) {
    if (!keep[i] || !/^else( |$)/.test(node.children[i]!.label)) continue;
    for (let j = i - 1; j >= 0; j--) {
      keep[j] = true;
      if (/^if /.test(node.children[j]!.label)) break;
      if (!/^else( |$)/.test(node.children[j]!.label)) break;
    }
  }
  const children: DiffNode[] = [];
  let omitted = false;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    if (keep[i]) {
      children.push(changed[i] ? prune(child) : context(child));
      omitted = false;
    } else if (!omitted) {
      children.push({
        key: "omitted",
        label: "… unchanged",
        kind: "branch",
        status: "same",
        children: [],
      });
      omitted = true;
    }
  }
  return { ...node, children };
}

function context(node: DiffNode): DiffNode {
  return {
    ...node,
    children:
      node.kind !== "branch"
        ? []
        : node.key === "try" && node.children.length
          ? [
              {
                key: "omitted",
                label: "… unchanged",
                kind: "branch",
                status: "same",
                children: [],
              },
            ]
          : node.children.map(context),
  };
}

// Columns distinguish repeated calls on the same source line.
function changedNodes(tree: DiffNode): Set<string> {
  const nodes = new Set<string>();
  const visit = (node: DiffNode) => {
    if (node.status !== "same")
      nodes.add(JSON.stringify([node.status, node.key, node.file, node.line, node.column]));
    for (const child of node.children) visit(child);
  };
  for (const child of tree.children) visit(child);
  return nodes;
}
