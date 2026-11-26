import { describe, expect, test } from "bun:test";
import { Effect, Exit, Logger, Queue, Scope, Stream } from "effect";
import plugin, {
  editResource,
  resolvePlanDirectory,
  shouldSwitchReminder,
} from "../src/index.ts";

// The failure-path tests below deliberately kill synthetic() with Effect.die,
// which makes the plugin log a warning. Silence logs there so the output only
// shows relevant failures.
const silentLogs = Logger.layer([Logger.make(() => undefined)]);

describe("project-local Plan plugin", () => {
  test("defaults to .opencode/plans at the project root", () => {
    expect(resolvePlanDirectory(undefined, "/workspace/repo")).toBe(
      "/workspace/repo/.opencode/plans",
    );
  });

  test("resolves nested Locations back to the project plan directory", () => {
    expect(
      editResource("/workspace/repo/src", "/workspace/repo/.opencode/plans"),
    ).toBe("../.opencode/plans/*");
  });

  test("rejects a directory outside the project checkout", () => {
    expect(() =>
      resolvePlanDirectory("../outside", "/workspace/repo"),
    ).toThrow();
  });

  test("adds reminders only when the selected agent changes into or out of Plan", () => {
    expect(
      shouldSwitchReminder({
        type: "session.created",
        data: { agent: "plan" },
      }),
    ).toBe("enter");
    expect(
      shouldSwitchReminder({
        type: "session.agent.selected",
        data: { agent: "plan", previous: "build" },
      }),
    ).toBe("enter");
    expect(
      shouldSwitchReminder({
        type: "session.agent.selected",
        data: { agent: "build", previous: "plan" },
      }),
    ).toBe("leave");
    expect(
      shouldSwitchReminder({
        type: "session.agent.selected",
        data: { agent: "build", previous: "build" },
      }),
    ).toBeUndefined();
  });

  test("rejects non-string or blank directory options", () => {
    expect(() => resolvePlanDirectory(42, "/workspace/repo")).toThrow(
      "must be a non-empty path",
    );
    expect(() => resolvePlanDirectory("   ", "/workspace/repo")).toThrow(
      "must be a non-empty path",
    );
  });

  test("rejects absolute paths outside the project checkout", () => {
    expect(() => resolvePlanDirectory("/outside", "/workspace/repo")).toThrow(
      "must be inside the project checkout",
    );
  });

  test("resolves nested directories inside the project", () => {
    expect(resolvePlanDirectory("plans/custom", "/workspace/repo")).toBe(
      "/workspace/repo/plans/custom",
    );
  });

  test("builds a plan glob relative to the current directory", () => {
    expect(
      editResource("/workspace/repo", "/workspace/repo/.opencode/plans"),
    ).toBe(".opencode/plans/*");
  });

  test("stays silent for sessions that never touch Plan", () => {
    expect(
      shouldSwitchReminder({ type: "session.created", data: {} }),
    ).toBeUndefined();
    expect(
      shouldSwitchReminder({
        type: "session.created",
        data: { agent: "build" },
      }),
    ).toBeUndefined();
    expect(
      shouldSwitchReminder({
        type: "session.agent.selected",
        data: { agent: "plan", previous: "plan" },
      }),
    ).toBeUndefined();
    expect(
      shouldSwitchReminder({
        type: "session.agent.selected",
        data: { agent: "build", previous: "other" },
      }),
    ).toBeUndefined();
  });
});

const projectDirectory = "/repo";
const projectID = "project-1";
const workspaceID = "workspace-1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

