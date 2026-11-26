import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  data,
  dst,
  existing,
  fail,
  home,
  json,
  main,
  ms,
  onError,
  src,
} from "./convert-gemini.auth.ts";

const ENV_KEYS = [
  "HOME",
  "XDG_DATA_HOME",
  "GEMINI_OAUTH_CREDS_PATH",
  "OPENCODE_AUTH_PATH",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

let savedEnv: Record<EnvKey, string | undefined>;
const tmpRoots: string[] = [];

async function makeTmp(prefix = "convert-gemini-auth-test-") {
  await mkdir("/tmp/opencode", { recursive: true });
  const dir = await mkdtemp(path.join("/tmp/opencode/", prefix));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    GEMINI_OAUTH_CREDS_PATH: process.env.GEMINI_OAUTH_CREDS_PATH,
    OPENCODE_AUTH_PATH: process.env.OPENCODE_AUTH_PATH,
  };
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  let dir: string | undefined;
  while ((dir = tmpRoots.pop()) !== undefined) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("ms", () => {
  const OFFSET = 55 * 60 * 1000;

  function expectFallback(value: unknown) {
    const before = Date.now();
    const got = ms(value);
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before + OFFSET);
    expect(got).toBeLessThanOrEqual(after + OFFSET);
  }

  test("millisecond numbers pass through, second numbers scale up", () => {
    expect(ms(1700000000000)).toBe(1700000000000);
    expect(ms(1700000000)).toBe(1700000000000);
  });

  test("non-finite numbers fall back", () => {
    expectFallback(Number.NaN);
    expectFallback(Number.POSITIVE_INFINITY);
  });

  test("numeric strings scale like numbers", () => {
    expect(ms("1700000000000")).toBe(1700000000000);
    expect(ms("1700000000")).toBe(1700000000000);
  });

  test("date strings parse to epoch ms", () => {
    expect(ms("2024-01-01T00:00:00.000Z")).toBe(
      Date.parse("2024-01-01T00:00:00.000Z"),
    );
  });

  test("numeric-but-infinite, garbage, empty, and missing fall back", () => {
    expectFallback("Infinity");
    expectFallback("not-a-date");
    expectFallback("");
    expectFallback("   ");
    expectFallback(undefined);
    expectFallback(null);
  });
});

describe("paths", () => {
  test("env overrides win", () => {
    process.env.HOME = "/tmp/opencode/fake-home";
    process.env.XDG_DATA_HOME = "/tmp/opencode/fake-data";
    process.env.GEMINI_OAUTH_CREDS_PATH = "/tmp/opencode/fake-creds.json";
    process.env.OPENCODE_AUTH_PATH = "/tmp/opencode/fake-auth.json";
    expect(home()).toBe("/tmp/opencode/fake-home");
    expect(data()).toBe("/tmp/opencode/fake-data");
    expect(src()).toBe("/tmp/opencode/fake-creds.json");
    expect(dst()).toBe("/tmp/opencode/fake-auth.json");
  });

  test("defaults derive from home", () => {
    process.env.HOME = "/tmp/opencode/fake-home";
    delete process.env.XDG_DATA_HOME;
    delete process.env.GEMINI_OAUTH_CREDS_PATH;
    delete process.env.OPENCODE_AUTH_PATH;
    expect(home()).toBe("/tmp/opencode/fake-home");
    expect(data()).toBe(
      path.join("/tmp/opencode/fake-home", ".local", "share"),
    );
    expect(src()).toBe(
      path.join("/tmp/opencode/fake-home", ".gemini", "oauth_creds.json"),
    );
    expect(dst()).toBe(
      path.join(
        "/tmp/opencode/fake-home",
        ".local",
        "share",
        "opencode",
        "auth.json",
      ),
    );
  });

  test("home falls back to os.homedir without HOME", () => {
    delete process.env.HOME;
    expect(home()).toBe(os.homedir());
  });
});

