#!/usr/bin/env node

// Idempotent production deployment for XYZ OS (fork of cloudflare-os).
//
// Deploys the whole stack to Cloudflare Workers:
//   gatekeepers (each packages/gatekeeper-*)  ->  workshop-backend  ->  router (public origin)
//
// What it does on every run (safe to re-run; nothing is destroyed):
//   1. Builds prerequisites (frontend bundle, format blueprints, gatekeeper UI bundles).
//   2. Ensures the KV namespaces and R2 bucket exist, creating them when missing.
//   3. Generates wrangler.prod.jsonc for the workers that need real binding IDs
//      (workshop-backend, gatekeeper-context, router).
//   4. Sets optional per-gatekeeper OAuth secrets (CLIENT_ID / CLIENT_SECRET).
//   5. Deploys gatekeepers -> workshop-backend -> router, and prints the public URL.
//
// Required environment:
//   CLOUDFLARE_API_TOKEN   API token with Workers Scripts:Edit, Workers KV:Edit, Workers R2:Edit
//                          (or run `wrangler login` once and omit the token)
//
// Optional environment:
//   CLOUDFLARE_ACCOUNT_ID  Account id; auto-detected when your token owns exactly one account.
//   ADMINS                Comma-separated usernames that get the /admin panel (default: "admin").
//   SHARING_DOMAIN        Context-library sharing domain (default: "xyz-os").
//   XYZ_R2_BUCKET         R2 bucket name for blueprint content (default: "xyz-os-blueprint-content").
//                          R2 bucket names are globally unique -- set this if the default is taken.
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET, GOOGLE_..., CLOUDFLARE_OAUTH_..., SUPABASE_...,
//   NOTION_..., ZOOMINFO_..., CONFLUENCE_..., SLACK_...
//                          Optional OAuth app credentials for each gatekeeper. Absent = the
//                          gatekeeper deploys but its connector stays unconfigured until creds
//                          are added (re-run with them set).
//
// Flags:
//   --dry-run    Generate configs and print the plan without touching Cloudflare.
//   --skip-build Skip the build steps (use after a clean local build).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = join(ROOT, "packages");

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_BUILD = process.argv.includes("--skip-build");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? ROOT;
  const label = `${cmd} ${args.join(" ")}` + (cwd !== ROOT ? ` (cwd: ${cwd})` : "");
  if (DRY_RUN && !opts.allowInDryRun) {
    console.log(`[dry-run] would run: ${label}`);
    return "";
  }
  console.log(`\n> ${label}`);
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
}

function runWrangler(args, opts = {}) {
  return run("pnpm", ["exec", "wrangler", ...args], { ...opts, allowInDryRun: true });
}

