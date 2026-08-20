# Uploading to the Chrome Web Store from CI

One-time setup, then `gh workflow run store.yml` uploads a released build to the
store. Everything here is done once; after that the release flow is
`gh workflow run release.yml` → merge the release pull request → `gh workflow run
store.yml`.

The API this uses is the Chrome Web Store Publish API **v2**. Version 1 stops
working on **15 October 2026**, so anything written against
`www.googleapis.com/chromewebstore/v1.1` is already a dead end.

## Why a service account rather than a refresh token

The older recipe is an OAuth client plus a refresh token obtained through the
OAuth Playground. It works, but the token is a long-lived credential tied to a
human account, it is awkward to rotate, and it can be invalidated by things that
have nothing to do with this project — a password change, a revoked grant, six
months of disuse.

A service account is an identity of its own. The key signs a short-lived
assertion, `scripts/store.mjs` exchanges it for an access token good for an hour,
and there is nothing that quietly expires between releases.

## Setup

### 1. A Google Cloud project with the API enabled

In the [Google Cloud console](https://console.cloud.google.com), create a project
(or reuse one), then find **Chrome Web Store API** in the API library and enable
it.

### 2. A service account

Under **IAM & Admin → Service accounts**, create one. Name it something like
`platica-notes-release`. It needs **no roles or permissions** — its access comes
from the store, not from Cloud IAM.

Open it, go to **Keys → Add key → Create new key → JSON**, and download the file.
That file is a credential: it is the one thing here worth treating like a
password.

### 3. Let the store trust it

In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
open **Account** and add the service account's email address
(`something@your-project.iam.gserviceaccount.com`).

Two constraints worth knowing: a publisher can have **only one** service account,
and the Google account that owns the listing must have 2-step verification on.

While you are on that page, note the **publisher ID** — the API addresses items
as `publishers/<publisher id>/items/<extension id>`.

### 4. Two repository secrets

Run these locally; each prompts for the value, so it never travels through a chat
window or a shell history entry:

```bash
gh secret set CWS_SERVICE_ACCOUNT_KEY --repo coder0techs/platica-notes < /path/to/key.json
```

```bash
gh secret set CWS_PUBLISHER_ID --repo coder0techs/platica-notes
```

Then delete the downloaded key file. GitHub cannot show a secret's value back to
you, so if you lose it, create a new key and set the secret again.

The extension id is not a secret — it is the address in the store's own URL — so
it lives in `scripts/store.mjs` as a default, overridable with `CWS_EXTENSION_ID`.

## Using it

```bash
gh workflow run store.yml                                    # latest release, left as a draft
gh workflow run store.yml -f tag=v1.15.0                     # a specific release
gh workflow run store.yml -f action=submit-for-review        # upload and submit
gh workflow run store.yml -f action=staged-rollout -f percentage=10
```

The default is **draft**: the build is uploaded and nothing is live. That is
deliberate. A submitted build reaches every existing user once Google approves
it, and the review queue is not a place to discover that the wrong artifact went
up. `staged-rollout` is the middle ground — a percentage of users first.

The workflow uploads the zip attached to the GitHub release, not a fresh build,
so what reaches the store is exactly the artifact that CI produced and that you
can download and inspect. It checks the manifest version inside the zip against
the tag before uploading anything.

## Trying it without touching the listing

`status-only` is read-only and is the right first call after setting the secrets
up. It asks the store for the item's state and stops — nothing is fetched,
uploaded or submitted:

```bash
gh workflow run store.yml -f action=status-only
```

If it fails, the usual causes are the API not enabled on the Cloud project, or
the service account's email not added under **Account** in the dashboard.

The same call runs locally, if the key is on the machine:

```bash
CWS_PUBLISHER_ID=... CWS_SERVICE_ACCOUNT_KEY="$(cat key.json)" node scripts/store.mjs status
```

## What is still manual

The listing itself: description, screenshots, category, the privacy-policy URL.
The API publishes packages, not store copy. That copy lives in
`docs/STORE-LISTING.md`, and the privacy policy is served from GitHub Pages
(see the release checklist in `CLAUDE.md`).
