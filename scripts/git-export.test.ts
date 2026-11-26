import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  lstat,
  readlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import {
  GitExportError,
  parseGithubDirectoryUrl,
  normalizeSourcePath,
  formatCommand,
  pathExists,
  isDirectory,
  prepareOutputDir,
  removeExisting,
  copyEntry,
  parseArgs,
  printHelp,
  runGit,
  exportDirectory,
  runMain,
  main,
} from "./git-export.ts";

const tmpRoots: string[] = [];

async function makeTmp(prefix = "git-export-test-") {
  await mkdir("/tmp/opencode", { recursive: true }).catch(() => {});
  const dir = await mkdtemp(path.join("/tmp/opencode/", prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  let dir: string | undefined;
  while ((dir = tmpRoots.pop()) !== undefined) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function initFixtureRepo() {
  const dir = await makeTmp("git-export-fixture-");
  await runGit("git", ["init"], dir);
  await runGit("git", ["config", "user.email", "test@test.com"], dir);
  await runGit("git", ["config", "user.name", "test"], dir);
  await mkdir(path.join(dir, "pkg", "sub"), { recursive: true });
  await Bun.write(path.join(dir, "pkg", "sub", "file.txt"), "hello sub");
  await Bun.write(path.join(dir, "root.txt"), "root content");
  await mkdir(path.join(dir, "emptydir"), { recursive: true });
  await Bun.write(path.join(dir, "emptydir", ".gitkeep"), "");
  await mkdir(path.join(dir, "pkg", "emptysub"), { recursive: true });
  await Bun.write(path.join(dir, "pkg", "emptysub", ".gitkeep"), "");
  await runGit("git", ["add", "-A"], dir);
  await runGit("git", ["commit", "-m", "init"], dir);
  await runGit("git", ["tag", "v1"], dir);
  await Bun.write(path.join(dir, "pkg", "sub", "file.txt"), "hello sub v2");
  await Bun.write(path.join(dir, "pkg", "sub", "extra.txt"), "extra");
  await runGit("git", ["add", "-A"], dir);
  await runGit("git", ["commit", "-m", "v2"], dir);
  return dir;
}

function captureLog() {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  return {
    logs,
    restore() {
      console.log = orig;
    },
  };
}

describe("parseGithubDirectoryUrl", () => {
  test("root url", () => {
    const p = parseGithubDirectoryUrl("https://github.com/owner/repo");
    expect(p.repoUrl).toBe("https://github.com/owner/repo.git");
    expect(p.sourcePath).toBeNull();
    expect(p.ref).toBeNull();
  });

  test("git suffix and www host", () => {
    const p = parseGithubDirectoryUrl("https://www.github.com/owner/repo.git");
    expect(p.repoUrl).toBe("https://github.com/owner/repo.git");
  });

  test("tree with ref and path", () => {
    const p = parseGithubDirectoryUrl(
      "https://github.com/owner/repo/tree/main/src/lib",
    );
    expect(p.repoUrl).toBe("https://github.com/owner/repo.git");
    expect(p.ref).toBe("main");
    expect(p.sourcePath).toBe("src/lib");
  });

  test("blob with ref and path", () => {
    const p = parseGithubDirectoryUrl(
      "https://github.com/owner/repo/blob/v1.0/docs/readme.md",
    );
    expect(p.ref).toBe("v1.0");
    expect(p.sourcePath).toBe("docs/readme.md");
  });

  test("bare path without tree/blob", () => {
    const p = parseGithubDirectoryUrl(
      "https://github.com/owner/repo/mydir/sub",
    );
    expect(p.ref).toBeNull();
    expect(p.sourcePath).toBe("mydir/sub");
  });

  test("http protocol allowed", () => {
    const p = parseGithubDirectoryUrl("http://github.com/o/r");
    expect(p.repoUrl).toBe("https://github.com/o/r.git");
  });

  test("invalid url throws", () => {
    expect(() => parseGithubDirectoryUrl("not a url")).toThrow(GitExportError);
  });

  test("wrong host and protocol throw", () => {
    expect(() => parseGithubDirectoryUrl("https://gitlab.com/o/r")).toThrow(
      "Not a supported GitHub URL",
    );
    expect(() => parseGithubDirectoryUrl("ftp://github.com/o/r")).toThrow(
      "Not a supported GitHub URL",
    );
  });

  test("missing owner/repo throws", () => {
    expect(() => parseGithubDirectoryUrl("https://github.com/owner")).toThrow(
      "must include owner/repo",
    );
    expect(() => parseGithubDirectoryUrl("https://github.com/")).toThrow(
      "must include owner/repo",
    );
  });

  test("tree/blob without path throws", () => {
    expect(() =>
      parseGithubDirectoryUrl("https://github.com/o/r/tree/main"),
    ).toThrow("tree/blob URLs must include ref");
    expect(() =>
      parseGithubDirectoryUrl("https://github.com/o/r/blob/v1"),
    ).toThrow("tree/blob URLs must include ref");
    expect(() =>
      parseGithubDirectoryUrl("https://github.com/o/r/tree"),
    ).toThrow("tree/blob URLs must include ref");
  });
});

describe("normalizeSourcePath", () => {
  test("slashes and dot segments", () => {
    expect(normalizeSourcePath("/a/b/")).toBe("a/b");
    expect(normalizeSourcePath("///a///b///")).toBe("a/b");
    expect(normalizeSourcePath("a/./b/./c")).toBe("a/b/c");
    expect(normalizeSourcePath("./a")).toBe("a");
    expect(normalizeSourcePath("  pkg/sub  ")).toBe("pkg/sub");
  });

  test("empty and dotdot reject", () => {
    expect(() => normalizeSourcePath("")).toThrow("must not be empty");
    expect(() => normalizeSourcePath("   ")).toThrow("must not be empty");
    expect(() => normalizeSourcePath("/")).toThrow("must not be empty");
    expect(() => normalizeSourcePath("..")).toThrow("must not contain '..'");
    expect(() => normalizeSourcePath("a/../b")).toThrow(
      "must not contain '..'",
    );
    expect(() => normalizeSourcePath("../a")).toThrow("must not contain '..'");
  });
});

describe("formatCommand", () => {
  test("plain and quoting", () => {
    expect(formatCommand(["git", "clone", "url"])).toBe("git clone url");
    expect(formatCommand(["git", "a b"])).toBe(`git "a b"`);
    expect(formatCommand(["git", `a"b`])).toBe(`git "a\\"b"`);
    expect(formatCommand(["git", "a'b"])).toBe(`git "a'b"`);
  });
});

describe("pathExists/isDirectory", () => {
  test("exists, missing, file vs dir, symlink", async () => {
    const dir = await makeTmp();
    const file = path.join(dir, "f.txt");
    await Bun.write(file, "x");
    expect(await pathExists(file)).toBe(true);
    expect(await pathExists(path.join(dir, "missing"))).toBe(false);
    expect(await isDirectory(dir)).toBe(true);
    expect(await isDirectory(file)).toBe(false);
    expect(await isDirectory(path.join(dir, "missing"))).toBe(false);
    const linkToDir = path.join(dir, "linkdir");
    await symlink(dir, linkToDir);
    expect(await isDirectory(linkToDir)).toBe(false);
    const linkToFile = path.join(dir, "linkfile");
    await symlink(file, linkToFile);
    expect(await isDirectory(linkToFile)).toBe(false);
  });
});

describe("prepareOutputDir", () => {
  test("missing creates", async () => {
    const dir = await makeTmp();
    const out = path.join(dir, "new", "nested");
    await prepareOutputDir(out, false);
    expect(await isDirectory(out)).toBe(true);
  });

  test("exists naked fails", async () => {
    const dir = await makeTmp();
    const out = path.join(dir, "out");
    await mkdir(out, { recursive: true });
    await expect(prepareOutputDir(out, false)).rejects.toThrow(
      "already exists",
    );
  });

  test("exists dir with force replaces", async () => {
    const dir = await makeTmp();
    const out = path.join(dir, "out");
    await mkdir(out, { recursive: true });
    await Bun.write(path.join(out, "old.txt"), "old");
    await prepareOutputDir(out, true);
    expect(await isDirectory(out)).toBe(true);
    expect(await pathExists(path.join(out, "old.txt"))).toBe(false);
  });

  test("exists file with force replaces", async () => {
    const dir = await makeTmp();
    const out = path.join(dir, "out");
    await Bun.write(out, "i am a file");
    await prepareOutputDir(out, true);
    expect(await isDirectory(out)).toBe(true);
  });

  test("exists symlink with force replaces", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "target.txt");
    await Bun.write(target, "t");
    const out = path.join(dir, "out");
    await symlink(target, out);
    expect((await lstat(out)).isSymbolicLink()).toBe(true);
    await prepareOutputDir(out, true);
    expect(await isDirectory(out)).toBe(true);
  });
});

describe("removeExisting", () => {
  test("missing no-op", async () => {
    const dir = await makeTmp();
    await removeExisting(path.join(dir, "nope"));
  });

  test("dir removed", async () => {
    const dir = await makeTmp();
    const sub = path.join(dir, "sub");
    await mkdir(sub, { recursive: true });
    await Bun.write(path.join(sub, "a.txt"), "a");
    await removeExisting(sub);
    expect(await pathExists(sub)).toBe(false);
  });

  test("file removed", async () => {
    const dir = await makeTmp();
    const f = path.join(dir, "f.txt");
    await Bun.write(f, "x");
    await removeExisting(f);
    expect(await pathExists(f)).toBe(false);
  });

  test("symlink removed but target kept", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "t.txt");
    await Bun.write(target, "t");
    const link = path.join(dir, "link");
    await symlink(target, link);
    await removeExisting(link);
    expect(await pathExists(link)).toBe(false);
    expect(await pathExists(target)).toBe(true);
  });
});

