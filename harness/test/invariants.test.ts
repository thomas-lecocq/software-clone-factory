import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkLock, loadFixtures, targetDir, writeFixture, writeLock } from "../src/fixtures.ts";
import { canonicalIds } from "../src/json.ts";
import { ruleStatuses } from "../src/ledger.ts";
import { diff } from "../src/policy.ts";
import { findSecrets, scrub } from "../src/scrub.ts";
import { committedLockProblems } from "../src/verify.ts";

const root = join(import.meta.dirname, "..", "..");
const targets = readdirSync(join(root, "targets"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

describe("invariant 1: the lock detects any change to the evaluator", () => {
  const t = "_lock-test";
  const dir = targetDir(t);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is clean after writing and dirty after tampering", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "policy.json"), '{"canonicalIds":true,"fields":[]}');
    const f = {
      id: "p1",
      rules: ["X-01"],
      input: {},
      observed: { out: 1 },
      noise: [],
      recorded_at: "t",
    };
    writeFixture(t, f);
    writeLock(t);
    expect(checkLock(t)).toEqual([]);
    writeFixture(t, { ...f, observed: { out: 2 } });
    expect(checkLock(t)).toEqual([expect.stringContaining("changed")]);
    writeLock(t);
    writeFileSync(join(dir, "policy.json"), '{"canonicalIds":false,"fields":[]}');
    expect(checkLock(t)).toContain("policy.json changed");
    expect(loadFixtures(t, ["dev", "holdout"])).toHaveLength(1);
  });

  it("flags a change to the target's driver code", () => {
    writeFileSync(join(dir, "policy.json"), '{"canonicalIds":true,"fields":[]}');
    writeFileSync(join(dir, "adapter.ts"), "export default 1;\n");
    writeLock(t);
    expect(checkLock(t)).toEqual([]);
    writeFileSync(join(dir, "adapter.ts"), "export default 2;\n");
    expect(checkLock(t)).toContain("target/adapter.ts changed");
  });

  it("refuses to score without a readable committed lock, outside a sandbox", () => {
    const saved = { dir: process.env.GIT_DIR, sb: process.env.RH_SANDBOX };
    process.env.GIT_DIR = "/nonexistent";
    delete process.env.RH_SANDBOX;
    try {
      expect(committedLockProblems(t)).toEqual([expect.stringContaining("refusing")]);
      process.env.RH_SANDBOX = "1";
      expect(committedLockProblems(t)).toEqual([]);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.sb === undefined) delete process.env.RH_SANDBOX;
      else process.env.RH_SANDBOX = saved.sb;
    }
  });
});

describe("invariant 2: status is computed, never stored", () => {
  it("derives verified, failing and unverified from cases", () => {
    const rule = (id: string) => ({
      id,
      statement: "s",
      area: "logic" as const,
      provenance: { kind: "observed" as const, ref: "r" },
    });
    const res = ruleStatuses(
      [rule("A-01"), rule("B-01"), rule("C-01")],
      [
        { rules: ["A-01"], pass: true },
        { rules: ["B-01"], pass: true },
        { rules: ["B-01"], pass: false },
      ],
    );
    expect(res.map((r) => r.status)).toEqual(["verified", "failing", "unverified"]);
  });

  it.each(targets)("%s/rules.json has no status field", (t) => {
    const text = readFileSync(join(root, "targets", t, "rules.json"), "utf8");
    expect(text).not.toMatch(/"status"\s*:/);
  });
});

describe("diff policy", () => {
  it("compares references between generated IDs, not the IDs themselves", () => {
    const a = { id: "in_AAAAAAAAAA", lines: [{ invoice: "in_AAAAAAAAAA", amount: 5 }] };
    const b = { id: "in_BBBBBBBBBB", lines: [{ invoice: "in_BBBBBBBBBB", amount: 5 }] };
    const c = { id: "in_BBBBBBBBBB", lines: [{ invoice: "in_CCCCCCCCCC", amount: 5 }] };
    const policy = { canonicalIds: true, fields: [] };
    expect(diff(policy, a, b)).toEqual([]);
    expect(diff(policy, a, c).map((d) => d.path)).toEqual(["lines[0].invoice"]);
    expect(canonicalIds("see in_AAAAAAAAAA")).toBe("see in#1");
  });

  it("honours ignore and type modes", () => {
    const policy = {
      canonicalIds: false,
      fields: [
        { path: "x.*", mode: "ignore" as const, why: "test only" },
        { path: "y[*]", mode: "type" as const, why: "test only" },
      ],
    };
    expect(diff(policy, { x: { a: 1 }, y: [1] }, { x: { a: 2 }, y: [9] })).toEqual([]);
    expect(diff(policy, { y: [1] }, { y: ["1"] })).toHaveLength(1);
  });
});

