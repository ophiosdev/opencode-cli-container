#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

type Step =
  | { type: "download"; url: string; dest: string }
  | { type: "git-export"; url: string }
  | { type: "uv-pip"; packages: string[] }

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
const gitExport = process.env.GIT_EXPORT_SCRIPT || path.join(base, "scripts", "git-export.py")

function fail(msg: string): never {
  throw new Error(`[install-skills] ${msg}`)
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

async function shell(args: string[]) {
  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) fail(`command failed (${code}): ${args.join(" ")}`)
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
    await shell(["python", gitExport, step.url, dir, "--force"])
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
  const parsed = YAML.parse(input) as Manifest
  if (!parsed || !Array.isArray(parsed.skills)) fail(`invalid manifest at ${manifestPath}`)
  return parsed
}

async function main() {
  const manifest = parse(await Bun.file(manifestPath).text())
  await ensure(root)

  for (const skill of manifest.skills) {
    if (!skill.name) fail(`skill missing name`)
    if (!Array.isArray(skill.steps)) fail(`${skill.name}: missing steps`)
    const dir = path.join(root, skill.name)
    for (const step of skill.steps) {
      await run(skill.name, step, dir)
    }
  }
}

await main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  process.exit(1)
})