describe("copyEntry", () => {
  test("file", async () => {
    const dir = await makeTmp();
    const src = path.join(dir, "src.txt");
    await Bun.write(src, "data");
    const dst = path.join(dir, "dst.txt");
    await copyEntry(src, dst);
    expect(await Bun.file(dst).text()).toBe("data");
  });

  test("dir recursive", async () => {
    const dir = await makeTmp();
    const src = path.join(dir, "srcdir");
    await mkdir(path.join(src, "nested"), { recursive: true });
    await Bun.write(path.join(src, "a.txt"), "a");
    await Bun.write(path.join(src, "nested", "b.txt"), "b");
    const dst = path.join(dir, "dstdir");
    await copyEntry(src, dst);
    expect(await Bun.file(path.join(dst, "a.txt")).text()).toBe("a");
    expect(await Bun.file(path.join(dst, "nested", "b.txt")).text()).toBe("b");
  });

  test("symlink overwrites existing", async () => {
    const dir = await makeTmp();
    const target = path.join(dir, "target.txt");
    await Bun.write(target, "t");
    const src = path.join(dir, "srclink");
    await symlink(target, src);
    const dst = path.join(dir, "dstlink");
    await Bun.write(dst, "old");
    await copyEntry(src, dst);
    expect((await lstat(dst)).isSymbolicLink()).toBe(true);
    expect(await readlink(dst)).toBe(target);
  });
});

