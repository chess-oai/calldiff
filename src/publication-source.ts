import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parseSource } from "./extract.js";
import { collectStepsFromBody } from "./languages/typescript.js";
import { detectLanguage } from "./languages/registry.js";
import type { SyntaxNode } from "./languages/types.js";
import type { CallStep, FunctionInfo } from "./types.js";

export type PublicationFunction = {
  id: string;
  info: FunctionInfo;
  body: string;
  flow: string;
  unsupported: boolean;
  shadowed: Set<string>;
  imports: Map<string, { path: string; name: string }>;
};

const callable = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
]);
const erased = new Set([
  "comment",
  "type_annotation",
  "type_parameters",
  "type_arguments",
  "interface_declaration",
  "type_alias_declaration",
  "accessibility_modifier",
]);
const wrappers = new Set([
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
  "type_assertion",
  "parenthesized_expression",
]);

export function inspectPublicationSource(file: string, source: string) {
  const tree = parseSource(file, source);
  if (tree.rootNode.hasError) throw new Error(`Parse error in ${file}`);
  const imports = new Map<string, { path: string; name: string }>();
  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== "import_statement") continue;
    const source = statement.childForFieldName("source")?.namedChild(0)?.text;
    if (!source?.startsWith(".")) continue;
    for (const specifier of statement.descendantsOfType("import_specifier")) {
      const name = specifier.childForFieldName("name")?.text;
      const alias = specifier.childForFieldName("alias")?.text ?? name;
      if (name && alias)
        imports.set(alias, {
          path: posix.normalize(posix.join(posix.dirname(file), source)),
          name,
        });
    }
  }
  const extracted = detectLanguage(file)!.extract(file, source, tree);
  const functions = extracted.filter((fn) => {
    const node = tree.rootNode.descendantForIndex(fn.start, fn.end);
    return (
      node.parent?.type !== "arguments" ||
      !extracted.some((owner) => owner.start < fn.start && owner.end >= fn.end)
    );
  });
  const nodes = new Map<number, SyntaxNode>();

  const walk = (node: SyntaxNode) => {
    if (callable.has(node.type)) {
      nodes.set(node.startIndex, node);
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);
  // Top-level registrations and callbacks need an owner too. This source unit
  // records module call flow; it is not a claimed runtime entrypoint.
  functions.push({
    key: "<module>",
    label: `${file} (module)`,
    file,
    exported: false,
    start: -1,
    end: source.length + 1,
    steps: [],
  });
  nodes.set(-1, tree.rootNode);

  const inspected = functions.map((info): PublicationFunction => {
    const node = nodes.get(info.start)!;
    const owners = functions
      .filter((fn) => fn.start >= 0 && fn.start < info.start && fn.end >= info.end)
      .sort((a, b) => a.start - b.start);
    const id = `${file}::${[...owners.map((fn) => fn.key), info.key].join("/")}`;
    const conditions = new Map<string, string>();
    const shadowed = new Set<string>();
    let unsupported = false;
    for (let parent = node.parent; parent && !callable.has(parent.type); parent = parent.parent) {
      if (parent.type === "statement_block" && !callable.has(parent.parent?.type ?? ""))
        unsupported = true;
    }
    const inspect = (child: SyntaxNode) => {
      if (
        (child.startIndex !== node.startIndex || child.type !== node.type) &&
        callable.has(child.type) &&
        functions.some((fn) => fn.start === child.startIndex)
      )
        return;
      if (child.type === "yield_expression") unsupported = true;
      if (child.type === "formal_parameters") {
        for (const name of child.descendantsOfType([
          "identifier",
          "shorthand_property_identifier_pattern",
        ]))
          shadowed.add(name.text);
      }
      if (child.type === "catch_clause") {
        const parameter = child.childForFieldName("parameter");
        if (parameter?.type === "identifier") shadowed.add(parameter.text);
        else if (parameter) {
          for (const name of parameter.descendantsOfType([
            "identifier",
            "shorthand_property_identifier_pattern",
          ]))
            shadowed.add(name.text);
        }
      }
      if (child.type === "assignment_expression") {
        const target = child.childForFieldName("left");
        if (target?.type === "identifier") shadowed.add(target.text);
      }
      if (child.type === "variable_declarator") {
        const value = child.childForFieldName("value");
        const name = child.childForFieldName("name");
        if (
          name &&
          !functions.some((fn) => value && fn.start >= value.startIndex && fn.end <= value.endIndex)
        ) {
          if (name.type === "identifier") shadowed.add(name.text);
          else
            for (const binding of name.descendantsOfType([
              "identifier",
              "shorthand_property_identifier_pattern",
            ]))
              shadowed.add(binding.text);
        }
      }
      if (child.type === "if_statement") {
        const condition = child.childForFieldName("condition");
        if (condition) {
          const text = (
            condition.type === "parenthesized_expression"
              ? condition.namedChild(0)?.text
              : condition.text
          )
            ?.replace(/\s+/g, " ")
            .trim();
          conditions.set(`if:${text}`, fingerprint(condition));
          conditions.set(`else-if:${text}`, fingerprint(condition));
        }
      }
      for (const nested of child.namedChildren) {
        // Conditions are printed in full as opaque expressions, never expanded
        // or credited as calls to other changed functions.
        if (
          child.type === "if_statement" &&
          nested.startIndex === child.childForFieldName("condition")?.startIndex
        )
          continue;
        inspect(nested);
      }
    };
    inspect(node);
    const steps = (items: CallStep[]): CallStep[] =>
      items.map((step) => ({
        ...step,
        key:
          step.type === "branch" && conditions.has(step.key)
            ? `${step.key.split(":")[0]}:${conditions.get(step.key) ?? step.key}`
            : step.key,
        ...(step.type === "branch" || step.children
          ? { children: steps(step.children ?? []) }
          : {}),
      }));
    let className: string | null = null;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (["class_declaration", "abstract_class_declaration", "class"].includes(parent.type)) {
        className = parent.childForFieldName("name")?.text ?? null;
        break;
      }
    }
    const normalized = steps(
      collectStepsFromBody(
        file,
        info.start === -1 ? node : node.childForFieldName("body"),
        className,
        {
          isDefinition: (child) => functions.some((fn) => fn.start === child.startIndex),
          isReference: (key) =>
            !shadowed.has(key) && (functions.some((fn) => fn.key === key) || imports.has(key)),
        },
      ),
    );
    return {
      id,
      info: {
        ...info,
        label: info.label.replace(/\(\)\(/, "("),
        steps: normalized,
        line: node.startPosition.row + 1,
      },
      body:
        info.start === -1
          ? JSON.stringify(shape(normalized))
          : fingerprint(node, node, new Set(functions.map((fn) => fn.start))),
      flow: JSON.stringify(shape(normalized)),
      unsupported,
      shadowed,
      imports,
    };
  });
  return {
    functions: inspected,
  };
}

