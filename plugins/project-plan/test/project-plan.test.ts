import { describe, expect, test } from "bun:test";
import {
  editResource,
  resolvePlanDirectory,
  shouldSwitchReminder,
} from "../src/index.ts";

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
});