function parseJsonOutput(text, label) {
  const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) throw new Error(`Could not parse ${label} output: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// Discover gatekeeper packages (same convention as run-dev-server.js).
// ---------------------------------------------------------------------------

function findGatekeepers() {
  return readdirSync(PACKAGES)
      .filter(name => name.startsWith("gatekeeper-"))
      .filter(name => statSync(join(PACKAGES, name, "wrangler.jsonc")).isFile())
      .toSorted();
}

// "gatekeeper-github" -> "GATEKEEPER_GITHUB"
function bindingName(gk) {
  return gk.toUpperCase().replaceAll("-", "_");
}

// Same credential env mapping as run-dev-server.js. Gatekeepers not listed here
// (context, scheduler, email, mcp, mcp-portal) take no OAuth credentials and deploy as-is.
const GATEKEEPER_CRED_ENVS = {
  "gatekeeper-github": { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  "gatekeeper-google": { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  "gatekeeper-cloudflare": { id: "CLOUDFLARE_OAUTH_CLIENT_ID", secret: "CLOUDFLARE_OAUTH_CLIENT_SECRET" },
  "gatekeeper-supabase": { id: "SUPABASE_CLIENT_ID", secret: "SUPABASE_CLIENT_SECRET" },
  "gatekeeper-notion": { id: "NOTION_CLIENT_ID", secret: "NOTION_CLIENT_SECRET" },
  "gatekeeper-zoominfo": { id: "ZOOMINFO_CLIENT_ID", secret: "ZOOMINFO_CLIENT_SECRET" },
  "gatekeeper-confluence": { id: "CONFLUENCE_CLIENT_ID", secret: "CONFLUENCE_CLIENT_SECRET" },
  "gatekeeper-slack": { id: "SLACK_CLIENT_ID", secret: "SLACK_CLIENT_SECRET" },
};

const KV_BINDINGS = [
  { package: "workshop-backend", binding: "BLUEPRINTS", title: "xyz-os-blueprint-metadata" },
  { package: "workshop-backend", binding: "AVATARS", title: "xyz-os-avatars" },
  { package: "gatekeeper-context", binding: "CONTEXT_COLLECTIONS", title: "xyz-os-context-collections" },
];

const R2_BUCKET = process.env.XYZ_R2_BUCKET ?? "xyz-os-blueprint-content";

const ADMINS = (process.env.ADMINS ?? "admin").split(",").map(s => s.trim()).filter(Boolean);
const SHARING_DOMAIN = process.env.SHARING_DOMAIN ?? "xyz-os";

// ---------------------------------------------------------------------------
// 0. Account resolution (skipped in dry-run).
// ---------------------------------------------------------------------------

function resolveAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const whoami = runWrangler(["whoami", "--format", "json"]);
  const info = parseJsonOutput(whoami, "wrangler whoami");
  const accounts = info.account ?? [];
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    throw new Error("No Cloudflare account found. Run `wrangler login` or set CLOUDFLARE_API_TOKEN.");
  }
  throw new Error(
      `Token owns ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID to one of: ` +
      accounts.map(a => `${a.id} (${a.name})`).join(", "));
}

// ---------------------------------------------------------------------------
// 1. Build prerequisites.
// ---------------------------------------------------------------------------

function buildPrerequisites() {
  if (SKIP_BUILD) {
    console.log("--skip-build: skipping build steps.");
    return;
  }
  run("pnpm", ["--filter", "@gadgets/typed-storage", "build"]);
  run("pnpm", ["--filter", "@gadgets/workshop-frontend", "exec", "vite", "build"]);
  run(process.execPath, [join(ROOT, "packages", "workshop-backend", "scripts", "build-format-blueprints.mjs")]);
  for (const gk of findGatekeepers()) {
    const dir = join(PACKAGES, gk);
    if (existsSync(join(dir, "src", "configurator"))) {
      run(process.execPath, [join(ROOT, "scripts", "build-gatekeeper-configurator.mjs"), dir, "--quiet"]);
    }
    if (existsSync(join(dir, "build-app.mjs"))) {
      run(process.execPath, [join(dir, "build-app.mjs")]);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Ensure KV namespaces + R2 bucket exist.
// ---------------------------------------------------------------------------

function ensureKvNamespace(title, accountId) {
  const list = runWrangler(["kv", "namespace", "list", "--format", "json"]);
  const namespaces = parseJsonOutput(list, "kv namespace list");
  const existing = namespaces.find(ns => ns.title === title);
  if (existing) return existing.id;
  const created = runWrangler(["kv", "namespace", "create", title, "--format", "json"]);
  const result = parseJsonOutput(created, "kv namespace create");
  const id = result.result?.id ?? result.id;
  if (!id) throw new Error(`Could not read created KV namespace id for "${title}".`);
  console.log(`created KV namespace "${title}" -> ${id}`);
  return id;
}

function ensureR2Bucket(accountId) {
  const list = runWrangler(["r2", "bucket", "list", "--format", "json"]);
  const buckets = parseJsonOutput(list, "r2 bucket list");
  const existing = buckets.find(b => b.name === R2_BUCKET);
  if (existing) return R2_BUCKET;
  runWrangler(["r2", "bucket", "create", R2_BUCKET]);
  console.log(`created R2 bucket "${R2_BUCKET}"`);
  return R2_BUCKET;
}

// ---------------------------------------------------------------------------
// 3. Generate production wrangler configs.
// ---------------------------------------------------------------------------

function readConfig(pkg) {
  return parse(readFileSync(join(PACKAGES, pkg, "wrangler.jsonc"), "utf8"), undefined, {
    allowTrailingComma: true,
  });
}

function writeProdConfig(pkg, config) {
  const outPath = join(PACKAGES, pkg, "wrangler.prod.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
  return outPath;
}

function generateConfigs(kvIds, bucketName) {
  const gatekeepers = findGatekeepers();

  // workshop-backend: gatekeeper service bindings + real KV/R2 IDs + browser + ADMINS.
  {
    const config = readConfig("workshop-backend");
    config.services = [];
    for (const gk of gatekeepers) {
      const binding = { binding: bindingName(gk), service: gk.name, entrypoint: "GatekeeperVendor" };
      if (gk === "gatekeeper-context") binding.props = { sharingDomain: SHARING_DOMAIN };
      config.services.push(binding);
    }
    config.kv_namespaces = KV_BINDINGS
        .filter(k => k.package === "workshop-backend")
        .map(k => ({ binding: k.binding, id: kvIds[k.title] }));
    config.r2_buckets = [{ binding: "BLUEPRINT_CONTENT", bucket_name: bucketName }];
    config.browser = { binding: "BROWSER", remote: true };
    config.vars = config.vars ?? {};
    config.vars.ADMINS = ADMINS;
    writeProdConfig("workshop-backend", config);
  }

  // gatekeeper-context: real KV id for CONTEXT_COLLECTIONS.
  {
    const config = readConfig("gatekeeper-context");
    config.kv_namespaces = [{
      binding: "CONTEXT_COLLECTIONS",
      id: kvIds["xyz-os-context-collections"],
    }];
    writeProdConfig("gatekeeper-context", config);
  }

  // router: public origin with gatekeeper service bindings + frontend assets.
  {
    const config = readConfig("router");
    config.services = config.services ?? [];
    for (const gk of gatekeepers) {
      config.services.push({ binding: bindingName(gk), service: gk.name });
    }
    writeProdConfig("router", config);
  }
}

// ---------------------------------------------------------------------------
// 4. Optional per-gatekeeper OAuth secrets.
// ---------------------------------------------------------------------------

function setGatekeeperSecrets(gk) {
  const creds = GATEKEEPER_CRED_ENVS[gk];
  if (!creds) return;
  const idValue = process.env[creds.id];
  const secretValue = process.env[creds.secret];
  if (!idValue && !secretValue) return;
  if (!idValue || !secretValue) {
    console.warn(`[warn] ${gk}: provide both ${creds.id} and ${creds.secret} (or neither); skipping.`);
    return;
  }
  console.log(`setting OAuth secrets for ${gk}...`);
  runWrangler(["secret", "put", "CLIENT_ID", "--name", gk], { input: idValue + "\n" });
  runWrangler(["secret", "put", "CLIENT_SECRET", "--name", gk], { input: secretValue + "\n" });
}

// ---------------------------------------------------------------------------
// 5. Deploy.
// ---------------------------------------------------------------------------

function deploy() {
  const gatekeepers = findGatekeepers();

  for (const gk of gatekeepers) {
    setGatekeeperSecrets(gk);
    const configFile = gk === "gatekeeper-context" ? "wrangler.prod.jsonc" : "wrangler.jsonc";
    runWrangler(["deploy", "-c", configFile], { cwd: join(PACKAGES, gk) });
  }

  runWrangler(["deploy", "-c", "wrangler.prod.jsonc"], { cwd: join(PACKAGES, "workshop-backend") });
  const routerOutput = runWrangler(["deploy", "-c", "wrangler.prod.jsonc"], { cwd: join(PACKAGES, "router") });
  return routerOutput;
}

function extractPublicUrl(routerOutput) {
  const match = routerOutput.match(/https:\/\/[a-z0-9-]+\.workers\.dev/);
  if (match) return match[0];
  // Fallback: query the account's workers.dev subdomain via the API.
  try {
    const accountId = resolveAccountId();
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (accountId && token) {
      const res = execFileSync("curl", [
        "-s", `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
        "-H", `Authorization: Bearer ${token}`,
      ], { encoding: "utf8" });
      const subdomain = JSON.parse(res).result?.subdomain;
      if (subdomain) return `https://router.${subdomain}.workers.dev`;
    }
  } catch { /* fall through */ }
  return "https://router.<your-subdomain>.workers.dev";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("=== XYZ OS deploy ===\n");