describe("invariant 3: the guard hook keeps agents away from the evaluator", () => {
  const hook = join(root, "harness", "hooks", "guard-oracle.sh");
  const run = (payload: object, env: Record<string, string> = {}): number =>
    spawnSync("bash", [hook], {
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        ...env,
        GUARD_LOG: "/dev/null",
      },
    }).status ?? -1;

  it.each([
    [
      "builder writes a fixture",
      {
        agent_type: "builder",
        tool_name: "Write",
        tool_input: { file_path: "targets/t/fixtures/dev/a.json" },
      },
      2,
    ],
    [
      "builder edits the verifier",
      {
        agent_type: "builder",
        tool_name: "Edit",
        tool_input: { file_path: "harness/src/verify.ts" },
      },
      2,
    ],
    [
      "builder rewrites the lock by shell",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "echo {} > targets/t/fixtures.lock" },
      },
      2,
    ],
    [
      "builder reads the holdout",
      {
        agent_type: "builder",
        tool_name: "Read",
        tool_input: { file_path: "targets/t/fixtures/holdout/a.json" },
      },
      2,
    ],
    [
      "breaker writes anything",
      {
        agent_type: "breaker",
        tool_name: "Write",
        tool_input: { file_path: "targets/t/clone/x.ts" },
      },
      2,
    ],
    [
      "builder writes the clone",
      {
        agent_type: "builder",
        tool_name: "Write",
        tool_input: { file_path: "targets/t/clone/server.ts" },
      },
      0,
    ],
    [
      "builder greps fixtures with a stderr redirect",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "jq .id targets/t/fixtures/dev/a.json 2>/dev/null" },
      },
      0,
    ],
    [
      "builder runs node code with an arrow next to a fixture path",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "node -e 'x.map(f => f)' targets/t/fixtures/dev" },
      },
      0,
    ],
    [
      "builder writes a fixture from node",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "node -e 'writeFileSync(\"targets/t/fixtures/dev/a.json\", 1)'" },
      },
      2,
    ],
    [
      "builder redirects into a fixture",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "echo 1 >> targets/t/fixtures/dev/a.json" },
      },
      2,
    ],
    [
      "builder edits the target adapter",
      {
        agent_type: "builder",
        tool_name: "Edit",
        tool_input: { file_path: "targets/t/adapter.ts" },
      },
      2,
    ],
    [
      "builder greps the fixtures folder",
      { agent_type: "builder", tool_name: "Grep", tool_input: { path: "targets/t/fixtures" } },
      2,
    ],
    [
      "builder globs all fixtures",
      {
        agent_type: "builder",
        tool_name: "Glob",
        tool_input: { pattern: "targets/t/fixtures/**/*.json" },
      },
      2,
    ],
    [
      "builder cats with a hold* wildcard",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "cat targets/t/fixtures/hold*/a.json" },
      },
      2,
    ],
    [
      "builder edits the adapter through clone/..",
      {
        agent_type: "builder",
        tool_name: "Edit",
        tool_input: { file_path: "targets/t/clone/../adapter.ts" },
      },
      2,
    ],
    [
      "builder writes the lock from python",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "python3 -c \"open('targets/t/fixtures.lock','w')\"" },
      },
      2,
    ],
    [
      "builder runs explain",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "npx tsx harness/src/cli.ts explain t --split holdout" },
      },
      2,
    ],
    [
      "builder reads the holdout report",
      {
        agent_type: "builder",
        tool_name: "Read",
        tool_input: { file_path: "targets/t/verify/holdout-report.md" },
      },
      2,
    ],
    [
      "builder runs verify",
      { agent_type: "builder", tool_name: "Bash", tool_input: { command: "npm run verify t" } },
      0,
    ],
    [
      "builder reads the dev report",
      {
        agent_type: "builder",
        tool_name: "Read",
        tool_input: { file_path: "targets/t/verify/report.md" },
      },
      0,
    ],
    [
      "upper-case holdout path",
      {
        agent_type: "builder",
        tool_name: "Read",
        tool_input: { file_path: "targets/t/FIXTURES/HOLDOUT/x.json" },
      },
      2,
    ],
    [
      "mixed-case holdout report",
      {
        agent_type: "builder",
        tool_name: "Read",
        tool_input: { file_path: "targets/t/verify/Holdout-report.md" },
      },
      2,
    ],
    [
      "grep with a glob field",
      {
        agent_type: "builder",
        tool_name: "Grep",
        tool_input: { path: "targets/t", glob: "**/h*/*.json", pattern: "amount" },
      },
      2,
    ],
    [
      "git show of old reports",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "git show 3771cfb:targets/t/verify/report.md" },
      },
      2,
    ],
    [
      "nested claude session",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "claude -p 'read everything'" },
      },
      2,
    ],
    [
      "eval of a decoded command",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: 'eval "$(echo Y2F0 | base64 -d)"' },
      },
      2,
    ],
    [
      "edit of the hook settings",
      {
        agent_type: "builder",
        tool_name: "Edit",
        tool_input: { file_path: ".claude/settings.json" },
      },
      2,
    ],
    [
      "edit of package.json",
      { agent_type: "builder", tool_name: "Edit", tool_input: { file_path: "package.json" } },
      2,
    ],
    [
      "breaker writes by shell",
      {
        agent_type: "breaker",
        tool_name: "Bash",
        tool_input: { command: "echo x > targets/t/clone/state.ts" },
      },
      2,
    ],
    [
      "builder links fixtures into the clone",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "ln -s ../fixtures targets/t/clone/f" },
      },
      2,
    ],
    [
      "builder writes notes that mention fixtures",
      {
        agent_type: "builder",
        tool_name: "Write",
        tool_input: {
          file_path: "targets/t/clone/NOTES.md",
          content: "the fixtures show x; see fixtures/holdout? no",
        },
      },
      0,
    ],
    [
      "builder runs git diff",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "git diff HEAD~3 -- targets" },
      },
      2,
    ],
    [
      "builder writes into node_modules by shell",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "echo x > node_modules/stripe/index.js" },
      },
      2,
    ],
    [
      "builder writes .claude by shell",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "cp x .claude/settings.json" },
      },
      2,
    ],
    [
      "builder reads dev fixtures",
      {
        agent_type: "builder",
        tool_name: "Read",
        tool_input: { file_path: "targets/t/fixtures/dev/a.json" },
      },
      0,
    ],
    [
      "an unnamed subagent writes a fixture",
      {
        agent_type: "general-purpose",
        tool_name: "Write",
        tool_input: { file_path: "targets/t/fixtures/dev/a.json" },
      },
      2,
    ],
    [
      "an unnamed subagent reads the holdout",
      {
        agent_type: "general-purpose",
        tool_name: "Grep",
        tool_input: { path: "targets/t/fixtures/holdout" },
      },
      2,
    ],
    [
      "the recorder writes rules",
      {
        agent_type: "recorder",
        tool_name: "Edit",
        tool_input: { file_path: "targets/t/rules.json" },
      },
      0,
    ],
    ["main session records", { tool_name: "Bash", tool_input: { command: "npm run record t" } }, 0],
    [
      "main session reads the audit prompts",
      { tool_name: "Read", tool_input: { file_path: "audit/auditor.md" } },
      0,
    ],
    [
      "builder reads the audit prompts",
      { agent_type: "builder", tool_name: "Read", tool_input: { file_path: "audit/auditor.md" } },
      2,
    ],
    [
      "builder lists the audit folder",
      { agent_type: "builder", tool_name: "Bash", tool_input: { command: "ls audit" } },
      2,
    ],
  ])("%s", (_name, payload, code) => {
    expect(run(payload)).toBe(code);
  });
});