describe("runGit", () => {
  test("success", async () => {
    await runGit("git", ["--version"]);
  });

  test("verbose true logs with and without cwd", async () => {
    const cap = captureLog();
    try {
      const dir = await makeTmp();
      await runGit("git", ["--version"], dir, true);
      await runGit("git", ["--version"], undefined, true);
    } finally {
      cap.restore();
    }
    expect(cap.logs.join("\n")).toContain("cwd=");
  });

  test("failure mentions exit code", async () => {
    await expect(runGit("false", ["anything"])).rejects.toThrow(/exit code/);
    await expect(runGit("false", ["anything"])).rejects.toThrow(
      "git command failed",
    );
  });

  test("failure with stderr detail", async () => {
    const dir = await makeTmp();
    await runGit("git", ["init"], dir);
    await expect(
      runGit("git", ["rev-parse", "nonexistent-ref-xyz"], dir),
    ).rejects.toThrow("git command failed");
  });
});

describe("parseArgs", () => {
  test("all flags", () => {
    const o = parseArgs([
      "src",
      "out",
      "--ref",
      "main",
      "--path",
      "a/b",
      "--depth",
      "5",
      "--git",
      "/usr/bin/git",
      "--force",
      "--verbose",
    ]);
    expect(o.source).toBe("src");
    expect(o.output).toBe("out");
    expect(o.ref).toBe("main");
    expect(o.sourcePath).toBe("a/b");
    expect(o.depth).toBe(5);
    expect(o.gitBin).toBe("/usr/bin/git");
    expect(o.force).toBe(true);
    expect(o.verbose).toBe(true);
  });

  test("defaults", () => {
    const o = parseArgs(["s", "o"]);
    expect(o.ref).toBeNull();
    expect(o.sourcePath).toBeNull();
    expect(o.depth).toBe(1);
    expect(o.gitBin).toBe("git");
    expect(o.force).toBe(false);
    expect(o.verbose).toBe(false);
  });

  test("missing values fail", () => {
    expect(() => parseArgs(["s", "o", "--ref"])).toThrow(
      "--ref requires a value",
    );
    expect(() => parseArgs(["s", "o", "--path"])).toThrow(
      "--path requires a value",
    );
    expect(() => parseArgs(["s", "o", "--depth"])).toThrow(
      "--depth requires a value",
    );
    expect(() => parseArgs(["s", "o", "--git"])).toThrow(
      "--git requires a value",
    );
  });

  test("bad depth fails", () => {
    expect(() => parseArgs(["s", "o", "--depth", "0"])).toThrow(
      "Invalid --depth",
    );
    expect(() => parseArgs(["s", "o", "--depth", "-3"])).toThrow(
      "Invalid --depth",
    );
    expect(() => parseArgs(["s", "o", "--depth", "xyz"])).toThrow(
      "Invalid --depth",
    );
  });

  test("unknown option fails", () => {
    expect(() => parseArgs(["s", "o", "--nope"])).toThrow("Unknown option");
    expect(() => parseArgs(["s", "o", "-x"])).toThrow("Unknown option");
  });

  test("wrong positional count fails", () => {
    const cap = captureLog();
    try {
      expect(() => parseArgs([])).toThrow(
        "Expected SOURCE and OUTPUT arguments",
      );
      expect(() => parseArgs(["only-one"])).toThrow(
        "Expected SOURCE and OUTPUT arguments",
      );
      expect(() => parseArgs(["a", "b", "c"])).toThrow(
        "Expected SOURCE and OUTPUT arguments",
      );
    } finally {
      cap.restore();
    }
    expect(cap.logs.join("\n")).toContain("Usage:");
  });
});