function userText(text: string): any {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolEvent(overrides: any): any {
  return {
    tool: "edit",
    sessionID: "session-1",
    agent: "plan",
    messageID: "message-1",
    id: "call-1",
    input: {},
    status: "error",
    error: { message: "Permission denied: edit /repo/other.ts" },
    ...overrides,
  };
}

interface Harness {
  agents: any[];
  toolHooks: Record<string, (event: any) => Effect.Effect<unknown>>;
  sessionHooks: Record<string, (event: any) => Effect.Effect<unknown>>;
  syntheticCalls: any[];
  offer: (event: any) => Promise<void>;
  setSynthetic: (impl: (args: any) => Effect.Effect<any>) => void;
  setSession: (resolve: (args: any) => any) => void;
  clearSyntheticCalls: () => void;
  close: () => Promise<void>;
}

async function setup(input?: {
  options?: Record<string, any>;
  synthetic?: (args: any) => Effect.Effect<any>;
  silent?: boolean;
}): Promise<Harness> {
  const agents: any[] = [];
  const toolHooks: Record<string, any> = {};
  const sessionHooks: Record<string, any> = {};
  const syntheticCalls: any[] = [];
  const queue = await Effect.runPromise(Queue.unbounded<any>());
  let syntheticImpl =
    input?.synthetic ?? ((_args: any) => Effect.void as Effect.Effect<any>);
  let sessionFor: (args: any) => any = () => ({
    projectID,
    location: { directory: projectDirectory, workspaceID },
  });
  const ctx = {
    options: input?.options ?? {},
    location: {
      project: { directory: projectDirectory, id: projectID },
      directory: projectDirectory,
      workspaceID,
    },
    agent: {
      transform: (callback: any) => {
        const editor = {
          update: (id: string, update: any) => {
            const agent: any = {
              name: "",
              description: "",
              mode: "",
              permissions: [],
            };
            update(agent);
            agents.push({ id, agent });
          },
        };
        callback(editor);
        return Effect.succeed({ dispose: Effect.void });
      },
    },
    tool: {
      hook: (name: string, callback: any) => {
        toolHooks[name] = callback;
        return Effect.succeed({ dispose: Effect.void });
      },
    },
    session: {
      hook: (name: string, callback: any) => {
        sessionHooks[name] = callback;
        return Effect.succeed({ dispose: Effect.void });
      },
      get: (args: any) => Effect.succeed(sessionFor(args)),
      synthetic: (args: any) => {
        syntheticCalls.push(args);
        return syntheticImpl(args);
      },
    },
    event: {
      subscribe: () => Stream.fromQueue(queue),
    },
  } as unknown as Parameters<typeof plugin.effect>[0];
  const scope = await Effect.runPromise(Scope.make());
  const effect = plugin.effect(ctx).pipe(Scope.provide(scope));
  await Effect.runPromise(
    input?.silent ? Effect.provide(effect, silentLogs) : effect,
  );
  return {
    agents,
    toolHooks,
    sessionHooks,
    syntheticCalls,
    offer: async (event: any) => {
      await Effect.runPromise(Queue.offer(queue, event));
    },
    setSynthetic: (impl) => {
      syntheticImpl = impl;
    },
    setSession: (resolve) => {
      sessionFor = resolve;
    },
    clearSyntheticCalls: () => {
      syntheticCalls.length = 0;
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
}

async function learnTexts(
  h: Harness,
): Promise<{ enter: string; leave: string }> {
  const hook = h.sessionHooks["context"]!;
  await Effect.runPromise(
    hook({ agent: "plan", messages: [], sessionID: "s" }),
  );
  const enter = h.syntheticCalls[0].text as string;
  await Effect.runPromise(
    hook({ agent: "build", messages: [userText(enter)], sessionID: "s" }),
  );
  const leave = h.syntheticCalls[1].text as string;
  h.clearSyntheticCalls();
  return { enter, leave };
}

describe("plan agent transform", () => {
  test("configures the Plan agent as read-only within the plan directory", async () => {
    const h = await setup();
    try {
      expect(h.agents).toHaveLength(1);
      const entry = h.agents[0];
      expect(entry.id).toBe("plan");
      expect(entry.agent.name).toBe("Plan");
      expect(entry.agent.description).toBe(
        "Read-only agent for exploring codebases and planning work before implementation.",
      );
      expect(entry.agent.mode).toBe("primary");
      expect(entry.agent.permissions).toEqual([
        { action: "question", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: ".opencode/plans/*", effect: "allow" },
      ]);
    } finally {
      await h.close();
    }
  });

  test("scopes the allow rule to a custom directory option", async () => {
    const h = await setup({ options: { directory: "custom" } });
    try {
      expect(h.agents).toHaveLength(1);
      expect(h.agents[0].agent.permissions[2]).toEqual({
        action: "edit",
        resource: "custom/*",
        effect: "allow",
      });
    } finally {
      await h.close();
    }
  });
});

describe("execute.after hook", () => {
  test("points permission errors at the plan directory, nothing else", async () => {
    const h = await setup();
    try {
      const hook = h.toolHooks["execute.after"]!;
      const denied = toolEvent({});
      await Effect.runPromise(hook(denied));
      expect(denied.error.message).toBe(
        "Cannot use edit to modify files outside the Plan directory: /repo/.opencode/plans",
      );
      for (const tool of ["write", "patch"]) {
        const event = toolEvent({ tool });
        await Effect.runPromise(hook(event));
        expect(event.error.message).toBe(
          `Cannot use ${tool} to modify files outside the Plan directory: /repo/.opencode/plans`,
        );
      }
      const untouched = [
        toolEvent({ agent: "build" }),
        toolEvent({ status: "completed", result: {} }),
        toolEvent({ tool: "read" }),
        toolEvent({ error: { message: "Something else broke" } }),
      ];
      for (const event of untouched) {
        const before = event.error?.message;
        await Effect.runPromise(hook(event));
        expect(event.error?.message).toBe(before);
      }
    } finally {
      await h.close();
    }
  });
});

describe("context hook", () => {
  test("appends the enter reminder for the plan agent", async () => {
    const h = await setup();
    try {
      const hook = h.sessionHooks["context"]!;
      const messages: any[] = [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ];
      await Effect.runPromise(
        hook({ agent: "plan", messages, sessionID: "session-1" }),
      );
      expect(messages).toHaveLength(2);
      const text = messages[1].content[0].text as string;
      expect(text).toContain("You are in Plan mode");
      expect(text).toContain("/repo/.opencode/plans");
      expect(h.syntheticCalls).toEqual([
        { sessionID: "session-1", text, resume: false },
      ]);
    } finally {
      await h.close();
    }
  });

  test("inserts before a trailing user message", async () => {
    const h = await setup();
    try {
      const hook = h.sessionHooks["context"]!;
      const messages: any[] = [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        userText("go on"),
      ];
      await Effect.runPromise(
        hook({ agent: "plan", messages, sessionID: "session-1" }),
      );
      expect(messages).toHaveLength(3);
      expect(messages[1].content[0].text).toContain("You are in Plan mode");
      expect(messages[2]).toEqual(userText("go on"));
    } finally {
      await h.close();
    }
  });

  test("inserts the leave reminder when the reminder goes stale", async () => {
    const h = await setup();
    try {
      const { enter } = await learnTexts(h);
      const hook = h.sessionHooks["context"]!;
      const messages: any[] = [userText(enter)];
      await Effect.runPromise(
        hook({ agent: "build", messages, sessionID: "session-1" }),
      );
      expect(messages).toHaveLength(2);
      const text = messages[0].content[0].text as string;
      expect(text).toContain("NO LONGER in Plan mode");
      expect(h.syntheticCalls).toEqual([
        { sessionID: "session-1", text, resume: false },
      ]);
    } finally {
      await h.close();
    }
  });

  test("leaves messages alone when the reminder already matches", async () => {
    const h = await setup();
    try {
      const { enter, leave } = await learnTexts(h);
      const hook = h.sessionHooks["context"]!;
      const cases: any[] = [
        { agent: "plan", messages: [userText(enter)], sessionID: "s" },
        { agent: "build", messages: [userText("hello")], sessionID: "s" },
        { agent: "build", messages: [userText(leave)], sessionID: "s" },
      ];
      for (const event of cases) {
        const before: number = event.messages.length;
        await Effect.runPromise(hook(event));
        expect(event.messages).toHaveLength(before);
      }
      expect(h.syntheticCalls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  test("ignores non-user, multi-part, and non-text content", async () => {
    const h = await setup();
    try {
      const { enter } = await learnTexts(h);
      const hook = h.sessionHooks["context"]!;
      const messages: any[] = [
        { role: "assistant", content: [{ type: "text", text: enter }] },
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
        { role: "user", content: [{ type: "image", url: "x" }] },
      ];
      await Effect.runPromise(
        hook({ agent: "build", messages, sessionID: "session-1" }),
      );
      expect(messages).toHaveLength(3);
      expect(h.syntheticCalls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  test("replays non-text parts while still reminding the plan agent", async () => {
    const h = await setup();
    try {
      const hook = h.sessionHooks["context"]!;
      const messages: any[] = [
        { role: "user", content: [{ type: "tool", text: "x" }] },
      ];
      await Effect.runPromise(
        hook({ agent: "plan", messages, sessionID: "session-1" }),
      );
      expect(messages).toHaveLength(2);
      expect(h.syntheticCalls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  test("interrupts when persisting the reminder is interrupted", async () => {
    const h = await setup({ synthetic: () => Effect.interrupt });
    try {
      const hook = h.sessionHooks["context"]!;
      const exit = await Effect.runPromiseExit(
        hook({ agent: "plan", messages: [], sessionID: "session-1" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.syntheticCalls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  test("logs instead of failing when persisting the reminder fails", async () => {
    const h = await setup({
      synthetic: () => Effect.die(new Error("boom")),
    });
    try {
      const hook = h.sessionHooks["context"]!;
      await Effect.runPromise(
        Effect.provide(
          hook({ agent: "plan", messages: [], sessionID: "session-1" }),
          silentLogs,
        ),
      );
      expect(h.syntheticCalls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe("event subscription", () => {
  test("injects the enter reminder when entering Plan mode", async () => {
    const h = await setup();
    try {
      const { enter } = await learnTexts(h);
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-enter", agent: "plan" },
      });
      await h.offer({
        type: "session.agent.selected",
        data: { sessionID: "s-select", agent: "plan", previous: "build" },
      });
      await waitFor(() => h.syntheticCalls.length === 2);
      expect(h.syntheticCalls).toEqual([
        { sessionID: "s-enter", text: enter, resume: false },
        { sessionID: "s-select", text: enter, resume: false },
      ]);
    } finally {
      await h.close();
    }
  });

  test("injects the leave reminder when leaving Plan mode", async () => {
    const h = await setup();
    try {
      const { leave } = await learnTexts(h);
      await h.offer({
        type: "session.agent.selected",
        data: { sessionID: "s-leave", agent: "build", previous: "plan" },
      });
      await waitFor(() => h.syntheticCalls.length === 1);
      expect(h.syntheticCalls).toEqual([
        { sessionID: "s-leave", text: leave, resume: false },
      ]);
    } finally {
      await h.close();
    }
  });

  test("ignores sessions that do not switch plan mode", async () => {
    const h = await setup();
    try {
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-1", agent: "build" },
      });
      await h.offer({
        type: "session.agent.selected",
        data: { sessionID: "s-2", agent: "build", previous: "build" },
      });
      await h.offer({
        type: "session.agent.selected",
        data: { sessionID: "s-3", agent: "build", previous: "other" },
      });
      await sleep(150);
      expect(h.syntheticCalls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  test("skips sessions from other projects or locations", async () => {
    const h = await setup();
    try {
      h.setSession((args: any) => {
        if (args.sessionID === "s-project")
          return {
            projectID: "other",
            location: { directory: projectDirectory, workspaceID },
          };
        if (args.sessionID === "s-directory")
          return {
            projectID,
            location: { directory: "/elsewhere", workspaceID },
          };
        return {
          projectID,
          location: { directory: projectDirectory, workspaceID: "other" },
        };
      });
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-project", agent: "plan" },
      });
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-directory", agent: "plan" },
      });
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-workspace", agent: "plan" },
      });
      await sleep(200);
      expect(h.syntheticCalls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  test("keeps injecting after synthetic failures", async () => {
    const h = await setup({
      synthetic: () => Effect.die(new Error("boom")),
      silent: true,
    });
    try {
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-bad", agent: "plan" },
      });
      await waitFor(() => h.syntheticCalls.length === 1);
      await sleep(150);
      h.setSynthetic(() => Effect.void);
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-good", agent: "plan" },
      });
      await waitFor(() => h.syntheticCalls.length === 2);
      expect(h.syntheticCalls[1].sessionID).toBe("s-good");
    } finally {
      await h.close();
    }
  });

  test("stops the subscription when injection is interrupted", async () => {
    const h = await setup({ synthetic: () => Effect.interrupt });
    try {
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-bad", agent: "plan" },
      });
      await waitFor(() => h.syntheticCalls.length === 1);
      await sleep(150);
      h.setSynthetic(() => Effect.void);
      await h.offer({
        type: "session.created",
        data: { sessionID: "s-good", agent: "plan" },
      });
      await sleep(200);
      expect(h.syntheticCalls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
