#!/usr/bin/env bun
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Gemini = {
  access_token?: string
  refresh_token?: string
  expiry_date?: number | string
}

type OAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
}

type Auth = Record<string, OAuth | Record<string, unknown>>

function fail(msg: string): never {
  console.error(`[convert-gemini.auth] ${msg}`)
  process.exit(1)
}

function home() {
  return process.env.HOME || os.homedir()
}

function data() {
  return process.env.XDG_DATA_HOME || path.join(home(), ".local", "share")
}

function src() {
  return process.env.GEMINI_OAUTH_CREDS_PATH || path.join(home(), ".gemini", "oauth_creds.json")
}

function dst() {
  return process.env.OPENCODE_AUTH_PATH || path.join(data(), "opencode", "auth.json")
}

function ms(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }

  if (typeof value === "string" && value.trim()) {
    const num = Number(value)
    if (Number.isFinite(num)) return num < 1e12 ? num * 1000 : num
    const date = Date.parse(value)
    if (!Number.isNaN(date)) return date
  }

  return Date.now() + 55 * 60 * 1000
}

async function json(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
}

async function existing(file: string): Promise<Auth> {
  try {
    return (await json(file)) as Auth
  } catch {
    return {}
  }
}

async function main() {
  const source = src()
  const target = dst()
  const creds = (await json(source)) as Gemini

  if (!creds.refresh_token) fail(`missing refresh_token in ${source}`)
  if (!creds.access_token) fail(`missing access_token in ${source}`)

  const auth = await existing(target)
  auth.google = {
    type: "oauth",
    refresh: creds.refresh_token,
    access: creds.access_token,
    expires: ms(creds.expiry_date),
  }

  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  await chmod(target, 0o600)
}

await main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
})
