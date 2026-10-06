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
    const host = workspace({
      "flow.ts": before,
      "src/gen/types.ts": "generated before",
    });
    const head = host.commit("reroute", {
      "flow.ts": after,
      "src/gen/types.ts": "generated after",
    });
    const output = host.run(["publication", "HEAD~", head, "--format", "json"]);
    expect(output.code).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({ decision: "include", coverage: 1 });
    expect(result.changedFunctions).toHaveLength(2);
    expect(result.coveredFunctions).toHaveLength(2);
    expect(result.excludedFiles).toContain("src/gen/types.ts");
    expect(result.ascii).toContain("newLog()");
    expect(result.ascii).toContain("read()");
  });

  test("publishes an awaited retry with its catch guard and following work", () => {
    const host = workspace({
      "flow.ts": `async function refresh() {
        if (environment.skip?.trim() === "yes") return;
        await storage.prepare(path.dirname(destination));
        await storage.remove(destination);
        await copy(destination);
      }`,
    });
    host.commit("retry permission failure", {
      "flow.ts": `async function refresh() {
        if (environment.skip?.trim() === "yes") return;
        await storage.prepare(path.dirname(destination));
        try { await storage.remove(destination); }
        catch (error) {
          if (error.code !== "ACCESS") throw error;
          await repair(destination);
          await storage.remove(destination);
        }
        await copy(destination);
      }`,
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result).toMatchObject({ decision: "include", coverage: 1 });
    expect(result.changedFunctions).toHaveLength(1);
    expect(result.ascii).toContain("catch (error)");
    expect(result.ascii).toContain('if (error.code !== "ACCESS")');
    expect(result.ascii).toContain("throw");
    expect(result.ascii).toContain("… unchanged");
    expect(result.ascii).toContain("repair(destination)");
    expect(result.ascii).toContain("copy(destination)");
    expect(result.ascii.indexOf("path.dirname(destination)")).toBeLessThan(
      result.ascii.indexOf("storage.prepare(…)"),
    );
  });

  test("does not publish one renamed call or one changed call guard", () => {
    const host = workspace({
      "flow.ts": "function run() { if (ready) send(); }",
    });
    host.commit("guard change", {
      "flow.ts": "function run() { if (enabled) send(); }",
    });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" }).decision).toBe("omit");
    host.commit("callee change", {
      "flow.ts": "function run() { if (enabled) deliver(); }",
    });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" }).decision).toBe("omit");
  });

  test("counts all 100 changed functions even when invoked from a subdirectory", () => {
    const host = workspace({
      "src/flow.ts": before,
      "elsewhere/data.ts": Array.from({ length: 98 }, (_, i) => `const data${i} = () => 1;`).join(
        "\n",
      ),
    });
    host.commit("broad change", {
      "src/flow.ts": after,
      "elsewhere/data.ts": Array.from({ length: 98 }, (_, i) => `const data${i} = () => 2;`).join(
        "\n",
      ),
    });
    const result = runPublication({
      cwd: join(host.root, "src"),
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result).toMatchObject({
      decision: "omit",
      coverage: 0.02,
      ascii: "",
      reasons: ["insufficient-coverage"],
    });
    expect(result.changedFunctions).toHaveLength(100);
    expect(result.coveredFunctions).toHaveLength(2);
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" })).toEqual(result);
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
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
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
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result.changedFunctions).toHaveLength(1);
    expect(result).toMatchObject({ decision: "omit", coveredFunctions: [] });
  });

  test("refuses incomplete evidence from unsupported languages", () => {
    const host = workspace({
      "flow.ts": "export function run() { queue(() => oldPath()); }",
    });
    host.commit("callback change", {
      "flow.ts": "export function run() { queue(() => newPath()); }",
      "other.py": "def run():\n    work()\n",
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result).toMatchObject({
      decision: "unsupported",
      coverage: null,
      ascii: "",
    });
    expect(result.reasons).toContain("unsupported-language:other.py");
  });

  test("does not publish oversized trees or invent calls through shadowed parameters", () => {
    const host = workspace({ "flow.ts": before });
    host.commit("oversized", {
      "flow.ts": after.replace(
        "write();",
        Array.from({ length: 70 }, (_, i) => `extra${i}();`).join(" "),
      ),
    });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" })).toMatchObject({
      decision: "omit",
      ascii: "",
    });
    host.commit("shadowed before", {
      "flow.ts": before.replace("start()", "start({work})"),
    });
    host.commit("shadowed after", {
      "flow.ts": after.replace("start()", "start({work})"),
    });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" }).decision).toBe("omit");
    host.commit("catch before", {
      "flow.ts":
        "function start() { try { oldPath(); } catch (work) { work(); } } function work() { read(); }",
    });
    host.commit("catch after", {
      "flow.ts":
        "function start() { try { newPath(); } catch (work) { work(); } } function work() { write(); }",
    });
    expect(runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" }).decision).toBe("omit");
  });
  test("compares against the merge base without including later base-branch work", () => {
    const host = workspace({ "flow.ts": before });
    const base = host.commit("base advances", {
      "unrelated.ts": "function other() { work(); }",
    });
    execFileSync("git", ["checkout", "--detach", "HEAD~"], {
      cwd: host.root,
      stdio: "pipe",
    });
    const head = host.commit("PR change", { "flow.ts": after });
    const result = runPublication({ cwd: host.root, base, head });
    expect(result).toMatchObject({ decision: "include", coverage: 1 });
    expect(result.changedFunctions).toHaveLength(2);
  });

  test("does not give credit to a changed function hidden at the depth limit", () => {
    const chain =
      "function a() { b(); } function b() { c(); } function c() { d(); } function d() { e(); } function e() { work(); }";
    const host = workspace({
      "flow.ts": before.replace("work(); oldLog();", "a(); oldLog();") + chain,
    });
    host.commit("deep change", {
      "flow.ts": after.replace("work(); newLog();", "a(); newLog();") + chain,
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result.changedFunctions).toHaveLength(2);
    expect(result).toMatchObject({ decision: "omit", coveredFunctions: [] });
  });
  test("represents deferred module callbacks in JavaScript without claiming immediate calls", () => {
    const host = workspace({
      "boot.mjs": `events.on("ready", async () => { await open(); });`,
    });
    host.commit("guard deferred startup", {
      "boot.mjs": `events.on("ready", async () => {
      if (ready) { await prepare(); await open(); } else { await defer(); }
    });`,
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result).toMatchObject({
      decision: "include",
      coverage: 1,
      flowCoverage: 1,
    });
    expect(result.ascii).toContain('events.on("ready", callback)');
    expect(result.ascii).toContain("callback (not an immediate call)");
    expect(result.ascii).toContain("if (ready)");
    expect(result.ascii).toContain("defer()");
  });

  test("pairs a component removal with its guarded insertion under another root", () => {
    const host = workspace({
      "old.tsx": "function OldRoot() { return <Menu />; }",
      "new.tsx": "function NewRoot() { return <Page />; }",
    });
    host.commit("move menu", {
      "old.tsx": "function OldRoot() { return null; }",
      "new.tsx": "function NewRoot() { return <><Page />{ready ? <Menu /> : null}</>; }",
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result).toMatchObject({
      decision: "include",
      coverage: 1,
      flowCoverage: 1,
    });
    expect(result.trees).toHaveLength(2);
    expect(result.ascii).toContain("OldRoot()");
    expect(result.ascii).toContain("NewRoot()");
    expect(result.ascii).toContain("if (ready)");
  });

  test("does not mistake fluent validation or argument edits for a multi-step flow", () => {
    const host = workspace({
      "parse.ts": `const schema = z.string().min(1).max(20);
      function parse(input) { return new Pattern("before").exec(input).trim(); }`,
    });
    host.commit("relax data validation", {
      "parse.ts": `const schema = z.string().optional().catch(undefined);
      function parse(input) { return new Pattern("after").exec(input).trim(); }`,
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result.decision).toBe("omit");
    expect(result.ascii).toBe("");
  });

  test("does not credit a callback whose changed body is clipped", () => {
    const host = workspace({
      "flow.ts": `function run() {
      queue(() => queue(() => queue(() => queue(() => queue(() => queue(() => queue(() => oldPath())))))));
    }`,
    });
    host.commit("deep callback routing", {
      "flow.ts": `function run() {
      queue(() => queue(() => queue(() => queue(() => queue(() => queue(() => queue(() => {
        if (ready) prepare(); else retry(); finish();
      })))))));
    }`,
    });
    const result = runPublication({
      cwd: host.root,
      base: "HEAD~",
      head: "HEAD",
    });
    expect(result).toMatchObject({
      decision: "omit",
      coveredFlowUnits: 0,
      coveredFunctions: [],
    });
  });
  test("follows named relative imports and shows passed handlers as references", () => {
    const host = workspace({
      "main.ts":
        'import { handle } from "./handler.js"; function start() { events.on("ready", handle); oldLog(); }',
      "handler.ts": "export function handle() { open(); }",
    });
    host.commit("guard event handling", {
      "main.ts":
        'import { handle } from "./handler.js"; function start() { events.on("ready", handle); newLog(); }',
      "handler.ts": "export function handle() { recover(); }",
    });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result).toMatchObject({ decision: "include", coverage: 1, flowCoverage: 1 });
    expect(result.ascii).toContain("passed reference (invocation not inferred)");
    expect(result.ascii).toContain("definition: handle");
    expect(result.ascii).toContain("recover()");
    expect(result.coveredFunctions).toHaveLength(2);
  });
  test("keeps argument evaluation inside an optional call's guard", () => {
    const host = workspace({ "flow.ts": "function send() { fallback(); }" });
    host.commit("optional delivery", { "flow.ts": "function send() { deliver?.(prepare()); }" });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result.decision).toBe("include");
    const children = result.trees[0]!.tree.children;
    expect(
      children
        .find((node) => node.label === "if available (deliver)")
        ?.children.map((node) => node.label),
    ).toEqual(["prepare()", "deliver(…)"]);
    expect(children.some((node) => node.label === "prepare()")).toBe(false);
  });
  test("keeps a new helper body from outweighing changed caller behavior", () => {
    const host = workspace({
      "flow.ts": `function onClose() { hide(); }
      function settings() { read(); }`,
    });
    host.commit("quit behavior and settings helper", {
      "flow.ts": `
      function onClose() { if (quitting) { preventDefault(); quit(); return; } hide(); }
      function settings() { initialize(); read(); }
      function initialize() { scan(); parse(); validate(); join(); resolve(); cache(); }`,
    });
    const result = runPublication({ cwd: host.root, base: "HEAD~", head: "HEAD" });
    expect(result.decision).toBe("include");
    expect(result.trees.map((tree) => tree.entry)).toEqual(["flow.ts::onClose"]);
  });
});