describe("printHelp", () => {
  test("logs usage", () => {
    const cap = captureLog();
    try {
      printHelp();
    } finally {
      cap.restore();
    }
    expect(cap.logs.join("\n")).toContain("Usage:");
    expect(cap.logs.join("\n")).toContain("--force");
  });
});

describe("exportDirectory", () => {
  test("subpath export", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-sub");
    await exportDirectory({
      repoUrl: fixture,
      sourcePath: "pkg/sub",
      outputDir: out,
      ref: null,
      depth: 1,
      force: false,
      gitBin: "git",
      verbose: false,
    });
    expect(await Bun.file(path.join(out, "file.txt")).text()).toBe(
      "hello sub v2",
    );
    expect(await Bun.file(path.join(out, "extra.txt")).text()).toBe("extra");
    expect(await pathExists(path.join(out, ".git"))).toBe(false);
    expect(await pathExists(path.join(out, "root.txt"))).toBe(false);
  });

  test("repo-root export skips .git and disables sparse", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-root");
    await exportDirectory({
      repoUrl: fixture,
      sourcePath: "",
      outputDir: out,
      ref: null,
      depth: 1,
      force: false,
      gitBin: "git",
      verbose: false,
    });
    expect(await pathExists(path.join(out, "root.txt"))).toBe(true);
    expect(await pathExists(path.join(out, "pkg", "sub", "file.txt"))).toBe(
      true,
    );
    expect(await pathExists(path.join(out, ".git"))).toBe(false);
    expect(await pathExists(path.join(out, "emptydir", ".gitkeep"))).toBe(true);
    expect(
      await pathExists(path.join(out, "pkg", "emptysub", ".gitkeep")),
    ).toBe(true);
  });

  test("tag ref exports old content with verbose", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-tag");
    const cap = captureLog();
    try {
      await exportDirectory({
        repoUrl: fixture,
        sourcePath: "pkg/sub",
        outputDir: out,
        ref: "v1",
        depth: 1,
        force: false,
        gitBin: "git",
        verbose: true,
      });
    } finally {
      cap.restore();
    }
    expect(await Bun.file(path.join(out, "file.txt")).text()).toBe("hello sub");
    expect(await pathExists(path.join(out, "extra.txt"))).toBe(false);
    expect(cap.logs.join("\n")).toContain("cwd=");
  });

  test("force-overwrite existing output", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-force");
    await mkdir(out, { recursive: true });
    await Bun.write(path.join(out, "stale.txt"), "stale");
    await exportDirectory({
      repoUrl: fixture,
      sourcePath: "pkg/sub",
      outputDir: out,
      ref: null,
      depth: 1,
      force: true,
      gitBin: "git",
      verbose: false,
    });
    expect(await pathExists(path.join(out, "stale.txt"))).toBe(false);
    expect(await pathExists(path.join(out, "file.txt"))).toBe(true);
  });

  test("existing output without force fails", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-noforce");
    await mkdir(out, { recursive: true });
    await expect(
      exportDirectory({
        repoUrl: fixture,
        sourcePath: "pkg/sub",
        outputDir: out,
        ref: null,
        depth: 1,
        force: false,
        gitBin: "git",
        verbose: false,
      }),
    ).rejects.toThrow("already exists");
  });

  test("missing source dir failure", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-missing");
    await expect(
      exportDirectory({
        repoUrl: fixture,
        sourcePath: "does/not/exist",
        outputDir: out,
        ref: null,
        depth: 1,
        force: false,
        gitBin: "git",
        verbose: false,
      }),
    ).rejects.toThrow("Source directory not found");
  });

  test("file-at-output replace", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-file");
    await Bun.write(out, "i am a file");
    await exportDirectory({
      repoUrl: fixture,
      sourcePath: "pkg/sub",
      outputDir: out,
      ref: null,
      depth: 1,
      force: true,
      gitBin: "git",
      verbose: false,
    });
    expect(await isDirectory(out)).toBe(true);
    expect(await pathExists(path.join(out, "file.txt"))).toBe(true);
  });

  test("emptydir with gitkeep exports (empty-dir case)", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "out-empty");
    await exportDirectory({
      repoUrl: fixture,
      sourcePath: "emptydir",
      outputDir: out,
      ref: null,
      depth: 1,
      force: false,
      gitBin: "git",
      verbose: false,
    });
    expect(await isDirectory(out)).toBe(true);
    expect(await readdir(out)).toHaveLength(1);
    expect(await pathExists(path.join(out, ".gitkeep"))).toBe(true);
  });

  test("output parent missing resolves via fallback", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-e2e-");
    const out = path.join(parent, "no-such-parent", "out");
    await exportDirectory({
      repoUrl: fixture,
      sourcePath: "pkg/sub",
      outputDir: out,
      ref: null,
      depth: 1,
      force: false,
      gitBin: "git",
      verbose: false,
    });
    expect(await pathExists(path.join(out, "file.txt"))).toBe(true);
  });
});

