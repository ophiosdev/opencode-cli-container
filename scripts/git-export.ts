#!/usr/bin/env bun
import { constants as fsConstants } from "node:fs"
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

class GitExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitExportError"
  }
}

type Options = {
  source: string
  output: string
  ref: string | null
  sourcePath: string | null
  depth: number
  gitBin: string
  force: boolean
  verbose: boolean
}

type ParsedGithubUrl = {
  repoUrl: string
  sourcePath: string | null
  ref: string | null
}

function info(message: string) {
  console.log(`[git-export] ${message}`)
}

function fail(message: string): never {
  throw new GitExportError(message)
}

async function pathExists(target: string) {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

async function isDirectory(target: string) {
  try {
    const stat = await lstat(target)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function formatCommand(args: string[]) {
  return args.map((arg) => (/[\s"']/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ")
}

async function runGit(gitBin: string, args: string[], cwd?: string, verbose = false) {
  const cmd = [gitBin, ...args]
  if (verbose) {
    info(`+ (cwd=${cwd || process.cwd()}) ${formatCommand(cmd)}`)
  }

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdoutText, stderrText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (code !== 0) {
    const stderr = stderrText.trim()
    const stdout = stdoutText.trim()
    const detail = stderr || stdout || `exit code ${code}`
    fail(`git command failed: ${formatCommand(cmd)}\n${detail}`)
  }
}

function normalizeSourcePath(value: string) {
  const source = value.trim().replace(/^\/+|\/+$/g, "")
  if (!source) fail("Source path must not be empty")

  const parts = source.split("/").filter((part) => part && part !== ".")
  if (parts.some((part) => part === "..")) {
    fail("Source path must not contain '..'")
  }

  return parts.join("/")
}

function parseGithubDirectoryUrl(rawUrl: string): ParsedGithubUrl {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    fail(`Not a supported GitHub URL: ${rawUrl}`)
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !["github.com", "www.github.com"].includes(parsed.hostname)) {
    fail(`Not a supported GitHub URL: ${rawUrl}`)
  }

  const parts = parsed.pathname.split("/").filter(Boolean)
  if (parts.length < 2) {
    fail(`GitHub URL must include owner/repo (got: ${rawUrl})`)
  }

  const owner = parts[0]
  const repo = parts[1].endsWith(".git") ? parts[1].slice(0, -4) : parts[1]
  const rest = parts.slice(2)

  let ref: string | null = null
  let sourcePath: string | null = null

  if (rest.length === 0) {
    sourcePath = null
  } else if (rest[0] === "tree" || rest[0] === "blob") {
    if (rest.length < 3) {
      fail(`tree/blob URLs must include ref and directory path, got: ${rawUrl}`)
    }
    ref = rest[1]
    sourcePath = rest.slice(2).join("/")
  } else {
    sourcePath = rest.join("/")
  }

  return {
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    sourcePath: sourcePath === null ? null : normalizeSourcePath(sourcePath),
    ref,
  }
}

async function prepareOutputDir(outputDir: string, force: boolean) {
  if (await pathExists(outputDir)) {
    if (!force) {
      fail(`Output path already exists: ${outputDir} (use --force to overwrite)`)
    }

    const stat = await lstat(outputDir)
    if (stat.isFile() || stat.isSymbolicLink()) {
      await unlink(outputDir)
    } else {
      await rm(outputDir, { recursive: true, force: true })
    }
  }

  await mkdir(outputDir, { recursive: true })
}

async function removeExisting(dst: string) {
  if (!(await pathExists(dst))) return

  const stat = await lstat(dst)
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await rm(dst, { recursive: true, force: true })
    return
  }

  await unlink(dst)
}

async function copyEntry(src: string, dst: string) {
  const stat = await lstat(src)

  if (stat.isSymbolicLink()) {
    const target = await readlink(src)
    await removeExisting(dst)
    await symlink(target, dst)
    return
  }

  if (stat.isDirectory()) {
    await cp(src, dst, {
      recursive: true,
      dereference: false,
      force: true,
      verbatimSymlinks: true,
    })
    return
  }

  await copyFile(src, dst, fsConstants.COPYFILE_FICLONE)
}

async function exportDirectory(options: {
  repoUrl: string
  sourcePath: string
  outputDir: string
  ref: string | null
  depth: number
  force: boolean
  gitBin: string
  verbose: boolean
}) {
  const start = performance.now()
  const sourcePath = options.sourcePath.replace(/^\/+|\/+$/g, "")
  const outputDir = await realpath(path.dirname(options.outputDir)).then(
    (parent) => path.join(parent, path.basename(options.outputDir)),
    () => path.resolve(options.outputDir),
  )

  info(`Repository: ${options.repoUrl}`)
  info(`Source path: ${sourcePath || "(repo root)"}`)
  info(`Ref: ${options.ref || "default branch"}`)
  info(`Output: ${outputDir}`)

  const workDir = await mkdtemp(path.join(os.tmpdir(), "git-export-"))
  const cloneDir = path.join(workDir, "repo")

  try {
    info("Step 1/6: cloning repository (treeless + sparse, no checkout)")
    let stepStart = performance.now()
    await runGit(options.gitBin, [
      "clone",
      "--depth",
      String(options.depth),
      "--filter=tree:0",
      "--sparse",
      "--no-checkout",
      options.repoUrl,
      cloneDir,
    ], undefined, options.verbose)
    info(`Step 1/6 complete in ${((performance.now() - stepStart) / 1000).toFixed(1)}s`)

    info("Step 2/6: configuring sparse checkout")
    stepStart = performance.now()
    await runGit(options.gitBin, ["sparse-checkout", "init", "--cone"], cloneDir, options.verbose)
    if (sourcePath) {
      await runGit(options.gitBin, ["sparse-checkout", "set", "--", sourcePath], cloneDir, options.verbose)
    } else {
      await runGit(options.gitBin, ["sparse-checkout", "disable"], cloneDir, options.verbose)
    }
    info(`Step 2/6 complete in ${((performance.now() - stepStart) / 1000).toFixed(1)}s`)

    info("Step 3/6: checking out requested ref/path")
    stepStart = performance.now()
    if (options.ref) {
      await runGit(options.gitBin, ["fetch", "--depth", String(options.depth), "origin", options.ref], cloneDir, options.verbose)
      await runGit(options.gitBin, ["checkout", "--detach", "FETCH_HEAD"], cloneDir, options.verbose)
    } else {
      await runGit(options.gitBin, ["checkout"], cloneDir, options.verbose)
    }
    info(`Step 3/6 complete in ${((performance.now() - stepStart) / 1000).toFixed(1)}s`)

    info("Step 4/6: validating source directory")
    const sourceDir = sourcePath ? path.join(cloneDir, sourcePath) : cloneDir
    if (!(await isDirectory(sourceDir))) {
      fail(
        `Source directory not found after checkout: ${sourcePath || "."}\nRepository: ${options.repoUrl}\nRef: ${options.ref || "default branch"}`,
      )
    }
    info("Step 4/6 complete")

    info("Step 5/6: preparing output directory")
    stepStart = performance.now()
    await prepareOutputDir(outputDir, options.force)
    info(`Step 5/6 complete in ${((performance.now() - stepStart) / 1000).toFixed(1)}s`)

    info("Step 6/6: copying exported files")
    stepStart = performance.now()
    const children = await readdir(sourceDir)
    const totalChildren = children.length
    if (totalChildren === 0) {
      info("Source directory is empty")
    }

    for (const [index, name] of children.entries()) {
      if (name === ".git") {
        info(`  - [${index + 1}/${totalChildren}] ${name} (skipped)`)
        continue
      }

      info(`  - [${index + 1}/${totalChildren}] ${name}`)
      await copyEntry(path.join(sourceDir, name), path.join(outputDir, name))
    }
    info(`Step 6/6 complete in ${((performance.now() - stepStart) / 1000).toFixed(1)}s`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  info("Finalizing export (removing .git if present)")
  await rm(path.join(outputDir, ".git"), { recursive: true, force: true })
  info(`Export complete in ${((performance.now() - start) / 1000).toFixed(1)}s`)
}

function parseArgs(argv: string[]): Options {
  const positionals: string[] = []
  let ref: string | null = null
  let sourcePath: string | null = null
  let depth = 1
  let gitBin = "git"
  let force = false
  let verbose = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === "--ref") {
      ref = argv[++i] ?? fail("--ref requires a value")
      continue
    }

    if (arg === "--path") {
      sourcePath = argv[++i] ?? fail("--path requires a value")
      continue
    }

    if (arg === "--depth") {
      const value = argv[++i] ?? fail("--depth requires a value")
      depth = Number.parseInt(value, 10)
      if (!Number.isInteger(depth) || depth <= 0) {
        fail(`Invalid --depth value: ${value}`)
      }
      continue
    }

    if (arg === "--git") {
      gitBin = argv[++i] ?? fail("--git requires a value")
      continue
    }

    if (arg === "--force") {
      force = true
      continue
    }

    if (arg === "--verbose") {
      verbose = true
      continue
    }

    if (arg === "-h" || arg === "--help") {
      printHelp()
      process.exit(0)
    }

    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`)
    }

    positionals.push(arg)
  }

  if (positionals.length !== 2) {
    printHelp()
    fail("Expected SOURCE and OUTPUT arguments")
  }

  return {
    source: positionals[0],
    output: positionals[1],
    ref,
    sourcePath,
    depth,
    gitBin,
    force,
    verbose,
  }
}

function printHelp() {
  console.log(`Usage: git-export.ts SOURCE OUTPUT [options]

Export a directory from a GitHub repository.

Options:
  --ref <ref>      Git ref to checkout
  --path <path>    Directory path inside the repo (required for raw repo URLs)
  --depth <n>      Clone depth (default: 1)
  --git <binary>   Git binary to use (default: git)
  --force          Overwrite output if it exists
  --verbose        Print git commands
  -h, --help       Show this help message`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.source.startsWith("https://github.com/")) {
    const parsed = parseGithubDirectoryUrl(args.source)
    const sourcePath = parsed.sourcePath === null ? (args.sourcePath ? normalizeSourcePath(args.sourcePath) : "") : parsed.sourcePath
    const ref = args.ref ?? parsed.ref

    await exportDirectory({
      repoUrl: parsed.repoUrl,
      sourcePath,
      outputDir: args.output,
      ref,
      depth: args.depth,
      force: args.force,
      gitBin: args.gitBin,
      verbose: args.verbose,
    })
    return
  }

  if (!args.sourcePath) {
    fail("--path is required when source is not a GitHub directory URL")
  }

  await exportDirectory({
    repoUrl: args.source,
    sourcePath: normalizeSourcePath(args.sourcePath),
    outputDir: args.output,
    ref: args.ref,
    depth: args.depth,
    force: args.force,
    gitBin: args.gitBin,
    verbose: args.verbose,
  })
}

await main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof GitExportError) {
    console.error(`Error: ${message}`)
    process.exit(2)
  }

  console.error(`Error: ${message}`)
  process.exit(1)
})
