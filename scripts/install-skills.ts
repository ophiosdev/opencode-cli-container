#!/usr/bin/env bun
import { mkdir, mkdtemp, readdir, cp, rm, rename, realpath, stat, lstat, chmod, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import YAML from "yaml"

type Step =
  | { type: "download"; url: string; dest: string }
  | { type: "git-export"; url: string }
  | { type: "git-export"; repo: string; path: string; version?: string }
  | { type: "uv-pip"; packages: string[] }
  | { type: "shell"; commands: string }
  | { type: "replace"; file: string; from: string; to: string; expected?: number }
  | { type: "assert-absent"; file: string; pattern: string }

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
  agents_md?: string
}

type SkillGroup = {
  group: string
  skills: Skill[]
  agents_md?: string
}

type ManifestEntry = Skill | SkillGroup

type Manifest = {
  skills: ManifestEntry[]
  agents_md?: string
}

const AGENTS_MD_START = "<!-- install-skills:agents-md:start -->"
const AGENTS_MD_END = "<!-- install-skills:agents-md:end -->"

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

export function isGroup(entry: unknown): entry is SkillGroup {
  return !!entry && typeof entry === "object" && "group" in (entry as Record<string, unknown>)
}

function checkAgentsMd(value: unknown, label: string) {
  if (value === undefined) return
  if (typeof value !== "string" || !value.trim()) fail(`${label}: agents_md is empty`)
  if (value.includes(AGENTS_MD_START) || value.includes(AGENTS_MD_END)) {
    fail(`${label}: agents_md contains reserved marker`)
  }
}

function checkSteps(skillName: string, steps: unknown) {
  if (!Array.isArray(steps)) fail(`${skillName}: missing steps`)
  for (const step of steps) {
    if (!step || typeof step !== "object") fail(`${skillName}: invalid step`)
    const t = step as Record<string, unknown>
    if (typeof t.type !== "string" || !knownStepTypes.has(t.type)) fail(`${skillName}: unsupported step type`)
    if (t.type === "replace" || t.type === "assert-absent") {
      if (typeof t.file !== "string" || !t.file) fail(`${skillName}: file step missing file`)
      if (path.isAbsolute(t.file)) fail(`${skillName}: invalid file path: ${t.file}`)
    }
    if (t.type === "replace") {
      if (typeof t.from !== "string" || !t.from) fail(`${skillName}: replace step missing from`)
      if (typeof t.to !== "string") fail(`${skillName}: replace step missing to`)
      if (t.expected !== undefined && (typeof t.expected !== "number" || !Number.isSafeInteger(t.expected) || t.expected <= 0)) {
        fail(`${skillName}: replace step has invalid expected count`)
      }
    }
    if (t.type === "assert-absent") {
      if (typeof t.pattern !== "string" || !t.pattern) fail(`${skillName}: assert-absent step missing pattern`)
      try {
        new RegExp(t.pattern)
      } catch {
        fail(`${skillName}: invalid regex pattern`)
      }
    }
    if (t.type === "shell") {
      if (typeof t.commands !== "string" || !t.commands.trim()) fail(`${skillName}: shell step missing commands`)
    }
  }
}

function checkSkillName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !name) fail(`skill missing name`)
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || path.isAbsolute(name)) {
    fail(`invalid skill name: ${name}`)
  }
}

const knownStepTypes = new Set(["download", "git-export", "uv-pip", "replace", "assert-absent", "shell"])