function shape(steps: CallStep[]): object[] {
  return steps.flatMap((step) => {
    const children = shape(step.children ?? []);
    return step.type === "branch" &&
      children.length === 0 &&
      !/^(return|throw|break|continue)( |$)/.test(step.key)
      ? []
      : [{ type: step.type, key: step.key, children }];
  });
}

function fingerprint(node: SyntaxNode, owner?: SyntaxNode, definitions?: Set<number>): string {
  const tokens: string[] = [];
  const visit = (part: SyntaxNode) => {
    if (erased.has(part.type)) return;
    if (
      owner &&
      part.startIndex !== owner.startIndex &&
      callable.has(part.type) &&
      definitions?.has(part.startIndex)
    ) {
      tokens.push(part.type, part.childForFieldName("name")?.text ?? "callback");
      return;
    }
    if (wrappers.has(part.type)) {
      const value = part.namedChildren.find((child) => child.type !== "type_arguments");
      if (value) visit(value);
      return;
    }
    if (["readonly", "abstract", ";", ","].includes(part.type)) return;
    if (part.type === "?" && part.parent?.type === "optional_parameter") return;
    tokens.push(part.type === "optional_parameter" ? "required_parameter" : part.type);
    if (part.childCount === 0) tokens.push(part.text);
    else for (const child of part.children) visit(child);
    tokens.push(")");
  };
  visit(node);
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}