describe("runMain", () => {
  test("local fixture with --path succeeds", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-runmain-");
    const out = path.join(parent, "out");
    await runMain([fixture, out, "--path", "pkg/sub"]);
    expect(await Bun.file(path.join(out, "file.txt")).text()).toBe(
      "hello sub v2",
    );
  });

  test("local without --path fails", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-runmain-");
    const out = path.join(parent, "out");
    await expect(runMain([fixture, out])).rejects.toThrow("--path is required");
  });

  test("github root with --path uses false git (no network)", async () => {
    const parent = await makeTmp("git-export-runmain-");
    const out = path.join(parent, "out");
    await expect(
      runMain([
        "https://github.com/o/r",
        out,
        "--path",
        "a/b",
        "--git",
        "false",
      ]),
    ).rejects.toThrow("git command failed");
  });

  test("github tree url uses parsed path and ref (no network)", async () => {
    const parent = await makeTmp("git-export-runmain-");
    const out = path.join(parent, "out");
    await expect(
      runMain([
        "https://github.com/o/r/tree/main/src/app",
        out,
        "--git",
        "false",
      ]),
    ).rejects.toThrow("git command failed");
  });

  test("github root without --path defaults to empty (no network)", async () => {
    const parent = await makeTmp("git-export-runmain-");
    const out = path.join(parent, "out");
    await expect(
      runMain(["https://github.com/o/r", out, "--git", "false"]),
    ).rejects.toThrow("git command failed");
  });

  test("github tree with --ref override (no network)", async () => {
    const parent = await makeTmp("git-export-runmain-");
    const out = path.join(parent, "out");
    await expect(
      runMain([
        "https://github.com/o/r/tree/main/src/app",
        out,
        "--ref",
        "v2",
        "--git",
        "false",
      ]),
    ).rejects.toThrow("git command failed");
  });

  test("main uses process.argv", async () => {
    const fixture = await initFixtureRepo();
    const parent = await makeTmp("git-export-main-");
    const out = path.join(parent, "out");
    const origArgv = process.argv;
    process.argv = ["bun", "git-export.ts", fixture, out, "--path", "pkg/sub"];
    try {
      await main();
    } finally {
      process.argv = origArgv;
    }
    expect(await pathExists(path.join(out, "file.txt"))).toBe(true);
  });
});

describe("cli subprocess", () => {
  test("bad source exit code", async () => {
    const parent = await makeTmp("git-export-cli-");
    const out = path.join(parent, "out");
    const script = new URL("./git-export.ts", import.meta.url).pathname;
    const proc = Bun.spawn(
      ["bun", script, "/nonexistent-source-xyz", out, "--path", "a"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code] = await Promise.all([proc.exited]);
    expect(code).not.toBe(0);
  }, 30000);

  test("--help exit 0", async () => {
    const script = new URL("./git-export.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", script, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [outText, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(outText + errText).toContain("Usage:");
  }, 30000);
});