export async function runShellStep(name: string, commands: string, dir: string) {
  if (typeof commands !== "string" || !commands.trim()) fail(`${name}: shell step missing commands`)
  // Shell steps manage their own outputs (e.g. graphify installs its skill dir
  // and plugin directly into OPENCODE_CONFIG_DIR). Run with the staging dir as
  // cwd and expose both the staging dir and the config dir, so commands can
  // stage files normally or place final artifacts directly.
  const proc = Bun.spawn(["bash", "-c", commands], {
    cwd: dir,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: cfg,
      SKILL_NAME: name,
      SKILL_STAGING_DIR: dir,
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) fail(`${name}: shell step failed (${code})`)
}

export async function applyFileStep(
  name: string,
  step: Extract<Step, { type: "replace" | "assert-absent" }>,
  dir: string,
) {
  const rel = step.file
  if (typeof rel !== "string" || !rel) fail(`${name}: file step missing file`)
  if (path.isAbsolute(rel)) fail(`${name}: invalid file path: ${rel}`)
  const file = safe(dir, rel)

  let realDir: string
  try {
    realDir = await realpath(dir)
  } catch {
    fail(`${name}: staging directory missing for ${rel}`)
  }
  let realFile: string
  try {
    realFile = await realpath(file)
  } catch {
    fail(`${name}: file not found: ${rel}`)
  }
  if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
    fail(`${name}: file escapes staging directory: ${rel}`)
  }
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    fail(`${name}: file not found: ${rel}`)
  }
  if (!st.isFile()) fail(`${name}: not a regular file: ${rel}`)

  const text = await readFile(file, "utf8")
  if (step.type === "replace") {
    const parts = text.split(step.from)
    const actual = parts.length - 1
    if (step.expected === undefined) {
      // No pinned count: replace all, but a zero-match step is a stale patch — fail loudly.
      if (actual === 0) fail(`${name}: ${rel}: expected at least 1 occurrence(s), found 0`)
    } else if (actual !== step.expected) {
      fail(`${name}: ${rel}: expected ${step.expected} occurrence(s), found ${actual}`)
    }
    await Bun.write(file, parts.join(step.to))
    return
  }

  let re: RegExp
  try {
    re = new RegExp(step.pattern)
  } catch {
    fail(`${name}: ${rel}: invalid regex pattern`)
  }
  if (re.test(text)) fail(`${name}: ${rel}: forbidden pattern present`)
}

export async function updateAgentsMd(file: string, additions: string) {
  if (typeof additions !== "string" || !additions.trim()) fail(`agents_md is empty`)
  if (additions.includes(AGENTS_MD_START) || additions.includes(AGENTS_MD_END)) {
    fail(`agents_md contains reserved marker`)
  }

  let lst: Awaited<ReturnType<typeof lstat>>
  try {
    lst = await lstat(file)
  } catch {
    fail(`AGENTS.md not found or unreadable: ${file}`)
  }
  if (lst.isSymbolicLink()) fail(`AGENTS.md is a symlink: ${file}`)
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    fail(`AGENTS.md not found or unreadable: ${file}`)
  }
  if (!st.isFile()) fail(`AGENTS.md is not a regular file: ${file}`)
  let original: string
  try {
    original = await readFile(file, "utf8")
  } catch {
    fail(`AGENTS.md not found or unreadable: ${file}`)
  }

  const block = `${AGENTS_MD_START}\n${additions.trimEnd()}\n${AGENTS_MD_END}`
  const firstStart = original.indexOf(AGENTS_MD_START)
  const lastStart = original.lastIndexOf(AGENTS_MD_START)
  const firstEnd = original.indexOf(AGENTS_MD_END)
  const lastEnd = original.lastIndexOf(AGENTS_MD_END)

  let next: string
  if (firstStart === -1 && firstEnd === -1) {
    if (original === "") {
      next = `${block}\n`
    } else if (original.endsWith("\n\n")) {
      next = `${original}${block}\n`
    } else if (original.endsWith("\n")) {
      next = `${original}\n${block}\n`
    } else {
      next = `${original}\n\n${block}\n`
    }
  } else if (
    firstStart !== -1 &&
    firstEnd !== -1 &&
    firstStart < firstEnd &&
    firstStart === lastStart &&
    firstEnd === lastEnd
  ) {
    next = original.slice(0, firstStart) + block + original.slice(firstEnd + AGENTS_MD_END.length)
  } else {
    fail(`AGENTS.md has malformed managed block`)
  }

  if (next === original) return

  const dir = path.dirname(file)
  const tmpDir = await mkdtemp(path.join(dir, ".agents-md-"))
  const tmpFile = path.join(tmpDir, "AGENTS.md")
  try {
    await Bun.write(tmpFile, next)
    await chmod(tmpFile, st.mode & 0o777)
    await rename(tmpFile, file)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
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

    if (steps.some((s) => s.type === "shell")) {
      // A shell step may place final artifacts directly (e.g. graphify's skill
      // dir and plugin). Merging preserves those instead of wiping them with
      // an atomic replace of the empty staging dir.
      await ensure(destDir)
      for (const entry of await readdir(stageDir)) {
        if (entry === ".git") continue
        await cp(path.join(stageDir, entry), path.join(destDir, entry), { recursive: true, force: true, verbatimSymlinks: true })
      }
    } else {
      await rm(destDir, { recursive: true, force: true })
      await ensure(path.dirname(destDir))
      await rename(stageDir, destDir)
    }
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

  if (step.type === "replace" || step.type === "assert-absent") {
    await applyFileStep(name, step, dir)
    return
  }

  if (step.type === "shell") {
    await runShellStep(name, (step as Extract<Step, { type: "shell" }>).commands, dir)
    return
  }

  fail(`${name}: unsupported step type`)
}