describe("json/existing", () => {
  test("json reads a valid file", async () => {
    const dir = await makeTmp();
    const file = path.join(dir, "a.json");
    await Bun.write(file, JSON.stringify({ a: 1 }));
    expect(await json(file)).toEqual({ a: 1 });
  });

  test("existing returns content, {} for missing or corrupt", async () => {
    const dir = await makeTmp();
    const good = path.join(dir, "good.json");
    await Bun.write(good, JSON.stringify({ google: { type: "oauth" } }));
    expect(await existing(good)).toEqual({ google: { type: "oauth" } });
    expect(await existing(path.join(dir, "missing.json"))).toEqual({});
    const bad = path.join(dir, "bad.json");
    await Bun.write(bad, "{not json");
    expect(await existing(bad)).toEqual({});
  });
});

describe("fail", () => {
  function mockExit() {
    const logged: string[] = [];
    let code: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (c?: number): never => {
        code = c;
        throw new Error(`exited:${String(c)}`);
      },
    );
    const errorSpy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]): void => {
        logged.push(args.map((a) => String(a)).join(" "));
      },
    );
    return {
      logged,
      code: () => code,
      restore: () => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      },
    };
  }

  test("logs and exits 1", () => {
    const mocked = mockExit();
    try {
      expect(() => fail("boom")).toThrow("exited:1");
      expect(mocked.code()).toBe(1);
      expect(mocked.logged.join("\n")).toContain("[convert-gemini.auth] boom");
    } finally {
      mocked.restore();
    }
  });

  test("onError reports Error messages and plain values", () => {
    const mocked = mockExit();
    try {
      expect(() => onError(new Error("bad creds"))).toThrow("exited:1");
      expect(() => onError("plain")).toThrow("exited:1");
      expect(mocked.logged.join("\n")).toContain(
        "[convert-gemini.auth] bad creds",
      );
      expect(mocked.logged.join("\n")).toContain("[convert-gemini.auth] plain");
    } finally {
      mocked.restore();
    }
  });
});

describe("main", () => {
  test("writes merged auth.json from tmp creds", async () => {
    const dir = await makeTmp();
    const credsFile = path.join(dir, "oauth_creds.json");
    const authFile = path.join(dir, "sub", "auth.json");
    await Bun.write(
      credsFile,
      JSON.stringify({
        access_token: "access-123",
        refresh_token: "refresh-456",
        expiry_date: 1700000000,
      }),
    );
    await mkdir(path.dirname(authFile), { recursive: true });
    await Bun.write(authFile, JSON.stringify({ other: { keep: true } }));
    process.env.GEMINI_OAUTH_CREDS_PATH = credsFile;
    process.env.OPENCODE_AUTH_PATH = authFile;
    await main();
    const raw = await readFile(authFile, "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    expect(auth.other).toEqual({ keep: true });
    expect(auth.google).toEqual({
      type: "oauth",
      refresh: "refresh-456",
      access: "access-123",
      expires: 1700000000000,
    });
    expect(raw.endsWith("\n")).toBe(true);
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
  });

  test("missing tokens fail via CLI with exit 1", async () => {
    const dir = await makeTmp("cli-");
    const script = new URL("./convert-gemini.auth.ts", import.meta.url)
      .pathname;
    for (const [name, creds, needle] of [
      ["no-refresh", { access_token: "a" }, "missing refresh_token"],
      ["no-access", { refresh_token: "r" }, "missing access_token"],
    ] as const) {
      const credsFile = path.join(dir, `${name}.json`);
      const authFile = path.join(dir, `${name}.auth.json`);
      await Bun.write(credsFile, JSON.stringify(creds));
      const proc = Bun.spawn(["bun", script], {
        env: {
          ...process.env,
          GEMINI_OAUTH_CREDS_PATH: credsFile,
          OPENCODE_AUTH_PATH: authFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [err, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(1);
      expect(err).toContain(needle);
    }
  }, 30000);
});
