# OpenCode Plugin Workspace

This directory contains local OpenCode plugins. The workspace root owns the shared ESLint, TypeScript, test, and formatting tools. Each plugin owns its runtime dependencies and exposes the commands needed to work on that package.

## Add a plugin package

Create a direct child directory for the plugin. Keep the server entry point in `src/`, tests in `test/`, and declare the runtime package entry in that plugin's `package.json`.

```text
plugins/
├── eslint.config.mjs
├── package.json
├── tsconfig.json
├── bun.lock
└── my-plugin/
    ├── package.json
    ├── src/index.ts
    └── test/
```

The root `package.json` declares `"workspaces": ["*"]`. Bun discovers each direct child package as a workspace. Put shared development tools such as ESLint, TypeScript, Prettier, and Bun types in the root manifest. Put packages needed when OpenCode loads the plugin in that plugin's `dependencies` or `peerDependencies`.

Plugin packages inherit the ESLint flat config and TypeScript options from this directory. The shared config lints `src/` and `test/`; the shared TypeScript project includes each package's `src/**/*.ts` and `test/**/*.ts`. Do not add a separate ESLint config or TypeScript config unless the plugin has a concrete need for different rules or compiler options.

## Package scripts

Copy this script set into a new plugin's `package.json`:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "test:artifact": "bun build --outdir=dist src/index.ts --external @opencode/plugin --external effect && bun run test/verify-artifact.js",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "lint:staged": "eslint --fix",
    "format": "prettier --write . --ignore-path ../.prettierignore",
    "format:check": "prettier --check . --ignore-path ../.prettierignore",
    "format:staged": "prettier --write --ignore-path ../.prettierignore"
  }
}
```

`format:staged` and `lint:staged` accept filenames as arguments. Run them from the plugin package directory, passing paths relative to that directory. A pre-commit hook running from the repository root must change to the package directory or rewrite the staged paths first.

The artifact build leaves `@opencode/plugin` and `effect` external. OpenCode supplies those modules at runtime; bundling copies can split the host's Effect runtime. Add `test/verify-artifact.js` when the plugin exports a built artifact contract to smoke-test the generated module. This generated-artifact verifier is intentionally outside the shared TypeScript project's `src/` and `test/` includes.

## Install and work on plugins

Run Bun commands from this directory or a plugin package directory. After adding a package or changing dependencies, refresh the workspace lockfile from the workspace root:

```sh
cd plugins
bun install
```

Run checks for one plugin:

```sh
cd plugins/my-plugin
bun run lint
bun run typecheck
bun run test
bun run test:artifact
bun run format:check
```

Use `bun run lint:fix` and `bun run format` for whole-package fixes. For staged files, pass the staged paths relative to the package directory to `lint:staged` or `format:staged`.

## Keep host SDK dependencies external

OpenCode V2 plugins should declare a compatible `@opencode/plugin` and `effect` version for development and types. Treat them as host-provided runtime modules. Do not bundle them into plugin artifacts. Keep plugin API versions aligned with the OpenCode version targeted by the container, and test the installed image when packaging changes.
