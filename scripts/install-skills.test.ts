import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtemp,
  rm,
  mkdir,
  symlink,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import {
  parse,
  applyFileStep,
  updateAgentsMd,
  runShellStep,
  flattenSkills,
  collectAgentsMd,
  isGroup,
  runSkill,
  run,
  safe,
  resolveLatestReleaseTag,
  resolveRef,
  workspaceKey,
  copySubtreeFromWorkspace,
  cleanupWorkspaces,
  shell,
  workspaces,
  gitExportScript,
  type Step,
} from "./install-skills.ts";

const START = "<!-- install-skills:agents-md:start -->";
const END = "<!-- install-skills:agents-md:end -->";
const tmpRoots: string[] = [];
const originalFetch = globalThis.fetch;
const originalGitExportScript = process.env.GIT_EXPORT_SCRIPT;

async function makeTmp(prefix = "install-skills-test-") {
  await mkdir("/tmp/opencode", { recursive: true }).catch(() => {});
  const dir = await mkdtemp(path.join("/tmp/opencode/", prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalGitExportScript === undefined) {
    delete process.env.GIT_EXPORT_SCRIPT;
  } else {
    process.env.GIT_EXPORT_SCRIPT = originalGitExportScript;
  }
  await cleanupWorkspaces().catch(() => {});
  workspaces.clear();
  let dir: string | undefined;
  while ((dir = tmpRoots.pop()) !== undefined) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function stageWith(files: Record<string, string>) {
  const dir = await makeTmp();
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(path.join(dir, rel), content);
  }
  return dir;
}

describe("parse", () => {
  test("old manifest without agents_md works", () => {
    const m = parse(
      "skills:\n  - name: a\n    steps:\n      - type: download\n        url: https://example.com/x\n        dest: SKILL.md\n",
    );
    expect(m.skills).toHaveLength(1);
    expect(m.agents_md).toBeUndefined();
  });

  test("agents_md is retained", () => {
    const m = parse("skills: []\nagents_md: |\n  ## hi\n  body\n");
    expect(m.agents_md).toContain("## hi");
  });

  test("per-skill agents_md is retained", () => {
    const m = parse(
      "skills:\n  - name: a\n    steps: []\n    agents_md: |\n      ## hi\n      body\n",
    );
    expect(m.skills).toHaveLength(1);
    expect(m.skills[0].agents_md).toContain("## hi");
    expect(m.agents_md).toBeUndefined();
  });

  test("per-skill agents_md malformed fails", () => {
    expect(() =>
      parse('skills:\n  - name: a\n    steps: []\n    agents_md: "  "\n'),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        `skills:\n  - name: a\n    steps: []\n    agents_md: "x ${START} y"\n`,
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        `skills:\n  - name: a\n    steps: []\n    agents_md: "x ${END} y"\n`,
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse("skills:\n  - name: a\n    steps: []\n    agents_md: 42\n"),
    ).toThrow("[install-skills]");
  });

  test("replace expected is optional but must be a positive integer when present", () => {
    const m = parse(
      "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: SKILL.md\n        from: x\n        to: y\n",
    );
    expect(m.skills).toHaveLength(1);
    for (const bad of [
      "expected: 0",
      "expected: -2",
      "expected: 1.5",
      "expected: '3'",
    ]) {
      expect(() =>
        parse(
          `skills:\n  - name: a\n    steps:\n      - type: replace\n        file: SKILL.md\n        from: x\n        to: y\n        ${bad}\n`,
        ),
      ).toThrow("[install-skills]");
    }
  });

  test("malformed new fields fail", () => {
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: SKILL.md\n        from: ''\n        to: x\n        expected: 1\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: SKILL.md\n        from: x\n        to: y\n        expected: 0\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: assert-absent\n        file: SKILL.md\n        pattern: ''\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: ''\n        from: x\n        to: y\n        expected: 1\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse("skills:\n  - name: a\n    steps:\n      - type: nope\n"),
    ).toThrow("[install-skills]");
  });

  test("invalid regex fails", () => {
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: assert-absent\n        file: SKILL.md\n        pattern: '(['\n",
      ),
    ).toThrow("[install-skills]");
  });

  test("duplicate and unsafe names fail", () => {
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps: []\n  - name: a\n    steps: []\n",
      ),
    ).toThrow("[install-skills]");
    for (const bad of ["../x", "/abs", "a/b", "a\\b", ".", ".."]) {
      expect(() =>
        parse(`skills:\n  - name: ${JSON.stringify(bad)}\n    steps: []\n`),
      ).toThrow("[install-skills]");
    }
  });

  test("shell commands required", () => {
    const m = parse(
      "skills:\n  - name: a\n    steps:\n      - type: shell\n        commands: |\n          echo hi\n",
    );
    expect(m.skills).toHaveLength(1);
    expect(() =>
      parse("skills:\n  - name: a\n    steps:\n      - type: shell\n"),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: shell\n        commands: ''\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: shell\n        commands: '   '\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: shell\n        commands: 42\n",
      ),
    ).toThrow("[install-skills]");
  });

  test("agents_md with marker or blank fails", () => {
    expect(() => parse(`skills: []\nagents_md: "   "\n`)).toThrow(
      "[install-skills]",
    );
    expect(() =>
      parse(`skills: []\nagents_md: "has ${START} inside"\n`),
    ).toThrow("[install-skills]");
    expect(() => parse(`skills: []\nagents_md: "has ${END} inside"\n`)).toThrow(
      "[install-skills]",
    );
  });

  test("group parses, flattens and collects guidance in order", () => {
    const m = parse(
      [
        "skills:",
        "  - name: solo",
        "    steps: []",
        "    agents_md: |",
        "      ## solo",
        "  - group: tools",
        "    agents_md: |",
        "      ## group-md",
        "    skills:",
        "      - name: a",
        "        steps: []",
        "      - name: b",
        "        steps: []",
        "        agents_md: |",
        "          ## b-md",
        "",
      ].join("\n"),
    );
    expect(m.skills).toHaveLength(2);
    expect(isGroup(m.skills[0])).toBe(false);
    expect(isGroup(m.skills[1])).toBe(true);
    const flat = flattenSkills(m.skills);
    expect(flat.map((s) => s.name)).toEqual(["solo", "a", "b"]);
    expect(collectAgentsMd(m)).toEqual(["## solo", "## group-md", "## b-md"]);
  });

  test("group validation fails", () => {
    expect(() =>
      parse(
        "skills:\n  - group: ''\n    skills:\n      - name: a\n        steps: []\n",
      ),
    ).toThrow("[install-skills]");
    expect(() => parse("skills:\n  - group: g\n    skills: []\n")).toThrow(
      "[install-skills]",
    );
    expect(() =>
      parse(
        "skills:\n  - group: g\n    name: x\n    skills:\n      - name: a\n        steps: []\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - group: g\n    steps: []\n    skills:\n      - name: a\n        steps: []\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - group: g\n    skills:\n      - group: nested\n        skills:\n          - name: a\n            steps: []\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps: []\n  - group: g\n    skills:\n      - name: a\n        steps: []\n",
      ),
    ).toThrow("duplicate skill name");
    expect(() =>
      parse(
        "skills:\n  - group: g\n    skills:\n      - name: a\n        steps: []\n  - group: g\n    skills:\n      - name: b\n        steps: []\n",
      ),
    ).toThrow("duplicate group name");
    expect(() =>
      parse(
        "skills:\n  - group: g\n    agents_md: '  '\n    skills:\n      - name: a\n        steps: []\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse("skills:\n  - name: a\n    group: g\n    steps: []\n"),
    ).toThrow("[install-skills]");
  });
});

