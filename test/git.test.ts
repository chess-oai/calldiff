import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  listSnapshotFiles,
  readSnapshotFiles,
} from "../src/git.js";
import type { Snapshot } from "../src/types.js";

const tempDirs: string[] = [];
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "calldiff-git-"));
  tempDirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  return cwd;
}

function commitAll(cwd: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
}

function runCli(cwd: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    [
      join(projectRoot, "node_modules/tsx/dist/cli.mjs"),
      join(projectRoot, "src/cli.ts"),
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs a commit-to-commit diff end to end", () => {
  const cwd = makeRepo();
  writeFileSync(
    join(cwd, "app.ts"),
    "export function root() { beforeCall(); }\n",
  );
  commitAll(cwd);
  const before = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();

  writeFileSync(
    join(cwd, "app.ts"),
    "export function root() { afterCall(); }\n",
  );
  commitAll(cwd);

  const output = runCli(cwd, ["diff", before, "HEAD", "--entry", "root"]);
  expect(output).toContain("- ├─ beforeCall()");
  expect(output).toContain("+ └─ afterCall()");
});

test("lists tracked and non-ignored worktree sources", () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, ".config"));
  writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
  writeFileSync(join(cwd, ".config/tracked.ts"), "export const tracked = 1;\n");
  writeFileSync(join(cwd, "deleted.ts"), "export const deleted = 1;\n");
  commitAll(cwd);

  rmSync(join(cwd, "deleted.ts"));
  mkdirSync(join(cwd, "ignored"));
  writeFileSync(join(cwd, "ignored/skip.ts"), "export const skip = 1;\n");
  writeFileSync(join(cwd, "untracked.ts"), "export const untracked = 1;\n");

  const snapshot: Snapshot = { kind: "worktree", ref: "WORKTREE" };
  const files = listSnapshotFiles(cwd, snapshot);
  const sources = readSnapshotFiles(cwd, snapshot, files);

  expect(files.map((file) => file.path)).toEqual([
    ".config/tracked.ts",
    "untracked.ts",
  ]);
  expect([...sources.keys()]).toEqual([
    ".config/tracked.ts",
    "untracked.ts",
  ]);
});

test.skipIf(process.platform === "win32")(
  "skips source-shaped symlinks in commits and the worktree",
  () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, "source.txt"), "export function linked() {}\n");
    symlinkSync("source.txt", join(cwd, "linked.ts"));
    commitAll(cwd);

    const commit: Snapshot = { kind: "commit", ref: "HEAD" };
    const worktree: Snapshot = { kind: "worktree", ref: "WORKTREE" };

    expect(listSnapshotFiles(cwd, commit)).toEqual([]);
    expect(listSnapshotFiles(cwd, worktree)).toEqual([]);
  },
);

test("reads commit source blobs in a batch", () => {
  const cwd = makeRepo();
  const oddPath =
    process.platform === "win32" ? "src/line break.ts" : "src/line\nbreak.ts";
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/main.ts"), 'export const café = "☕";\n');
  writeFileSync(join(cwd, oddPath), "export function odd() {}\n");
  writeFileSync(join(cwd, "src/types.d.ts"), "declare const ignored: string;\n");
  writeFileSync(join(cwd, "README.md"), "not source\n");
  commitAll(cwd);

  const snapshot: Snapshot = { kind: "commit", ref: "HEAD" };
  const files = listSnapshotFiles(cwd, snapshot);
  const sources = readSnapshotFiles(cwd, snapshot, files);

  expect(files.map((file) => file.path)).toEqual([
    oddPath,
    "src/main.ts",
  ]);
  expect(files.every((file) => Boolean(file.oid))).toBe(true);
  expect(sources.get("src/main.ts")).toBe('export const café = "☕";\n');
  expect(sources.get(oddPath)).toBe("export function odd() {}\n");
});

test("scopes commit and worktree files with Windows and suffix path filters", () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, "src/nested"), { recursive: true });
  mkdirSync(join(cwd, "other"));
  writeFileSync(join(cwd, "src/nested/main.ts"), "export function main() {}\n");
  writeFileSync(join(cwd, "other/domain.ts"), "export function domain() {}\n");
  writeFileSync(join(cwd, "other/skip.ts"), "export function skip() {}\n");
  writeFileSync(join(cwd, "other/view.tsx"), "export function View() {}\n");
  commitAll(cwd);

  const snapshots: Snapshot[] = [
    { kind: "commit", ref: "HEAD" },
    { kind: "worktree", ref: "WORKTREE" },
  ];

  for (const snapshot of snapshots) {
    expect(
      listSnapshotFiles(cwd, snapshot, ["src\\nested"]).map((file) => file.path),
    ).toEqual(["src/nested/main.ts"]);
    expect(
      listSnapshotFiles(cwd, snapshot, ["main.ts"]).map((file) => file.path),
    ).toEqual(["other/domain.ts", "src/nested/main.ts"]);
    expect(
      listSnapshotFiles(cwd, snapshot, ["tsx"]).map((file) => file.path),
    ).toEqual(["other/view.tsx"]);
  }
});
