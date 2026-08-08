#!/usr/bin/env node

// Sync XYZ OS (this fork) with upstream cloudflare/cloudflare-os.
//
//   node scripts/sync-upstream.mjs
//
// Does: fetch upstream -> report divergence -> merge (aborts cleanly on conflicts) ->
// type-check + lint + tests -> commit -> push. Safe to run when there is nothing new
// ("already up to date").
//
// Env:
//   SKIP_CHECKS=1  skip the type-check/lint/test gate (use when you only want the merge)
//   NO_PUSH=1      commit but do not push
//
// Notes for humans/AI agents resolving conflicts: keep this fork's changes --
//   * packages/workshop-shared/src/api.ts            (AiModelProvider union + SUGGESTED_MODELS)
//   * packages/workshop-backend/src/ai-models.ts     (directCatalogModel, gateway cases)
//   * packages/workshop-frontend/src/AddModelModal.tsx (PROVIDER_LABELS / API_TOKEN_PLACEHOLDERS)
//   * packages/workshop-backend/src/chat-attachment-validation.ts
//   * package.json                                   (no packageManager pin -- see memory)
//   * README.md / gatekeeper user-facing strings     ("XYZ OS")
//   * scripts/deploy.mjs, .github/workflows/deploy.yml, docs/DEPLOYING.md

import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
// Normalize Windows drive paths ("/D:/..." -> "D:\...").
const CWD = process.platform === "win32" ? ROOT.slice(1).replaceAll("/", "\\") : ROOT;

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { cwd: CWD, encoding: "utf8", stdio: "inherit", ...opts });
}

function runQuiet(cmd, args) {
  return execFileSync(cmd, args, { cwd: CWD, encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------

console.log("=== XYZ OS upstream sync ===\n");

// 1. Ensure the upstream remote exists.
try {
  runQuiet("git", ["remote", "get-url", "upstream"]);
} catch {
  console.log("Adding upstream remote...");
  run("git", ["remote", "add", "upstream", "https://github.com/cloudflare/cloudflare-os.git"]);
}

// 2. Fetch and report divergence.
run("git", ["fetch", "upstream"]);
const behind = Number(runQuiet("git", ["rev-list", "--count", "HEAD..upstream/main"]));
const ahead = Number(runQuiet("git", ["rev-list", "--count", "upstream/main..HEAD"]));
console.log(`\nFork is ${behind} commit(s) behind upstream, ${ahead} ahead (local changes).`);

if (behind === 0) {
  console.log("\nAlready up to date. Nothing to do.");
  process.exit(0);
}

// 3. Merge, aborting cleanly on conflicts.
console.log(`\nMerging ${behind} upstream commit(s)...`);
try {
  run("git", ["merge", "upstream/main", "--no-edit"]);
} catch {
  console.error(`
Merge conflicts detected. Resolve them manually (see the notes at the top of this
script for which files keep fork changes), then:
    git add <resolved files>
    git commit
    node scripts/sync-upstream.mjs   (or push manually: git push origin main)
`);
  process.exit(1);
}

// 4. Checks (unless skipped).
if (process.env.SKIP_CHECKS === "1") {
  console.log("\nSKIP_CHECKS=1: skipping type-check/lint/tests.");
} else {
  console.log("\nRunning checks...");
  run("pnpm", ["--config.verify-deps-before-run=false", "types:check"]);
  run("pnpm", ["-w", "run", "lint:check"]);
  run("pnpm", ["--config.verify-deps-before-run=false", "test"]);
}

// 5. Commit (only the merge + any regenerated files).
run("git", ["add", "-A"]);
run("git", ["commit", "-m", "Merge upstream cloudflare-os"]);

// 6. Push (unless skipped).
if (process.env.NO_PUSH === "1") {
  console.log("\nNO_PUSH=1: committed locally, not pushed. Push with: git push origin main");
} else {
  console.log("\nPushing...");
  run("git", ["push", "origin", "main"]);
}

console.log("\n=== Sync complete ===");
console.log("Note: if you run the local server, restart it to pick up the new code.");