describe("invariant 3: the guard fails closed", () => {
  it("still blocks when its log cannot be written", () => {
    const hook = join(root, "harness", "hooks", "guard-oracle.sh");
    const payload = {
      agent_type: "builder",
      tool_name: "Write",
      tool_input: { file_path: "targets/t/fixtures/dev/a.json" },
    };
    const res = spawnSync("bash", [hook], {
      input: JSON.stringify(payload),
      env: { ...process.env, GUARD_LOG: "/nonexistent-root-dir/sub/guard.log" },
    });
    expect(res.status).toBe(2);
  });
});

describe("invariant 6 and 7: clone and harness boundaries", () => {
  it.each(targets)("%s clone never reads fixtures", (t) => {
    for (const f of filesUnder(join(root, "targets", t, "clone")).filter((x) =>
      x.endsWith(".ts"),
    )) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/["'`][^"'`\n]*fixtures/);
    }
  });

  it("harness/ and .claude/ never name a target", () => {
    const files = [...filesUnder(join(root, "harness")), ...filesUnder(join(root, ".claude"))];
    for (const f of files.filter(
      (x) => !x.includes(join("harness", "test")) && !x.endsWith(".log"),
    )) {
      const text = readFileSync(f, "utf8").toLowerCase();
      for (const t of targets) expect(text, f).not.toContain(t.toLowerCase());
    }
  });
});

describe("invariant 8: committed fixtures carry no secret", () => {
  it("scrub removes keys, session secrets, emails and literals", () => {
    const out = scrub(
      { a: "sk_test_abc123 x@y.com ?secret=zz&x=1 Acme Inc" },
      { "Acme Inc": "Org" },
    );
    expect(out).toEqual({ a: "key_REDACTED user@example.com ?secret=REDACTED&x=1 Org" });
  });

  it.each(targets)("%s fixtures are clean", (t) => {
    const dir = join(root, "targets", t, "fixtures");
    if (!existsSync(dir)) return;
    const files = filesUnder(dir);
    for (const f of files) expect(findSecrets(readFileSync(f, "utf8")), f).toEqual([]);
  });
});