export function flattenSkills(entries: ManifestEntry[]): Skill[] {
  const flat: Skill[] = []
  for (const entry of entries) {
    if (isGroup(entry)) flat.push(...entry.skills)
    else flat.push(entry)
  }
  return flat
}

export function collectAgentsMd(manifest: Manifest): string[] {
  const out: string[] = []
  if (manifest.agents_md !== undefined) out.push(manifest.agents_md.trim())
  for (const entry of manifest.skills) {
    if (isGroup(entry)) {
      if (entry.agents_md !== undefined) out.push(entry.agents_md.trim())
      for (const skill of entry.skills) {
        if (skill.agents_md !== undefined) out.push(skill.agents_md.trim())
      }
    } else if (entry.agents_md !== undefined) {
      out.push(entry.agents_md.trim())
    }
  }
  return out
}

export function parse(input: string): Manifest {
  const parsed = YAML.parse(input) as Partial<Manifest> | null
  if (!parsed || !Array.isArray(parsed.skills)) fail(`invalid manifest at ${manifestPath}`)

  const entries = parsed.skills as unknown[]
  const seenSkills = new Set<string>()
  const seenGroups = new Set<string>()

  function validateSkill(s: unknown): asserts s is Skill {
    if (!s || typeof s !== "object") fail(`skill missing name`)
    const obj = s as { name?: unknown; steps?: unknown; agents_md?: unknown; group?: unknown; skills?: unknown }
    if ("group" in obj || "skills" in obj) fail(`skill entry must not contain group/skills`)
    checkSkillName(obj.name)
    const name = obj.name as string
    if (seenSkills.has(name)) fail(`duplicate skill name: ${name}`)
    seenSkills.add(name)
    checkAgentsMd(obj.agents_md, name)
    checkSteps(name, obj.steps)
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") fail(`skill missing name`)
    const obj = entry as Record<string, unknown>
    if ("group" in obj) {
      if (typeof obj.group !== "string" || !obj.group.trim()) fail(`group missing name`)
      if ("name" in obj || "steps" in obj) fail(`group ${String(obj.group)}: must not contain name/steps`)
      const groupName = (obj.group as string).trim()
      if (seenGroups.has(groupName)) fail(`duplicate group name: ${groupName}`)
      seenGroups.add(groupName)
      checkAgentsMd(obj.agents_md, `group ${groupName}`)
      if (!Array.isArray(obj.skills) || obj.skills.length === 0) fail(`group ${groupName}: missing skills`)
      for (const inner of obj.skills as unknown[]) {
        if (!inner || typeof inner !== "object") fail(`group ${groupName}: skill missing name`)
        if ("group" in (inner as Record<string, unknown>)) fail(`group ${groupName}: nested groups are not supported`)
        validateSkill(inner)
      }
      continue
    }
    validateSkill(entry)
  }

  const agents_md = (parsed as { agents_md?: unknown }).agents_md
  if (agents_md !== undefined) {
    if (typeof agents_md !== "string" || !agents_md.trim()) fail(`agents_md is empty`)
    if (agents_md.includes(AGENTS_MD_START) || agents_md.includes(AGENTS_MD_END)) {
      fail(`agents_md contains reserved marker`)
    }
    return { skills: entries as ManifestEntry[], agents_md }
  }
  return { skills: entries as ManifestEntry[] }
}

async function main() {
  const manifest = parse(await Bun.file(manifestPath).text())
  await ensure(root)

  try {
    for (const skill of flattenSkills(manifest.skills)) {
      if (!skill.name) fail(`skill missing name`)
      if (!Array.isArray(skill.steps)) fail(`${skill.name}: missing steps`)
      await runSkill(skill.name, skill.steps)
    }

    const additions = collectAgentsMd(manifest).join("\n\n")
    if (additions.trim()) {
      await updateAgentsMd(path.join(cfg, "AGENTS.md"), additions)
    }
  } finally {
    await cleanupWorkspaces()
  }
}

if (import.meta.main) {
  await main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(msg)
    process.exit(1)
  })
}
