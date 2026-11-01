import { Agent, Plugin } from "@opencode/plugin/effect";
import { Cause, Effect, Stream } from "effect";
import path from "node:path";

const plan = Agent.ID.make("plan");

const enter = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`;

export function resolvePlanDirectory(
  option: unknown,
  projectDirectory: string,
) {
  if (option !== undefined && (typeof option !== "string" || !option.trim())) {
    throw new Error("Plan plugin option 'directory' must be a non-empty path");
  }

  const root = path.resolve(projectDirectory);
  const directory = path.resolve(root, option ?? ".opencode/plans");
  const relative = path.relative(root, directory);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Plan plugin option 'directory' must be inside the project checkout",
    );
  }
  return directory;
}

export function editResource(locationDirectory: string, directory: string) {
  return `${path.relative(locationDirectory, directory).split(path.sep).join("/")}/*`;
}

export function shouldSwitchReminder(
  event:
    | { type: "session.created"; data: { agent?: string | undefined } }
    | {
        type: "session.agent.selected";
        data: { agent: string; previous?: string | undefined };
      },
): "enter" | "leave" | undefined {
  if (event.type === "session.created")
    return event.data.agent === plan ? "enter" : undefined;
  if (event.data.agent === event.data.previous) return undefined;
  if (event.data.agent === plan) return "enter";
  if (event.data.previous === plan) return "leave";
  return undefined;
}

export default Plugin.define({
  id: "ophios.project-plan",
  effect: Effect.fn(function* (ctx) {
    const directory = resolvePlanDirectory(
      ctx.options["directory"],
      ctx.location.project.directory,
    );
    const enterReminder = enter(directory);
    const allow = editResource(ctx.location.directory, directory);

    yield* ctx.agent.transform((editor) => {
      editor.update(plan, (agent) => {
        agent.name = Agent.Name.make("Plan");
        agent.description =
          "Read-only agent for exploring codebases and planning work before implementation.";
        agent.mode = "primary";
        agent.permissions.push({
          action: "question",
          resource: "*",
          effect: "allow",
        });
        agent.permissions.push({
          action: "edit",
          resource: "*",
          effect: "deny",
        });
        agent.permissions.push({
          action: "edit",
          resource: allow,
          effect: "allow",
        });
      });
    });

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan || event.status !== "error") return Effect.void;
      if (
        event.tool !== "edit" &&
        event.tool !== "write" &&
        event.tool !== "patch"
      )
        return Effect.void;
      if (!event.error.message.startsWith("Permission denied: edit"))
        return Effect.void;
      event.error.message = `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`;
      return Effect.void;
    });

    yield* ctx.session.hook("context", (event) => {
      const previous = event.messages.reduce<string | undefined>(
        (found, message) => {
          const part =
            message.role === "user" && message.content.length === 1
              ? message.content[0]
              : undefined;
          if (part?.type !== "text") return found;
          return part.text === enterReminder || part.text === leave
            ? part.text
            : found;
        },
        undefined,
      );
      const missing = event.agent === plan && previous !== enterReminder;
      const stale = event.agent !== plan && previous === enterReminder;
      const text = missing ? enterReminder : stale ? leave : undefined;
      if (!text) return Effect.void;

      const at =
        event.messages.at(-1)?.role === "user"
          ? event.messages.length - 1
          : event.messages.length;
      event.messages.splice(at, 0, {
        role: "user",
        content: [{ type: "text", text }],
      });
      return ctx.session
        .synthetic({ sessionID: event.sessionID, text, resume: false })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("failed to persist Plan mode reminder", {
                  sessionID: event.sessionID,
                  cause,
                }),
          ),
        );
    });

    yield* ctx.event
      .subscribe({ types: ["session.created", "session.agent.selected"] })
      .pipe(
        Stream.runForEach((event) => {
          const mode = shouldSwitchReminder(event);
          if (!mode) return Effect.void;
          return Effect.gen(function* () {
            const session = yield* ctx.session.get({
              sessionID: event.data.sessionID,
            });
            if (
              session.projectID !== ctx.location.project.id ||
              session.location.directory !== ctx.location.directory ||
              session.location.workspaceID !== ctx.location.workspaceID
            )
              return;
            const text = mode === "enter" ? enterReminder : leave;
            yield* ctx.session.synthetic({
              sessionID: event.data.sessionID,
              text,
              resume: false,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("failed to inject Plan mode reminder", {
                    sessionID: event.data.sessionID,
                    cause,
                  }),
            ),
          );
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
  }),
});
