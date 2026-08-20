// Talk to the Chrome Web Store Publish API (v2).
//
//   node scripts/store.mjs status [--json]
//   node scripts/store.mjs upload <zip>
//   node scripts/store.mjs publish [--percentage N]
//
// Authentication is a Google Cloud service account: the JSON key goes in the
// CWS_SERVICE_ACCOUNT_KEY environment variable, and the key is exchanged for a
// short-lived access token with the standard JWT bearer flow. No refresh token,
// no OAuth consent screen, nothing that silently expires. See
// docs/STORE-AUTOMATION.md for the one-time setup.
//
// A note for anyone reading this against the zero-egress invariant: that
// invariant is about the extension, which must never make a request of its own.
// This file is build tooling. It never ships, is not in src/, and is not part of
// any bundle — `npm run check` scans src/ and public/ for exactly that reason.
//
// Deliberately dependency-free: node's own crypto signs the JWT and its own
// fetch makes the calls, so the repository still ships and builds with nothing
// but esbuild and the test runner.

import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { argv } from "node:process"
import { fileURLToPath } from "node:url"

// Public: it is the extension's address in the store, visible in its listing URL.
const EXTENSION_ID = process.env.CWS_EXTENSION_ID || "lfnfhogdkefkfjnlhhcacebleobpgecl"
const API = "https://chromewebstore.googleapis.com"
const SCOPE = "https://www.googleapis.com/auth/chromewebstore"

const die = (message) => {
  console.error(message)
  process.exit(1)
}

const b64url = (input) => Buffer.from(input).toString("base64url")

/** Build and sign the assertion a service account exchanges for an access token. */
export function signedAssertion(key, now) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${claims}`)
  return `${header}.${claims}.${signer.sign(key.private_key, "base64url")}`
}

/**
 * One-line-per-revision summary of a fetchStatus response.
 *
 * Printing the raw JSON looks fine locally and is unreadable in Actions: GitHub
 * masks each line of a multi-line secret separately, and a service account key
 * contains lines that are just `{` and `}`, so every brace in the log turns into
 * ***. Nothing leaks; it is simply illegible exactly when something has gone
 * wrong. Revision keys are matched by suffix rather than listed, so a field the
 * API adds later still shows up.
 *
 * @param {Record<string, any>} status
 * @returns {string}
 */
export function summariseStatus(status) {
  const lines = [`item: ${status.itemId ?? "unknown"}`]
  for (const [key, value] of Object.entries(status)) {
    if (!key.endsWith("RevisionStatus") || !value || typeof value !== "object") continue
    const channels = (value.distributionChannels ?? [])
      .map((c) => `${c.crxVersion ?? "?"} to ${c.deployPercentage ?? "?"}% of users`)
      .join("; ")
    const label = key.replace(/RevisionStatus$/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()
    lines.push(`${label}: ${value.state ?? "unknown"}${channels ? ` — ${channels}` : ""}`)
  }
  if (lines.length === 1) lines.push("no revision information returned")
  return lines.join("\n")
}

const serviceAccountKey = () => {
  const raw = process.env.CWS_SERVICE_ACCOUNT_KEY
  if (!raw) die("CWS_SERVICE_ACCOUNT_KEY is not set (the service account's JSON key).")
  let key
  try {
    key = JSON.parse(raw)
  } catch {
    die("CWS_SERVICE_ACCOUNT_KEY is not valid JSON — paste the whole key file, not a fragment.")
  }
  for (const field of ["client_email", "private_key"]) {
    if (!key[field]) die(`CWS_SERVICE_ACCOUNT_KEY has no ${field} — is this a service account key?`)
  }
  return key
}

const accessToken = async () => {
  const assertion = signedAssertion(serviceAccountKey(), Math.floor(Date.now() / 1000))
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  const body = await response.text()
  if (!response.ok) {
    die(
      `Could not get an access token (HTTP ${response.status}).\n${body}\n\n` +
        "Usual causes: the Chrome Web Store API is not enabled on the Cloud project, or the\n" +
        "service account's email has not been added under Account in the Developer Dashboard.",
    )
  }
  return JSON.parse(body).access_token
}

const publisherId = () => process.env.CWS_PUBLISHER_ID || die("CWS_PUBLISHER_ID is not set.")

const item = () => `publishers/${publisherId()}/items/${EXTENSION_ID}`

const call = async (url, options, what) => {
  const response = await fetch(url, options)
  const body = await response.text()
  if (!response.ok) die(`${what} failed (HTTP ${response.status}):\n${body}`)
  return body ? JSON.parse(body) : {}
}

// The tests import signedAssertion from here, so importing this module must not
// run a command.
const runningDirectly = argv[1] && fileURLToPath(import.meta.url) === argv[1]

const status = async (args = []) => {
  const token = await accessToken()
  const result = await call(
    `${API}/v2/${item()}:fetchStatus`,
    { headers: { authorization: `Bearer ${token}` } },
    "fetchStatus",
  )
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : summariseStatus(result))
}

const upload = async (zip) => {
  if (!zip) die("usage: node scripts/store.mjs upload <zip>")
  const bytes = readFileSync(zip)
  const token = await accessToken()
  console.log(`Uploading ${zip} (${(bytes.length / 1024).toFixed(1)} KB) to ${EXTENSION_ID}…`)
  const result = await call(
    `${API}/upload/v2/${item()}:upload`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" },
      body: bytes,
    },
    "upload",
  )
  console.log(`Uploaded: ${result.itemId ?? EXTENSION_ID}${result.state ? ` (${result.state})` : ""}`)
  console.log("It sits as a draft. Nothing is live until it is published and passes review.")
}

const publish = async (args) => {
  const index = args.indexOf("--percentage")
  const percentage = index === -1 ? null : Number(args[index + 1])
  if (percentage !== null && (!Number.isInteger(percentage) || percentage < 1 || percentage > 100)) {
    die("--percentage takes a whole number from 1 to 100.")
  }
  // DEFAULT_PUBLISH goes live by itself the moment review passes. STAGED_PUBLISH
  // still goes through review, but afterwards it waits for the developer to
  // release it, and deployPercentage decides how much of the user base it then
  // reaches. The percentage picks a random slice — there is no way to name who.
  const body =
    percentage === null
      ? { publishType: "DEFAULT_PUBLISH" }
      : { publishType: "STAGED_PUBLISH", deployInfos: [{ deployPercentage: percentage }] }

  const token = await accessToken()
  console.log(`Submitting ${EXTENSION_ID} for review (${JSON.stringify(body)})…`)
  const result = await call(
    `${API}/v2/${item()}:publish`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    "publish",
  )
  console.log(`Submitted: ${result.itemId ?? EXTENSION_ID}${result.state ? ` (${result.state})` : ""}`)
  if (result.warningInfo?.warnings?.length) {
    for (const w of result.warningInfo.warnings) console.log(`  warning: ${w.reason} — ${w.description}`)
    console.log("\nThe store returned warnings; read them before assuming this went out cleanly.")
  }
}

if (runningDirectly) {
  const [command, ...rest] = argv.slice(2)
  if (command === "status") await status(rest)
  else if (command === "upload") await upload(rest[0])
  else if (command === "publish") await publish(rest)
  else die("usage: node scripts/store.mjs status [--json] | upload <zip> | publish [--percentage N]")
}
