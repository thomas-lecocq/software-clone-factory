import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startCloneProcess } from "../src/clone-process.ts";
import {
  checkLock,
  loadFixtures,
  splitOf,
  targetDir,
  writeFixture,
  writeLock,
} from "../src/fixtures.ts";
import { canonicalIds } from "../src/json.ts";
import { ruleStatuses } from "../src/ledger.ts";
import { blocking, diff, thumbnailShare } from "../src/policy.ts";
import { findSecrets, loadLiterals, scrub } from "../src/scrub.ts";
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
    expect(canonicalIds({ b: "create_prorations", c: "charge_automatically" })).toEqual({
      b: "create_prorations",
      c: "charge_automatically",
    });
    expect(canonicalIds("price_1ULchEAcmeAcct00x")).toBe("price#1");
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

  it("applies a tolerance to a whole subtree, keys with dots included", () => {
    const policy = {
      canonicalIds: false,
      fields: [{ path: "*.layout.**", mode: "tolerance" as const, by: 16, why: "test only" }],
    };
    const e = { home: { layout: { "span $10.00": [0, 100, 50, 20] }, screen: ["a"] } };
    const near = { home: { layout: { "span $10.00": [12, 90, 50, 20] }, screen: ["a"] } };
    const far = { home: { layout: { "span $10.00": [40, 100, 50, 20] }, screen: ["a"] } };
    expect(diff(policy, e, near)).toEqual([]);
    expect(diff(policy, e, far).map((d) => d.path)).toEqual(["home.layout.span $10.00[0]"]);
    expect(diff(policy, e, { home: { layout: {}, screen: ["a"] } })).not.toEqual([]);
    expect(diff(policy, e, { ...near, home: { ...near.home, screen: ["b"] } })).toHaveLength(1);
  });

  it("masks a pattern in values and keys under a path", () => {
    const policy = {
      canonicalIds: false,
      fields: [{ path: "*.**", mode: "mask" as const, pattern: "\\d{2}/\\d{4}", why: "test only" }],
    };
    const e = { s: { screen: ["Expires 09/2027"], layout: { "span 09/2027": [1] } } };
    const a = { s: { screen: ["Expires 10/2027"], layout: { "span 10/2027": [1] } } };
    expect(diff(policy, e, a)).toEqual([]);
    expect(
      diff(policy, e, { s: { screen: ["Expired 10/2027"], layout: a.s.layout } }),
    ).toHaveLength(1);
  });

  it("keeps a tolerance in force under a mask that covers the same path", () => {
    const policy = {
      canonicalIds: false,
      fields: [
        { path: "*.**", mode: "mask" as const, pattern: "X", why: "test only" },
        { path: "*.layout.**", mode: "tolerance" as const, by: 16, why: "test only" },
      ],
    };
    const e = { s: { layout: { a: [0, 0] } } };
    expect(diff(policy, e, { s: { layout: { a: [5, 7] } } })).toEqual([]);
  });

  it("reports perceptual differences without blocking the case", () => {
    const policy = {
      canonicalIds: false,
      fields: [{ path: "*.thumbnail", mode: "perceptual" as const, max_share: 0.02, why: "test" }],
    };
    const thumb = (bytes: number[]): string => `10x10:${Buffer.from(bytes).toString("base64")}`;
    const base = Array.from({ length: 100 }, () => 200);
    const oneOff = base.map((v, i) => (i === 0 ? 0 : v));
    const tenOff = base.map((v, i) => (i < 10 ? 0 : v));
    expect(
      diff(policy, { s: { thumbnail: thumb(base) } }, { s: { thumbnail: thumb(oneOff) } }),
    ).toEqual([]);
    const far = diff(
      policy,
      { s: { thumbnail: thumb(base) } },
      { s: { thumbnail: thumb(tenOff) } },
    );
    expect(far).toEqual([expect.objectContaining({ path: "s.thumbnail", report: { share: 0.1 } })]);
    expect(blocking(far)).toEqual([]);
    expect(thumbnailShare(thumb(base), "5x5:AAAA")).toBe(1);
  });
});