if (DRY_RUN) console.log("DRY RUN: nothing will be created or changed.\n");

buildPrerequisites();

let accountId;
let kvIds = {};
let bucketName = R2_BUCKET;

if (DRY_RUN) {
  console.log("\n[dry-run] account: CLOUDFLARE_ACCOUNT_ID / wrangler login (not resolved in dry-run)");
  console.log(`[dry-run] ADMINS=${ADMINS.join(",")}  SHARING_DOMAIN=${SHARING_DOMAIN}`);
  console.log(`[dry-run] KV namespaces: ${KV_BINDINGS.map(k => k.title).join(", ")}`);
  console.log(`[dry-run] R2 bucket: ${bucketName}`);
} else {
  accountId = resolveAccountId();
  console.log(`\nAccount: ${accountId}`);

  for (const k of KV_BINDINGS) {
    kvIds[k.title] = ensureKvNamespace(k.title, accountId);
  }
  bucketName = ensureR2Bucket(accountId);
  console.log(`KV/R2 ready: ${Object.keys(kvIds).join(", ")} + ${bucketName}`);
}

generateConfigs(kvIds, bucketName);

if (DRY_RUN) {
  console.log("\n[dry-run] done. Re-run without --dry-run to deploy.");
  process.exit(0);
}

const routerOutput = deploy();

const url = extractPublicUrl(routerOutput);
console.log("\n=== Deploy complete ===");
console.log(`Public URL: ${url}`);
console.log(`\nNext steps:`);
console.log(`  1. Open ${url} and create your account (username must be one of ADMINS: ${ADMINS.join(", ")}).`);
console.log(`  2. Add AI providers under "AI providers" (DeepSeek, NVIDIA NIM, OpenRouter, ...).`);
console.log(`  3. Configure gatekeeper OAuth apps per packages/gatekeeper-*/README.md, then re-run`);
console.log(`     this script with the CLIENT_ID/CLIENT_SECRET env vars set.`);
