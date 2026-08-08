# Deploying XYZ OS

XYZ OS runs on [Cloudflare Workers](https://workers.cloudflare.com). This fork deploys with a
single idempotent script (`scripts/deploy.mjs`), either by hand or automatically from GitHub
Actions on every push to `main`.

## Architecture of a deployment

| Worker | Role |
|---|---|
| `router` | Public origin. Serves the frontend; routes `/api/*` to the backend and `/gatekeeper/*` to gatekeepers |
| `workshop-backend` | The kernel: users, workspaces (Durable Objects), agent loop, model routing |
| `gatekeeper-*` (17) | Capability-based security layer for external services (GitHub, Google, Notion, ...) |
| KV + R2 | `xyz-os-blueprint-metadata`, `xyz-os-avatars`, `xyz-os-context-collections` (KV), `xyz-os-blueprint-content` (R2) |

Deploy order matters: gatekeepers first (so service bindings resolve), then the backend, then the
router. `scripts/deploy.mjs` handles all of it and is safe to re-run.

## Option A: Deploy automatically from GitHub (recommended)

### One-time setup (you)

1. **Create a Cloudflare API token**: [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → *Create Token* → use the **"Edit Cloudflare Workers"** preset (it includes Workers Scripts,
   KV, and R2 permissions). Copy the token.
2. **Add it to your repo**: GitHub → `temidayoxyz/xyzos` → *Settings → Secrets and variables →
   Actions*:
   - **Secret** `CLOUDFLARE_API_TOKEN` — the token from step 1
   - **Variable** `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id (dashboard sidebar URL)
   - **Variable** `ADMINS` — comma-separated usernames that get the `/admin` panel (your login
     username must be in here), e.g. `temidayoxyz`
   - *Optional* secrets `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (and the other
     `<NAME>_CLIENT_ID/SECRET` pairs) for the gatekeepers you configure (see below)

### From then on

Every push to `main` (including upstream merges) runs `.github/workflows/deploy.yml`:
`pnpm install` → lint + type-check → tests → `scripts/deploy.mjs`. The live instance updates
automatically. You can also trigger it manually with the **Run workflow** button on the Actions
tab (handy after changing `ADMINS`).

Your instance lives at `https://router.<subdomain>.workers.dev` (or a custom domain).

## Option B: Deploy from your machine

Requires `wrangler login` (one-time, opens a browser) or `CLOUDFLARE_API_TOKEN` in the
environment:

```bash
pnpm install
CLOUDFLARE_ACCOUNT_ID=<id> ADMINS=you node scripts/deploy.mjs
```

To see everything it would do without touching Cloudflare:

```bash
node scripts/deploy.mjs --dry-run
```

## Gatekeeper OAuth credentials

Gatekeepers like GitHub/Google/Notion need OAuth app credentials to connect to their services.
Without them the gatekeeper worker still deploys, but its connector stays unconfigured. Create
the OAuth app per the instructions in each `packages/gatekeeper-*/README.md`, then either:

- add the `<NAME>_CLIENT_ID` / `<NAME>_CLIENT_SECRET` secrets to GitHub Actions (deploys pick
  them up on the next push), or
- re-run the deploy script locally with those env vars set:
  `GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... node scripts/deploy.mjs`

No-credential gatekeepers (Context Library, Scheduler, Email, MCP) work out of the box.

## Notes

- **Data is per-deployment.** Accounts, workspaces, and gadgets live in each instance's Durable
  Objects; deploying code never moves data.
- **`ADMINS` changes** only take effect after a deploy (push or *Run workflow*).
- **R2 bucket names are globally unique** — if `xyz-os-blueprint-content` is taken, set the
  `XYZ_R2_BUCKET` variable in GitHub Actions (or env) to another name.
- **Updating**: pull upstream (`git fetch upstream && git merge upstream/main`), resolve
  conflicts, push — the deploy is automatic.