describe("invariant 3: the guard hook keeps agents away from the evaluator", () => {
  const hook = join(root, "harness", "hooks", "guard-oracle.sh");
  const run = (payload: object, env: Record<string, string> = {}): number =>
    spawnSync("bash", [hook], {
      input: JSON.stringify(payload),
      // The ambient RH_SANDBOX (set inside a builder container) must not decide these cases.
      env: {
        ...process.env,
        RH_SANDBOX: "",
        ...env,
        GUARD_LOG: "/dev/null",
      },
    }).status ?? -1;

  it("exempts nobody inside a builder sandbox, the top-level session included", () => {
    const write = {
      tool_name: "Write",
      tool_input: { file_path: "targets/t/fixtures/dev/a.json" },
    };
    expect(run(write)).toBe(0);
    expect(run(write, { RH_SANDBOX: "1" })).toBe(2);
    expect(run({ ...write, agent_type: "recorder" }, { RH_SANDBOX: "1" })).toBe(2);
  });

  it("lets the analyst write its report and nothing else", () => {
    const write = (file_path: string) => ({
      agent_type: "analyst",
      tool_name: "Write",
      tool_input: { file_path },
    });
    expect(run(write("targets/t/analysis/hold-failures.md"))).toBe(0);
    expect(run(write("targets/t/clone/server.ts"))).toBe(2);
    expect(run(write("targets/t/rules.json"))).toBe(2);
    expect(run(write("targets/t/fixtures/dev/a.json"))).toBe(2);
  });

  it("is attached to every tool it has rules for, web tools included", () => {
    const settings = readFileSync(join(root, ".claude", "settings.json"), "utf8");
    for (const tool of ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch"])
      expect(settings).toMatch(new RegExp(`"matcher": "[^"]*\\b${tool}\\b`));
  });

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
      "builder fetches the public repository",
      {
        agent_type: "builder",
        tool_name: "WebFetch",
        tool_input: { url: "https://github.com/someone/software-clone-factory", prompt: "x" },
      },
      2,
    ],
    [
      "builder curls a raw file from a code host",
      {
        agent_type: "builder",
        tool_name: "Bash",
        tool_input: { command: "curl -s https://raw.githubusercontent.com/a/b/main/x.json" },
      },
      2,
    ],
    [
      "builder reads public API documentation",
      {
        agent_type: "builder",
        tool_name: "WebFetch",
        tool_input: { url: "https://docs.stripe.com/api/invoices", prompt: "x" },
      },
      0,
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

describe("splits", () => {
  it("sends a quarter of ordinary probes and every hold- probe to the holdout", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `p-${String(i)}`);
    const held = ids.filter((id) => splitOf(id) === "holdout").length;
    expect(held).toBeGreaterThan(70);
    expect(held).toBeLessThan(130);
    expect(Array.from({ length: 50 }, (_, i) => splitOf(`hold-${String(i)}`))).toEqual(
      Array.from({ length: 50 }, () => "holdout"),
    );
    expect(Array.from({ length: 50 }, (_, i) => splitOf(`dev-${String(i)}`))).toEqual(
      Array.from({ length: 50 }, () => "dev"),
    );
  });
});

describe("invariant 3: implementers see only a stripped sandbox", () => {
  const make = join(root, "harness", "make-sandbox.sh");
  const work = mkdtempSync(join(tmpdir(), "scf-sandbox-test-"));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function repoWith(files: string[]): string {
    const src = mkdtempSync(join(work, "src-"));
    for (const f of files) {
      mkdirSync(join(src, f, ".."), { recursive: true });
      writeFileSync(join(src, f), "x");
    }
    return src;
  }

  it("copies the clone and dev fixtures, and nothing that must stay out", () => {
    const kept = ["targets/t/clone/server.ts", "targets/t/fixtures/dev/a.json", "harness/x.ts"];
    const dropped = [
      "targets/t/holdout-seed.json",
      ".git/config",
      ".env",
      ".agent.env",
      ".scrub.json",
      "audit/auditor.md",
      "targets/t/fixtures/holdout/b.json",
      "targets/t/holdout-ids.json",
      "targets/t/logs/builder.log",
      "targets/t/recon/out/raw.json",
    ];
    const src = repoWith([...kept, ...dropped]);
    const dest = mkdtempSync(join(work, "dest-"));
    const r = spawnSync(make, [src, dest], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    for (const f of kept) expect(existsSync(join(dest, f)), f).toBe(true);
    for (const f of dropped) expect(existsSync(join(dest, f)), f).toBe(false);
  });

  it("refuses when holdout material slips past the copy filters", () => {
    const src = repoWith(["targets/t/notes-holdout.md"]);
    const r = spawnSync(make, [src, mkdtempSync(join(work, "dest-"))], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it("never copies a symlink back from the sandbox", () => {
    const script = readFileSync(join(root, "harness", "sandbox.sh"), "utf8");
    const back = script.slice(script.indexOf('if [ -n "$copy_back" ]'));
    expect(back).toMatch(/rsync -a --no-links --delete "\$sandbox\/\$copy_back\/"/);
  });

  it("mounts the sandbox alone into the agent container", () => {
    const script = readFileSync(join(root, "harness", "sandbox.sh"), "utf8");
    const run = script.slice(script.indexOf("docker run"), script.indexOf("| tee"));
    expect(run.match(/(^|\s)(-v|--volume|--mount)\s/g)).toEqual([" -v "]);
    expect(run).toContain('-v "$sandbox:/work"');
    expect(script).toContain('make-sandbox.sh" "$repo" "$sandbox"');
  });
});

describe("invariant 2: the clone never runs inside the verifier", () => {
  const t = "_proc-test";
  const dir = targetDir(t);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts the clone in another process, so a patched global stays there", async () => {
    mkdirSync(join(dir, "clone"), { recursive: true });
    writeFileSync(
      join(dir, "clone", "server.ts"),
      [
        'import { startCloneServer } from "../../../harness/src/clone-kit.ts";',
        "(globalThis as Record<string, unknown>).patchedByClone = true;",
        "export const startClone = (port: number) =>",
        "  startCloneServer({ seed: () => ({}), handle: () => ({ status: 200, body: { pid: process.pid } }) }, port);",
        "",
      ].join("\n"),
    );
    const clone = await startCloneProcess(t, "clone/server.ts", 4631);
    try {
      const res = await fetch(`${clone.url}/anything`);
      const body = z.object({ pid: z.number() }).parse(await res.json());
      expect(body.pid).not.toBe(process.pid);
      expect("patchedByClone" in globalThis).toBe(false);
      expect((await fetch(`${clone.url}/__reset`, { method: "POST" })).ok).toBe(true);
    } finally {
      await clone.close();
    }
  });

  it("cannot read recorded fixtures: the runtime denies it, not a pattern", async () => {
    mkdirSync(join(dir, "clone"), { recursive: true });
    const fixtures = join(root, "targets", targets[0] ?? "", "fixtures");
    writeFileSync(
      join(dir, "clone", "reader.ts"),
      [
        'import { readdirSync } from "node:fs";',
        'import { startCloneServer } from "../../../harness/src/clone-kit.ts";',
        "const tryRead = () => {",
        `  try { return { read: readdirSync(${JSON.stringify(fixtures)}).length }; }`,
        '  catch (e) { return { denied: e instanceof Error && "code" in e ? String(e.code) : "?" }; }',
        "};",
        "export const startClone = (port: number) =>",
        "  startCloneServer({ seed: () => ({}), handle: () => ({ status: 200, body: tryRead() }) }, port);",
        "",
      ].join("\n"),
    );
    const clone = await startCloneProcess(t, "clone/reader.ts", 4634);
    try {
      const body: unknown = await (await fetch(`${clone.url}/x`)).json();
      expect(body).toEqual({ denied: "ERR_ACCESS_DENIED" });
    } finally {
      await clone.close();
    }
  });

  it("is what verify, explain and serve use", () => {
    for (const f of ["verify.ts", "explain.ts", "cli.ts"]) {
      const src = readFileSync(join(root, "harness", "src", f), "utf8");
      expect(src, f).toContain("startCloneProcess(");
      expect(src, f).not.toMatch(/adapter\)?\.startClone|from "\.\.\/\.\.\/targets/);
    }
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
    expect(scrub({ "span Acme Inc": [1] }, { "Acme Inc": "Org" })).toEqual({ "span Org": [1] });
  });

  // The literal map stays outside the repository; where it exists, no fixture may hold its keys.
  const literals = loadLiterals(process.env.SCRUB_LITERALS ?? join(root, ".scrub.json"));
  it.each(targets)("%s fixtures hold no scrubbed literal", (t) => {
    const dir = join(root, "targets", t, "fixtures");
    if (!existsSync(dir)) return;
    for (const f of filesUnder(dir)) {
      const text = readFileSync(f, "utf8");
      for (const from of Object.keys(literals)) expect(text.includes(from), f).toBe(false);
    }
  });

  it.each(targets)("%s fixtures are clean", (t) => {
    const dir = join(root, "targets", t, "fixtures");
    if (!existsSync(dir)) return;
    const files = filesUnder(dir);
    for (const f of files) expect(findSecrets(readFileSync(f, "utf8")), f).toEqual([]);
  });
});
