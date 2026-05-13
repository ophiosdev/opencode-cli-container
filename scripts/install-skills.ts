#!/usr/bin/env bun
import { mkdir, mkdtemp, readdir, cp, rm, rename } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import YAML from "yaml"

type Step =
  | { type: "download"; url: string; dest: string }
  | { type: "git-export"; url: string }
  | { type: "git-export"; repo: string; path: string; version?: string }
  | { type: "uv-pip"; packages: string[] }

type GitExportSpec = Extract<Step, { type: "git-export" }>
type ResolvedGitExport = {
  repo: string
  ref: string | null
  path: string
}
type Workspace = {
  dir: string
  cloneDir: string
  ref: string | null
}

type Skill = {
  name: string
  steps: Step[]
}

type Manifest = {
  skills: Skill[]
}

const cfg = process.env.OPENCODE_CONFIG_DIR || "/etc/opencode"
const root = path.join(cfg, "skills")
const base = process.env.OPENCODE_BUILD_DIR || "/tmp"
const manifestPath = process.env.SKILLS_MANIFEST || path.join(base, "skills.yaml")
const gitExport = process.env.GIT_EXPORT_SCRIPT || path.join(base, "scripts", "git-export.ts")
const workspaces = new Map<string, Workspace>()

function fail(msg: string): never {
  throw new Error(`[install-skills] ${msg}`)
}

function info(msg: string) {
  console.log(`[install-skills] ${msg}`)
}

function safe(base: string, dest: string) {
  const file = path.resolve(base, dest)
  const rel = path.relative(base, file)
  if (rel.startsWith("..") || path.isAbsolute(rel)) fail(`invalid destination path: ${dest}`)
  return file
}

async function ensure(dir: string) {
  await mkdir(dir, { recursive: true })
}

async function resetDir(dir: string) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

async function shell(args: string[]) {
  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) fail(`command failed (${code}): ${args.join(" ")}`)
}

function isGitHubRepo(repo: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
}

async function resolveLatestReleaseTag(repo: string) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "install-skills",
    },
  })

  if (res.status === 404) return null
  if (!res.ok) fail(`git-export: failed latest release lookup for ${repo} (${res.status})`)

  const data = (await res.json()) as { tag_name?: unknown }
  const tag = typeof data.tag_name === "string" && data.tag_name ? data.tag_name : null
  if (tag) info(`git-export: resolved latest release for ${repo} -> ${tag}`)
  return tag
}

async function resolveRef(step: GitExportSpec): Promise<ResolvedGitExport> {
  if (!step.repo) fail(`git-export: missing repo`)
  if (!step.path) fail(`git-export: missing path for ${step.repo}`)
  if (!isGitHubRepo(step.repo)) fail(`git-export: unsupported repo format: ${step.repo}`)

  const version = step.version ?? "latest"
  const ref = version === "latest" ? await resolveLatestReleaseTag(step.repo) : version
  return { repo: step.repo, path: step.path, ref }
}

function workspaceKey(repo: string, ref: string | null) {
  return `${repo}@${ref ?? "HEAD"}`
}

async function ensureWorkspace(repo: string, ref: string | null) {
  const key = workspaceKey(repo, ref)
  const existing = workspaces.get(key)
  if (existing) return existing

  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-export-"))
  const cloneDir = path.join(dir, "repo")
  const repoUrl = `https://github.com/${repo}.git`
  await shell(["git", "clone", "--depth", "1", "--filter=tree:0", "--no-checkout", repoUrl, cloneDir])
  if (ref) {
    await shell(["git", "-C", cloneDir, "fetch", "--depth", "1", "origin", ref])
    await shell(["git", "-C", cloneDir, "checkout", "--detach", "FETCH_HEAD"])
  } else {
    await shell(["git", "-C", cloneDir, "checkout"])
  }

  const workspace: Workspace = { dir, cloneDir, ref }
  workspaces.set(key, workspace)
  return workspace
}

async function copySubtreeFromWorkspace(workspace: Workspace, sourcePath: string, destDir: string) {
  const sourceDir = sourcePath ? path.join(workspace.cloneDir, sourcePath) : workspace.cloneDir
  const entries = await readdir(sourceDir)
  await ensure(destDir)
  for (const entry of entries) {
    if (entry === ".git") continue
    await cp(path.join(sourceDir, entry), path.join(destDir, entry), { recursive: true, force: true, verbatimSymlinks: true })
  }
}

async function cleanupWorkspaces() {
  for (const workspace of workspaces.values()) {
    await rm(workspace.dir, { recursive: true, force: true })
  }
  workspaces.clear()
}

async function runSkill(name: string, steps: Step[]) {
  const destDir = path.join(root, name)
  const stageParent = await mkdtemp(path.join(os.tmpdir(), "skills-install-"))
  const stageDir = path.join(stageParent, name)

  try {
    await resetDir(stageDir)
    for (const step of steps) {
      await run(name, step, stageDir)
    }

    await rm(destDir, { recursive: true, force: true })
    await ensure(path.dirname(destDir))
    await rename(stageDir, destDir)
  } finally {
    await rm(stageParent, { recursive: true, force: true })
  }
}

async function run(name: string, step: Step, dir: string) {
  if (step.type === "download") {
    await ensure(dir)
    const res = await fetch(step.url)
    if (!res.ok) fail(`${name}: failed download ${step.url} (${res.status})`)
    await Bun.write(safe(dir, step.dest), await res.text())
    return
  }

  if (step.type === "git-export") {
    await ensure(dir)
    if ("url" in step) {
      await shell(["bun", gitExport, step.url, dir, "--force"])
      return
    }

    const resolved = await resolveRef(step)
    const workspace = await ensureWorkspace(resolved.repo, resolved.ref)
    await copySubtreeFromWorkspace(workspace, resolved.path, dir)
    return
  }

  if (step.type === "uv-pip") {
    for (const pkg of step.packages) {
      await shell(["uv", "pip", "install", "--system", pkg])
    }
    return
  }

  fail(`${name}: unsupported step type`)
}

function parse(input: string): Manifest {
  const parsed = YAML.parse(input) as Partial<Manifest> | null
  if (!parsed || !Array.isArray(parsed.skills)) fail(`invalid manifest at ${manifestPath}`)
  return { skills: parsed.skills as Skill[] }
}

async function main() {
  const manifest = parse(await Bun.file(manifestPath).text())
  await ensure(root)

  try {
    for (const skill of manifest.skills) {
      if (!skill.name) fail(`skill missing name`)
      if (!Array.isArray(skill.steps)) fail(`${skill.name}: missing steps`)
      await runSkill(skill.name, skill.steps)
    }
  } finally {
    await cleanupWorkspaces()
  }
}

await main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exit(1)
})
