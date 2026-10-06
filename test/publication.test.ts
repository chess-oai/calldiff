import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { runPublication } from "../src/publication.js";
import { workspace } from "./workspace.js";

const before = `export function start() { work(); oldLog(); }
function work() { read(); }`;
const after = `export function start() { work(); newLog(); }
function work() { write(); }`;

describe("PR publication gate", () => {
  test("publishes a connected change through the real CLI", () => {
    const host = workspace({ "flow.ts": before });
    const head = host.commit("reroute", { "flow.ts": after });
    const output = host.run(["publication", "HEAD~", head, "--format", "json"]);
    expect(output.code).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({ decision: "include", coverage: 1 });
    expect(result.changedFunctions).toHaveLength(2);
    expect(result.coveredFunctions).toHaveLength(2);
    expect(result.ascii).toContain("newLog()");
    expect(result.ascii).toContain("read()");
  });

  test("counts all 100 changed functions even when invoked from a subdirectory", () => {
    const host = workspace({
      "src/flow.ts": before,
      "elsewhere/data.ts": Array.from(
        { length: 98 },
        (_, i) => `function data${i}() { return 1; }`,
      ).join("\n"),
    });
    host.commit("broad change", {
      "src/flow.ts": after,
      "elsewhere/data.ts": Array.from(
        { length: 98 },
        (_, i) => `function data${i}() { return 2; }`,
      ).join("\n"),
    });
    const result = runPublication({ cwd: join(host.root, "src"), base: "HEAD~", head: "HEAD" });
    expect(result).toMatchObject({
      decision: "omit",
      coverage: 0.02,
      ascii: "",
      reasons: ["insufficient-coverage"],
    });
    expect(result.changedFunctions).toHaveLength(100);
    expect(result.coveredFunctions).toHaveLength(2);
  });

  test("ignores type and formatting edits but counts executable argument fixes", () => {
    const host = workspace({
      "flow.ts": "function run(value: string) { send(value, 1); }",
      "flow.test.ts": before,
    });
    host.commit("types only", {
      "flow.ts": "// comment\nfunction run(value: number): void {\n send((value), 1,)\n}",
      "flow.test.ts": after,
    });
    expect(
      runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" }).changedFunctions,
    ).toEqual([]);
    host.commit("argument fix", {
      "flow.ts": "function run(value: number): void { send(value, 2); }",
    });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result.changedFunctions).toHaveLength(1);
    expect(result).toMatchObject({
      decision: "omit",
      coverage: 0,
      reasons: ["no-call-flow-changes"],
    });
  });

  test("does not count an expanded subtree as independent source edits", () => {
    const host = workspace({
      "flow.ts":
        "function start() { oldPath(); }\nfunction work() { read(); }\nfunction read() { disk(); }",
    });
    host.commit("one local edit", {
      "flow.ts":
        "function start() { work(); }\nfunction work() { read(); }\nfunction read() { disk(); }",
    });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result.changedFunctions).toHaveLength(1);
    expect(result).toMatchObject({ decision: "omit", coveredFunctions: [] });
  });

  test("refuses incomplete evidence from callbacks or unsupported languages", () => {
    const host = workspace({ "flow.ts": "export function run() { queue(() => oldPath()); }" });
    host.commit("callback change", {
      "flow.ts": "export function run() { queue(() => newPath()); }",
      "other.py": "def run():\n    work()\n",
    });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result).toMatchObject({ decision: "unsupported", coverage: null, ascii: "" });
    expect(result.reasons).toContain("unrepresented-callback:flow.ts");
    expect(result.reasons).toContain("unsupported-language:other.py");
  });

  test("does not publish oversized trees or invent calls through shadowed parameters", () => {
    const host = workspace({ "flow.ts": before });
    host.commit("oversized", {
      "flow.ts": after.replace(
        "write();",
        Array.from({ length: 40 }, (_, i) => `extra${i}();`).join(" "),
      ),
    });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" })).toMatchObject({
      decision: "omit",
      reasons: ["no-compact-connected-excerpt"],
    });
    host.commit("shadowed before", { "flow.ts": before.replace("start()", "start({work})") });
    host.commit("shadowed after", { "flow.ts": after.replace("start()", "start({work})") });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" }).decision).toBe("omit");
  });
  test("compares against the merge base without including later base-branch work", () => {
    const host = workspace({ "flow.ts": before });
    const base = host.commit("base advances", { "unrelated.ts": "function other() { work(); }" });
    execFileSync("git", ["checkout", "--detach", "HEAD~"], { cwd: host.root, stdio: "pipe" });
    const head = host.commit("PR change", { "flow.ts": after });
    const result = runPublication({ cwd: host.root, base, head });
    expect(result).toMatchObject({ decision: "include", coverage: 1 });
    expect(result.changedFunctions).toHaveLength(2);
  });

  test("does not give credit to a changed function hidden at the depth limit", () => {
    const chain = "function a() { b(); } function b() { c(); } function c() { work(); }";
    const host = workspace({
      "flow.ts": before.replace("work(); oldLog();", "a(); oldLog();") + chain,
    });
    host.commit("deep change", {
      "flow.ts": after.replace("work(); newLog();", "a(); newLog();") + chain,
    });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result.changedFunctions).toHaveLength(2);
    expect(result).toMatchObject({ decision: "omit", coveredFunctions: [] });
  });
});
