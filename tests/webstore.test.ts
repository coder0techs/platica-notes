import { createVerify, generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { signedAssertion } from "../scripts/store.mjs"

// A throwaway key pair, generated per run. Nothing here touches the network or a
// real service account; the point is that the assertion the store API is handed
// is well formed and actually verifies.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const KEY = { client_email: "releases@example-project.iam.gserviceaccount.com", private_key: privateKey }
const NOW = 1_800_000_000

// base64url by hand rather than via Buffer: tsconfig sets types to ["chrome"]
// only, so node's globals are deliberately not in scope for this project's code.
const fromBase64Url = (segment: string) => {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/")
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
}
const toBase64Url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const decode = (segment: string) => JSON.parse(fromBase64Url(segment))

describe("signedAssertion", () => {
  const jwt = signedAssertion(KEY, NOW)
  const [header, claims, signature] = jwt.split(".")

  it("is a three-part JWT", () => {
    expect(jwt.split(".")).toHaveLength(3)
    expect(signature.length).toBeGreaterThan(0)
  })

  it("declares RS256, which is what Google's token endpoint expects", () => {
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" })
  })

  it("asks for the Chrome Web Store scope and nothing else", () => {
    expect(decode(claims).scope).toBe("https://www.googleapis.com/auth/chromewebstore")
  })

  it("is addressed to Google's token endpoint and issued by the service account", () => {
    const payload = decode(claims)
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token")
    expect(payload.iss).toBe(KEY.client_email)
  })

  it("expires an hour out, which is the maximum Google accepts", () => {
    const payload = decode(claims)
    expect(payload.iat).toBe(NOW)
    expect(payload.exp).toBe(NOW + 3600)
  })

  it("carries a signature that verifies against the key", () => {
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${header}.${claims}`)
    expect(verifier.verify(publicKey, signature, "base64url")).toBe(true)
  })

  it("does not verify once a claim is tampered with", () => {
    const forged = toBase64Url(
      JSON.stringify({ ...decode(claims), scope: "https://www.googleapis.com/auth/cloud-platform" }),
    )
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${header}.${forged}`)
    expect(verifier.verify(publicKey, signature, "base64url")).toBe(false)
  })

  it("uses base64url, so the token survives an HTTP form body unescaped", () => {
    expect(jwt).not.toMatch(/[+/=]/)
  })
})