describe("replace", () => {
  test("exact count, multiline, empty replacement, literal $&", async () => {
    const dir = await stageWith({
      "SKILL.md":
        "a `npx -y @firecrawl/anydoc` b `npx -y @firecrawl/anydoc` c `npx -y @firecrawl/anydoc` keep",
    });
    await applyFileStep(
      "s",
      {
        type: "replace",
        file: "SKILL.md",
        from: "npx -y @firecrawl/anydoc",
        to: "anydoc",
        expected: 3,
      },
      dir,
    );
    const after = await Bun.file(path.join(dir, "SKILL.md")).text();
    expect(after).toBe("a `anydoc` b `anydoc` c `anydoc` keep");

    const dir2 = await stageWith({ "f.md": "line1\nOLD\nline3\nOLD tail" });
    await applyFileStep(
      "s",
      { type: "replace", file: "f.md", from: "OLD\n", to: "", expected: 1 },
      dir2,
    );
    expect(await Bun.file(path.join(dir2, "f.md")).text()).toBe(
      "line1\nline3\nOLD tail",
    );

    const dir3 = await stageWith({ "g.md": "price: X here" });
    await applyFileStep(
      "s",
      { type: "replace", file: "g.md", from: "X", to: "$& $' $`", expected: 1 },
      dir3,
    );
    expect(await Bun.file(path.join(dir3, "g.md")).text()).toBe(
      "price: $& $' $` here",
    );
  });

  test("count mismatch throws and leaves input unchanged", async () => {
    for (const expected of [2, 5]) {
      const dir = await stageWith({
        "SKILL.md": "one npx -y @firecrawl/anydoc two",
      });
      const before = await Bun.file(path.join(dir, "SKILL.md")).text();
      await expect(
        applyFileStep(
          "s",
          {
            type: "replace",
            file: "SKILL.md",
            from: "npx -y @firecrawl/anydoc",
            to: "anydoc",
            expected,
          },
          dir,
        ),
      ).rejects.toThrow("[install-skills]");
      expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe(before);
    }
    const dir = await stageWith({ "SKILL.md": "no match here" });
    await expect(
      applyFileStep(
        "s",
        {
          type: "replace",
          file: "SKILL.md",
          from: "missing",
          to: "x",
          expected: 1,
        },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");
  });

  test("omitted expected replaces all, zero matches fail", async () => {
    const dir = await stageWith({ "SKILL.md": "a `npx` b `npx` c keep" });
    await applyFileStep(
      "s",
      { type: "replace", file: "SKILL.md", from: "`npx`", to: "`anydoc`" },
      dir,
    );
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe(
      "a `anydoc` b `anydoc` c keep",
    );

    const dir2 = await stageWith({ "SKILL.md": "no match here" });
    await expect(
      applyFileStep(
        "s",
        { type: "replace", file: "SKILL.md", from: "missing", to: "x" },
        dir2,
      ),
    ).rejects.toThrow("at least 1 occurrence");
    expect(await Bun.file(path.join(dir2, "SKILL.md")).text()).toBe(
      "no match here",
    );
  });
});

describe("assert-absent", () => {
  test("matching content fails, nonmatching succeeds without changing bytes", async () => {
    const dir = await stageWith({
      "SKILL.md": "run npx -y blah @firecrawl/anydoc now",
    });
    await expect(
      applyFileStep(
        "s",
        {
          type: "assert-absent",
          file: "SKILL.md",
          pattern: "npx[^\\r\\n]*@firecrawl/anydoc",
        },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");

    const dir2 = await stageWith({ "SKILL.md": "run anydoc now" });
    const before = await Bun.file(path.join(dir2, "SKILL.md")).text();
    await applyFileStep(
      "s",
      {
        type: "assert-absent",
        file: "SKILL.md",
        pattern: "npx[^\\r\\n]*@firecrawl/anydoc",
      },
      dir2,
    );
    const raw = await readFile(path.join(dir2, "SKILL.md"));
    expect(raw.toString("utf8")).toBe(before);
  });
});

describe("shell", () => {
  test("runs with staging cwd and env, fails on nonzero exit", async () => {
    const dir = await makeTmp();
    await runShellStep(
      "s",
      'echo "$SKILL_NAME" > name.txt\necho "$SKILL_STAGING_DIR" > stage.txt\ntest -n "$OPENCODE_CONFIG_DIR"',
      dir,
    );
    expect(await Bun.file(path.join(dir, "name.txt")).text()).toBe("s\n");
    expect(await Bun.file(path.join(dir, "stage.txt")).text()).toBe(`${dir}\n`);
    await expect(runShellStep("s", "exit 3", dir)).rejects.toThrow(
      "[install-skills]",
    );
  });
});

describe("file safety", () => {
  test("missing file, directory, absolute path, traversal, escaping symlink fail", async () => {
    const dir = await makeTmp();
    await Bun.write(path.join(dir, "SKILL.md"), "hello");
    await expect(
      applyFileStep(
        "s",
        {
          type: "replace",
          file: "MISSING.md",
          from: "h",
          to: "x",
          expected: 1,
        },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");

    await mkdir(path.join(dir, "sub"));
    await expect(
      applyFileStep(
        "s",
        { type: "replace", file: "sub", from: "h", to: "x", expected: 1 },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");

    await expect(
      applyFileStep(
        "s",
        {
          type: "replace",
          file: "/etc/passwd",
          from: "r",
          to: "x",
          expected: 1,
        },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");

    await expect(
      applyFileStep(
        "s",
        {
          type: "replace",
          file: "../evil.md",
          from: "h",
          to: "x",
          expected: 1,
        },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");

    const outside = await makeTmp("sentinel-");
    const sentinel = path.join(outside, "secret.txt");
    await Bun.write(sentinel, "sentinel-bytes");
    await symlink(sentinel, path.join(dir, "link.md"));
    await expect(
      applyFileStep(
        "s",
        {
          type: "replace",
          file: "link.md",
          from: "sentinel",
          to: "changed",
          expected: 1,
        },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");
    expect(await Bun.file(sentinel).text()).toBe("sentinel-bytes");
  });

  test("interior symlink is allowed", async () => {
    const dir = await makeTmp();
    await Bun.write(path.join(dir, "real.md"), "hello hello");
    await symlink(path.join(dir, "real.md"), path.join(dir, "link.md"));
    await applyFileStep(
      "s",
      {
        type: "replace",
        file: "link.md",
        from: "hello",
        to: "hi",
        expected: 2,
      },
      dir,
    );
    expect(await Bun.file(path.join(dir, "real.md")).text()).toBe("hi hi");
  });
});

describe("guidance append/update", () => {
  test("prefix preserved, repeat identical, changed guidance replaces", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "AGENTS.md");
    await Bun.write(target, "# base rules\n");
    await updateAgentsMd(target, "## extra\n\nbody\n");
    const first = await Bun.file(target).text();
    expect(first.startsWith("# base rules\n")).toBe(true);
    expect(first).toContain(START);
    expect(first.endsWith("\n")).toBe(true);

    await updateAgentsMd(target, "## extra\n\nbody\n");
    expect(await Bun.file(target).text()).toBe(first);

    await updateAgentsMd(target, "## extra\n\nchanged\n");
    const third = await Bun.file(target).text();
    expect(third).toContain("changed");
    expect(third.startsWith("# base rules\n")).toBe(true);
    expect(third).not.toContain("body");
  });

  test("unmanaged suffix after block stays identical", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "AGENTS.md");
    await Bun.write(target, "prefix\n");
    await updateAgentsMd(target, "guidance v1");
    const withSuffix = `${await Bun.file(target).text()}\nSuffix instructions stay.\n`;
    await Bun.write(target, withSuffix);
    const before = await Bun.file(target).text();
    await updateAgentsMd(target, "guidance v2");
    const after = await Bun.file(target).text();
    expect(after).toContain("guidance v2");
    expect(after.endsWith("\nSuffix instructions stay.\n")).toBe(true);
    expect(after.slice(after.indexOf(END))).toBe(
      before.slice(before.indexOf(END)),
    );
  });

  test("bad state fails without changing target", async () => {
    const dir = await makeTmp();
    await expect(
      updateAgentsMd(path.join(dir, "nope.md"), "guidance"),
    ).rejects.toThrow("[install-skills]");

    const target = path.join(dir, "AGENTS.md");
    await Bun.write(target, "base\n");
    await expect(updateAgentsMd(target, `x ${START} y`)).rejects.toThrow(
      "[install-skills]",
    );
    expect(await Bun.file(target).text()).toBe("base\n");

    const cases = [
      `before ${START} only`,
      `before ${END} only`,
      `${START} a ${END} b ${START} c ${END}`,
      `reversed ${END} then ${START}`,
    ];
    for (const bad of cases) {
      await Bun.write(target, bad);
      await expect(updateAgentsMd(target, "guidance")).rejects.toThrow(
        "[install-skills]",
      );
      expect(await Bun.file(target).text()).toBe(bad);
    }
  });

  test("symlink target is rejected", async () => {
    const dir = await makeTmp();
    const real = path.join(dir, "real.md");
    await Bun.write(real, "base\n");
    const link = path.join(dir, "AGENTS.md");
    await symlink(real, link);
    await expect(updateAgentsMd(link, "guidance")).rejects.toThrow(
      "[install-skills]",
    );
  });
});

describe("cli integration", () => {
  test("download + patches + guidance, repeat idempotent, mismatch fails safe", async () => {
    const fixture = [
      "# fixture",
      "It needs Node 20+ and no install:",
      "- `npx -y @firecrawl/anydoc --help`",
      "- `npx -y @firecrawl/anydoc convert a.pdf`",
      "- `npx -y @firecrawl/anydoc convert b.docx`",
      "",
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(fixture),
    });
    try {
      const work = await makeTmp("cli-");
      const cfgDir = path.join(work, "cfg");
      await mkdir(cfgDir, { recursive: true });
      const baseAgents = "# caveman base\n";
      await Bun.write(path.join(cfgDir, "AGENTS.md"), baseAgents);
      const manifestFile = path.join(work, "skills.yaml");
      const url = `http://127.0.0.1:${String(server.port)}/skill.md`;
      const manifest = [
        "skills:",
        "  - name: convert-documents-to-markdown",
        "    steps:",
        "      - type: download",
        `        url: ${url}`,
        "        dest: SKILL.md",
        "      - type: replace",
        "        file: SKILL.md",
        "        from: 'npx -y @firecrawl/anydoc'",
        "        to: 'anydoc'",
        "        expected: 3",
        "      - type: replace",
        "        file: SKILL.md",
        "        from: 'It needs Node 20+ and no install:'",
        "        to: 'It is preinstalled on PATH; invoke it directly, never via npx/bunx:'",
        "        expected: 1",
        "      - type: assert-absent",
        "        file: SKILL.md",
        "        pattern: 'npx[^\\r\\n]*@firecrawl/anydoc'",
        "    agents_md: |",
        "      ## per-skill-guidance",
        "      skill body",
        "",
        "agents_md: |",
        "  ## cli-guidance",
        "  test body",
        "",
      ].join("\n");
      await Bun.write(manifestFile, manifest);
      const installer = new URL("./install-skills.ts", import.meta.url)
        .pathname;

      async function runInstaller() {
        const proc = Bun.spawn(["bun", installer], {
          env: {
            ...process.env,
            OPENCODE_CONFIG_DIR: cfgDir,
            SKILLS_MANIFEST: manifestFile,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { out, err, code };
      }

      const first = await runInstaller();
      expect(first.code).toBe(0);
      const skillFile = path.join(
        cfgDir,
        "skills",
        "convert-documents-to-markdown",
        "SKILL.md",
      );
      expect(await Bun.file(skillFile).text()).toContain(
        "It is preinstalled on PATH; invoke it directly, never via npx/bunx:",
      );
      expect(await Bun.file(skillFile).text()).not.toContain(
        "npx -y @firecrawl/anydoc",
      );
      expect(await Bun.file(skillFile).text()).not.toMatch(
        /npx[^\r\n]*@firecrawl\/anydoc/,
      );
      const agentsFirst = await Bun.file(path.join(cfgDir, "AGENTS.md")).text();
      expect(agentsFirst.startsWith(baseAgents)).toBe(true);
      expect(agentsFirst).toContain("## cli-guidance");
      expect(agentsFirst).toContain("## per-skill-guidance");
      expect(agentsFirst.indexOf("## cli-guidance")).toBeLessThan(
        agentsFirst.indexOf("## per-skill-guidance"),
      );

      const second = await runInstaller();
      expect(second.code).toBe(0);
      expect(await Bun.file(path.join(cfgDir, "AGENTS.md")).text()).toBe(
        agentsFirst,
      );

      const badManifest = manifest.replace("expected: 3", "expected: 99");
      await Bun.write(manifestFile, badManifest);
      const skillBefore = await Bun.file(skillFile).text();
      const agentsBefore = await Bun.file(
        path.join(cfgDir, "AGENTS.md"),
      ).text();
      const bad = await runInstaller();
      expect(bad.code).not.toBe(0);
      expect(bad.err + bad.out).toContain("expected 99");
      expect(await Bun.file(skillFile).text()).toBe(skillBefore);
      expect(await Bun.file(path.join(cfgDir, "AGENTS.md")).text()).toBe(
        agentsBefore,
      );
    } finally {
      server.stop();
    }
  }, 30000);

  test("shell direct writes survive publish, repeat idempotent, failure exits nonzero", async () => {
    const work = await makeTmp("cli-shell-");
    const cfgDir = path.join(work, "cfg");
    await mkdir(cfgDir, { recursive: true });
    await Bun.write(path.join(cfgDir, "AGENTS.md"), "# base\n");
    const manifestFile = path.join(work, "skills.yaml");
    const manifest = [
      "skills:",
      "  - name: shellskill",
      "    steps:",
      "      - type: shell",
      "        commands: |",
      '          printf staged > "$SKILL_STAGING_DIR/staged.txt"',
      '          mkdir -p "${OPENCODE_CONFIG_DIR}/skills/shellskill"',
      '          printf direct > "${OPENCODE_CONFIG_DIR}/skills/shellskill/direct.txt"',
      "    agents_md: |",
      "      ## shell-guidance",
      "      body",
      "",
    ].join("\n");
    await Bun.write(manifestFile, manifest);
    const installer = new URL("./install-skills.ts", import.meta.url).pathname;

    async function runInstaller() {
      const proc = Bun.spawn(["bun", installer], {
        env: {
          ...process.env,
          OPENCODE_CONFIG_DIR: cfgDir,
          SKILLS_MANIFEST: manifestFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { out, err, code };
    }

    const first = await runInstaller();
    expect(first.code).toBe(0);
    const skillDir = path.join(cfgDir, "skills", "shellskill");
    expect(await Bun.file(path.join(skillDir, "staged.txt")).text()).toBe(
      "staged",
    );
    expect(await Bun.file(path.join(skillDir, "direct.txt")).text()).toBe(
      "direct",
    );

    const second = await runInstaller();
    expect(second.code).toBe(0);
    expect(await Bun.file(path.join(skillDir, "staged.txt")).text()).toBe(
      "staged",
    );
    expect(await Bun.file(path.join(skillDir, "direct.txt")).text()).toBe(
      "direct",
    );

    await Bun.write(
      manifestFile,
      manifest.replace(
        'printf direct > "${OPENCODE_CONFIG_DIR}/skills/shellskill/direct.txt"',
        "exit 1",
      ),
    );
    const bad = await runInstaller();
    expect(bad.code).not.toBe(0);
    expect(bad.err + bad.out).toContain("shell step failed");
    expect(await Bun.file(path.join(skillDir, "direct.txt")).text()).toBe(
      "direct",
    );
  }, 30000);

  test("group installs skills and lands group agents_md", async () => {
    const work = await makeTmp("cli-group-");
    const cfgDir = path.join(work, "cfg");
    await mkdir(cfgDir, { recursive: true });
    await Bun.write(path.join(cfgDir, "AGENTS.md"), "# base\n");
    const manifestFile = path.join(work, "skills.yaml");
    const manifest = [
      "skills:",
      "  - group: tools",
      "    agents_md: |",
      "      ## group-md",
      "      group body",
      "    skills:",
      "      - name: gskill",
      "        steps:",
      "          - type: shell",
      "            commands: |",
      '              printf hi > "$SKILL_STAGING_DIR/SKILL.md"',
      "",
    ].join("\n");
    await Bun.write(manifestFile, manifest);
    const installer = new URL("./install-skills.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", installer], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: cfgDir,
        SKILLS_MANIFEST: manifestFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(
      await Bun.file(path.join(cfgDir, "skills", "gskill", "SKILL.md")).text(),
    ).toBe("hi");
    expect(await Bun.file(path.join(cfgDir, "AGENTS.md")).text()).toContain(
      "## group-md",
    );
  }, 30000);
});

describe("resolveLatestReleaseTag", () => {
  test("200 with tag returns tag", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 });
    expect(await resolveLatestReleaseTag("o/r")).toBe("v1.2.3");
  });

  test("200 without tag returns null", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200 });
    expect(await resolveLatestReleaseTag("o/r")).toBeNull();
  });

  test("404 returns null", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 404 });
    expect(await resolveLatestReleaseTag("o/r")).toBeNull();
  });

  test("non-ok fails", async () => {
    globalThis.fetch = async () => new Response("oops", { status: 500 });
    await expect(resolveLatestReleaseTag("o/r")).rejects.toThrow(
      "[install-skills]",
    );
  });
});

describe("resolveRef", () => {
  test("missing repo or path fails", async () => {
    await expect(
      resolveRef({ type: "git-export", repo: "", path: "p" }),
    ).rejects.toThrow("[install-skills]");
    await expect(
      resolveRef({ type: "git-export", repo: "o/r", path: "" }),
    ).rejects.toThrow("[install-skills]");
  });

  test("bad repo format fails", async () => {
    await expect(
      resolveRef({ type: "git-export", repo: "not-valid", path: "p" }),
    ).rejects.toThrow("[install-skills]");
  });

  test("pinned version needs no fetch", async () => {
    globalThis.fetch = async () => {
      throw new Error("must not fetch");
    };
    const out = await resolveRef({
      type: "git-export",
      repo: "o/r",
      path: "sub",
      version: "v1.0.0",
    });
    expect(out).toEqual({ repo: "o/r", ref: "v1.0.0", path: "sub" });
  });

  test("latest resolves via fetch, 404 gives null ref", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ tag_name: "v9" }), { status: 200 });
    const out = await resolveRef({
      type: "git-export",
      repo: "o/r",
      path: "p",
    });
    expect(out).toEqual({ repo: "o/r", ref: "v9", path: "p" });

    globalThis.fetch = async () => new Response("x", { status: 404 });
    const out2 = await resolveRef({
      type: "git-export",
      repo: "o/r",
      path: "p",
    });
    expect(out2).toEqual({ repo: "o/r", ref: null, path: "p" });
  });
});

describe("workspaceKey", () => {
  test("formats ref and HEAD", () => {
    expect(workspaceKey("o/r", "v1")).toBe("o/r@v1");
    expect(workspaceKey("o/r", null)).toBe("o/r@HEAD");
  });
});

describe("shell seam", () => {
  test("true succeeds, false fails", async () => {
    await shell(["true"]);
    await expect(shell(["false"])).rejects.toThrow("[install-skills]");
  });
});

describe("safe", () => {
  test("escapes fail, inside passes", async () => {
    const dir = await makeTmp();
    expect(() => safe(dir, "../evil.md")).toThrow("[install-skills]");
    expect(() => safe(dir, "/abs")).toThrow("[install-skills]");
    expect(safe(dir, "a.md")).toBe(path.join(dir, "a.md"));
  });
});

describe("run download", () => {
  test("success writes file, failure throws, traversal throws", async () => {
    const dir = await makeTmp();
    globalThis.fetch = async () => new Response("hello", { status: 200 });
    await run(
      "s",
      { type: "download", url: "https://example.com/x", dest: "SKILL.md" },
      dir,
    );
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe("hello");

    globalThis.fetch = async () => new Response("bad", { status: 500 });
    await expect(
      run(
        "s2",
        { type: "download", url: "https://example.com/x", dest: "SKILL.md" },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");

    globalThis.fetch = async () => new Response("hi", { status: 200 });
    await expect(
      run(
        "s3",
        { type: "download", url: "https://example.com/x", dest: "../evil.md" },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");
  });
});

describe("run git-export url", () => {
  test("stub success writes file, stub failure throws", async () => {
    const dir = await makeTmp();
    const stubDir = await makeTmp("stub-");
    const okStub = path.join(stubDir, "ok.ts");
    await Bun.write(
      okStub,
      'await Bun.write(process.argv[3] + "/SKILL.md", "stub");\n',
    );
    process.env.GIT_EXPORT_SCRIPT = okStub;
    await run("s", { type: "git-export", url: "https://example.com/x" }, dir);
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe("stub");

    const failStub = path.join(stubDir, "fail.ts");
    await Bun.write(failStub, "process.exit(1);\n");
    process.env.GIT_EXPORT_SCRIPT = failStub;
    const dir2 = await makeTmp();
    await expect(
      run("s", { type: "git-export", url: "https://example.com/x" }, dir2),
    ).rejects.toThrow("[install-skills]");
  });
});

describe("run other steps", () => {
  test("replace, assert-absent, shell and unsupported", async () => {
    const dir = await makeTmp();
    await Bun.write(path.join(dir, "f.md"), "hello");
    await run(
      "s",
      { type: "replace", file: "f.md", from: "hello", to: "hi", expected: 1 },
      dir,
    );
    expect(await Bun.file(path.join(dir, "f.md")).text()).toBe("hi");

    await run(
      "s",
      { type: "assert-absent", file: "f.md", pattern: "missing" },
      dir,
    );

    const dir2 = await makeTmp();
    await run(
      "s",
      { type: "shell", commands: 'printf hi > "$SKILL_STAGING_DIR/out.txt"' },
      dir2,
    );
    expect(await Bun.file(path.join(dir2, "out.txt")).text()).toBe("hi");

    await expect(
      run("s", { type: "nope" } as unknown as Step, dir2),
    ).rejects.toThrow("[install-skills]");
  });
});

describe("runSkill", () => {
  test("rename path replaces dest", async () => {
    const destRoot = await makeTmp("runskill-rename-");
    await mkdir(path.join(destRoot, "myskill"), { recursive: true });
    await Bun.write(path.join(destRoot, "myskill", "old.txt"), "old");
    globalThis.fetch = async () => new Response("body", { status: 200 });
    await runSkill(
      "myskill",
      [{ type: "download", url: "https://example.com/x", dest: "SKILL.md" }],
      destRoot,
    );
    expect(
      await Bun.file(path.join(destRoot, "myskill", "SKILL.md")).text(),
    ).toBe("body");
    expect(
      await Bun.file(path.join(destRoot, "myskill", "old.txt")).exists(),
    ).toBe(false);
  });

  test("shell path merges and keeps existing", async () => {
    const destRoot = await makeTmp("runskill-merge-");
    await mkdir(path.join(destRoot, "myskill"), { recursive: true });
    await Bun.write(path.join(destRoot, "myskill", "keep.txt"), "keep");
    await runSkill(
      "myskill",
      [
        {
          type: "shell",
          commands: 'printf staged > "$SKILL_STAGING_DIR/staged.txt"',
        },
      ],
      destRoot,
    );
    expect(
      await Bun.file(path.join(destRoot, "myskill", "keep.txt")).text(),
    ).toBe("keep");
    expect(
      await Bun.file(path.join(destRoot, "myskill", "staged.txt")).text(),
    ).toBe("staged");
  });
});

describe("copySubtreeFromWorkspace", () => {
  test("copies root and subpath, skips .git", async () => {
    const work = await makeTmp("ws-");
    const cloneDir = path.join(work, "repo");
    await mkdir(path.join(cloneDir, "sub"), { recursive: true });
    await Bun.write(path.join(cloneDir, "root.txt"), "root");
    await Bun.write(path.join(cloneDir, "sub", "inner.txt"), "inner");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    await Bun.write(path.join(cloneDir, ".git", "config"), "git");
    const workspace = { dir: work, cloneDir, ref: null };

    const dest = await makeTmp("ws-dest-");
    await copySubtreeFromWorkspace(workspace, "", dest);
    expect(await Bun.file(path.join(dest, "root.txt")).text()).toBe("root");
    expect(await Bun.file(path.join(dest, "sub", "inner.txt")).text()).toBe(
      "inner",
    );
    expect(await readdir(dest)).not.toContain(".git");

    const dest2 = await makeTmp("ws-dest2-");
    await copySubtreeFromWorkspace(workspace, "sub", dest2);
    expect(await Bun.file(path.join(dest2, "inner.txt")).text()).toBe("inner");
  });
});

describe("cleanupWorkspaces", () => {
  test("empty is fine", async () => {
    await cleanupWorkspaces();
  });
});

describe("parse extra", () => {
  test("invalid manifest fails", () => {
    expect(() => parse("")).toThrow("[install-skills]");
    expect(() => parse("skills: 42\n")).toThrow("[install-skills]");
  });

  test("skill with group/skills field fails", () => {
    expect(() =>
      parse("skills:\n  - name: a\n    steps: []\n    skills: []\n"),
    ).toThrow("[install-skills]");
  });

  test("group inner non-object fails", () => {
    expect(() =>
      parse("skills:\n  - group: g\n    skills:\n      - 42\n"),
    ).toThrow("[install-skills]");
  });

  test("absolute file path and missing to fail", () => {
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: /abs\n        from: x\n        to: y\n",
      ),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: SKILL.md\n        from: x\n",
      ),
    ).toThrow("[install-skills]");
  });

  test("missing steps and bad step shapes fail", () => {
    expect(() => parse("skills:\n  - name: a\n")).toThrow("[install-skills]");
    expect(() =>
      parse("skills:\n  - name: a\n    steps:\n      - 42\n"),
    ).toThrow("[install-skills]");
    expect(() =>
      parse(
        "skills:\n  - name: a\n    steps:\n      - type: replace\n        file: ''\n        from: x\n        to: y\n",
      ),
    ).toThrow("[install-skills]");
  });
});

describe("applyFileStep extra", () => {
  test("staging missing fails", async () => {
    const parent = await makeTmp();
    const missing = path.join(parent, "nope");
    await expect(
      applyFileStep(
        "s",
        { type: "replace", file: "x.md", from: "a", to: "b", expected: 1 },
        missing,
      ),
    ).rejects.toThrow("[install-skills]");
  });

  test("invalid regex fails", async () => {
    const dir = await makeTmp();
    await Bun.write(path.join(dir, "f.md"), "hi");
    await expect(
      applyFileStep(
        "s",
        { type: "assert-absent", file: "f.md", pattern: "([" },
        dir,
      ),
    ).rejects.toThrow("[install-skills]");
  });
});

describe("updateAgentsMd extra", () => {
  test("empty additions fail", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "AGENTS.md");
    await Bun.write(target, "base\n");
    await expect(updateAgentsMd(target, "   ")).rejects.toThrow(
      "[install-skills]",
    );
  });

  test("empty file and newline variants", async () => {
    const dir = await makeTmp();
    const emptyTarget = path.join(dir, "AGENTS.md");
    await Bun.write(emptyTarget, "");
    await updateAgentsMd(emptyTarget, "guidance");
    expect(await Bun.file(emptyTarget).text()).toContain(START);

    const dbl = path.join(dir, "dbl.md");
    await Bun.write(dbl, "base\n\n");
    await updateAgentsMd(dbl, "guidance");
    expect(await Bun.file(dbl).text()).toContain(START);

    const noNl = path.join(dir, "nonl.md");
    await Bun.write(noNl, "base");
    await updateAgentsMd(noNl, "guidance");
    expect(await Bun.file(noNl).text()).toContain(START);
  });
});

describe("runShellStep extra", () => {
  test("empty commands fail", async () => {
    const dir = await makeTmp();
    await expect(runShellStep("s", "", dir)).rejects.toThrow(
      "[install-skills]",
    );
    await expect(runShellStep("s", "   ", dir)).rejects.toThrow(
      "[install-skills]",
    );
  });
});

describe("run git-export repo cached", () => {
  test("pinned version uses cached workspace offline", async () => {
    const work = await makeTmp("ws-cache-");
    const cloneDir = path.join(work, "repo");
    await mkdir(path.join(cloneDir, "sub"), { recursive: true });
    await Bun.write(path.join(cloneDir, "sub", "SKILL.md"), "cached");
    await mkdir(path.join(cloneDir, ".git"), { recursive: true });
    workspaces.set("o/r@v1", { dir: work, cloneDir, ref: "v1" });

    const dir = await makeTmp("run-repo-");
    await run(
      "s",
      { type: "git-export", repo: "o/r", path: "sub", version: "v1" },
      dir,
    );
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe("cached");
    // cleanupWorkspaces should remove the fake workspace dir
    await cleanupWorkspaces();
    expect(workspaces.size).toBe(0);
    expect(await Bun.file(path.join(work, "repo")).exists()).toBe(false);
  });
});

describe("run git-export default script", () => {
  test("resolves default when env unset, env override when set", () => {
    process.env.GIT_EXPORT_SCRIPT = "/tmp/opencode/stub-export.ts";
    expect(gitExportScript()).toBe("/tmp/opencode/stub-export.ts");
    delete process.env.GIT_EXPORT_SCRIPT;
    expect(gitExportScript()).toBe(
      path.join(
        process.env.OPENCODE_BUILD_DIR || "/tmp",
        "scripts",
        "git-export.ts",
      ),
    );
  });
});

describe("run offline mocks", () => {
  test("repo clone path via mocked spawn still throws on missing sub", async () => {
    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: unknown }).spawn = (
      _args: string[],
    ): unknown => {
      return { exited: Promise.resolve(0) };
    };
    try {
      const dir = await makeTmp("run-clone-");
      await expect(
        run(
          "s",
          { type: "git-export", repo: "o/r", path: "sub", version: "v1" },
          dir,
        ),
      ).rejects.toThrow();
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = originalSpawn;
      await cleanupWorkspaces().catch(() => {});
      workspaces.clear();
    }
  });

  test("repo clone null ref covers else branch", async () => {
    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: unknown }).spawn = (
      _args: string[],
    ): unknown => {
      return { exited: Promise.resolve(0) };
    };
    globalThis.fetch = async () => new Response("x", { status: 404 });
    try {
      const dir = await makeTmp("run-clone-null-");
      await expect(
        run("s", { type: "git-export", repo: "o/r", path: "sub" }, dir),
      ).rejects.toThrow();
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = originalSpawn;
      await cleanupWorkspaces().catch(() => {});
      workspaces.clear();
    }
  });

  test("uv-pip via mocked spawn records calls", async () => {
    const originalSpawn = Bun.spawn;
    const calls: string[][] = [];
    (Bun as unknown as { spawn: unknown }).spawn = (
      args: string[],
    ): unknown => {
      calls.push(args);
      return { exited: Promise.resolve(0) };
    };
    try {
      const dir = await makeTmp("run-uv-");
      await run("s", { type: "uv-pip", packages: ["a", "b"] }, dir);
      expect(calls).toEqual([
        ["uv", "pip", "install", "--system", "a"],
        ["uv", "pip", "install", "--system", "b"],
      ]);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = originalSpawn;
    }
  });
});
