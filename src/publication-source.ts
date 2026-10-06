import { createHash } from "node:crypto";
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
const unsupportedFlow = new Set([
  "yield_expression",
  "switch_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "ternary_expression",
  "break_statement",
  "continue_statement",
]);

export function inspectPublicationSource(file: string, source: string) {
  const tree = parseSource(file, source);
  if (tree.rootNode.hasError) throw new Error(`Parse error in ${file}`);
  const functions = detectLanguage(file)!.extract(file, source, tree);
  const nodes = new Map<number, SyntaxNode>();
  const anonymous: SyntaxNode[] = [];
  const walk = (node: SyntaxNode) => {
    if (callable.has(node.type)) {
      nodes.set(node.startIndex, node);
      if (!functions.some((fn) => fn.start === node.startIndex)) anonymous.push(node);
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);

  const inspected = functions.map((info): PublicationFunction => {
    const node = nodes.get(info.start)!;
    const owners = functions
      .filter((fn) => fn.start < info.start && fn.end >= info.end)
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
      if (child !== node && callable.has(child.type)) {
        if (!functions.some((fn) => fn.start === child.startIndex)) unsupported = true;
        return;
      }
      if (unsupportedFlow.has(child.type)) unsupported = true;
      if (child.type === "call_expression" || child.type === "new_expression") {
        const callee = child.namedChild(0);
        if (callee && callee.type !== "identifier" && callee.type !== "member_expression")
          unsupported = true;
        if (
          callee?.type === "member_expression" &&
          !["identifier", "this"].includes(callee.namedChild(0)?.type ?? "")
        )
          unsupported = true;
        if (child.descendantsOfType("optional_chain").length) unsupported = true;
      }
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
      if (
        child.type === "binary_expression" &&
        child.children.some((n) => ["&&", "||", "??"].includes(n.type)) &&
        child.descendantsOfType(["call_expression", "jsx_element", "jsx_self_closing_element"])
          .length > 0
      )
        unsupported = true;
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
      collectStepsFromBody(file, node.childForFieldName("body"), className, true),
    );
    return {
      id,
      info: { ...info, steps: normalized, line: node.startPosition.row + 1 },
      body: fingerprint(node, node),
      flow: JSON.stringify(shape(normalized)),
      unsupported,
      shadowed,
    };
  });
  return {
    functions: inspected,
    // Unaddressable callbacks must not silently disappear from the denominator.
    anonymous: anonymous.map((node) => fingerprint(node)).join("\n"),
  };
}

function shape(steps: CallStep[]): object[] {
  return steps.flatMap((step) => {
    const children = shape(step.children ?? []);
    return step.type === "branch" &&
      children.length === 0 &&
      !["return", "throw"].includes(step.key)
      ? []
      : [{ type: step.type, key: step.key, children }];
  });
}

function fingerprint(node: SyntaxNode, owner?: SyntaxNode): string {
  const tokens: string[] = [];
  const visit = (part: SyntaxNode) => {
    if (erased.has(part.type)) return;
    if (owner && part !== owner && callable.has(part.type)) {
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
