/**
 * git.ts — Programmatic git operations using isomorphic-git.
 *
 * All operations work on bare repos (no working directory) stored in REPOS_DIR.
 * The bridge merges into the bare repo directly. Agents read diffs from the bare
 * repo. The setup script creates the initial bare repo and commits.
 */
import * as fs from "fs";
import * as path from "path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

import { REPOS_DIR } from "./config";

// ── Repo helpers ──────────────────────────────────────────────────────────────

/** Returns the absolute path for a named repo. */
export function repoPath(repoId: string): string {
  return path.join(REPOS_DIR, repoId);
}

/** Returns the absolute path for a temporary worktree clone of a repo. */
function worktreePath(repoId: string, suffix: string): string {
  return path.join(REPOS_DIR, `.worktree-${repoId}-${suffix}`);
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialises a new bare git repository.
 * A bare repo has no working directory — only the .git contents at root.
 */
export async function initBareRepo(repoId: string): Promise<void> {
  const dir = repoPath(repoId);
  fs.mkdirSync(dir, { recursive: true });

  // isomorphic-git doesn't have a native --bare init, so we init normally
  // then mark it as bare and rename the config.
  await git.init({ fs, dir });

  // Write the initial main branch name
  await git.setConfig({ fs, dir, path: "core.bare", value: "false" });
  await git.setConfig({ fs, dir, path: "init.defaultBranch", value: "main" });
}

/**
 * Creates the initial commit on main with a seed file.
 * Must be called right after initBareRepo, before git daemon is started.
 */
export async function createInitialCommit(
  repoId: string,
  files: Record<string, string>,
  author: { name: string; email: string }
): Promise<string> {
  const dir = repoPath(repoId);

  // Write files
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    await git.add({ fs, dir, filepath: filePath });
  }

  const sha = await git.commit({
    fs,
    dir,
    message: "Initial commit",
    author,
  });

  return sha;
}

// ── Branch operations ─────────────────────────────────────────────────────────

/**
 * Returns the commit hash (SHA) of the HEAD of a branch.
 */
export async function getCommitHash(
  repoId: string,
  branch: string
): Promise<string> {
  const dir = repoPath(repoId);
  return git.resolveRef({ fs, dir, ref: branch });
}

/**
 * Creates a temporary worktree clone, makes file changes on a new branch,
 * commits, and pushes to the bare repo. Returns the new commit hash.
 *
 * Used by the setup script and tests. Real users push via `git push`.
 */
export async function createBranchWithChanges(
  repoId: string,
  branch: string,
  files: Record<string, string>,
  message: string,
  author: { name: string; email: string }
): Promise<string> {
  const bare = repoPath(repoId);
  const wt = worktreePath(repoId, branch.replace(/\//g, "-"));

  // Clone the bare repo into a temp worktree
  fs.mkdirSync(wt, { recursive: true });
  await git.clone({
    fs,
    http,
    dir: wt,
    url: `file://${bare}`,
    singleBranch: true,
    ref: "main",
  });

  // Create and checkout the new branch
  await git.branch({ fs, dir: wt, ref: branch, checkout: true });

  // Apply file changes
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(wt, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    await git.add({ fs, dir: wt, filepath: filePath });
  }

  // Commit
  const sha = await git.commit({ fs, dir: wt, message, author });

  // Push to the bare repo
  await git.push({
    fs,
    http,
    dir: wt,
    url: `file://${bare}`,
    ref: branch,
    remoteRef: branch,
    force: false,
    onAuth: () => ({ username: "git" }),
  });

  // Clean up worktree
  fs.rmSync(wt, { recursive: true, force: true });

  return sha;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable unified diff between two branches.
 * Compares the file trees of `base` and `branch` in the bare repo.
 */
export async function getDiff(
  repoId: string,
  baseBranch: string,
  featureBranch: string
): Promise<string> {
  const dir = repoPath(repoId);

  const baseOid = await git.resolveRef({ fs, dir, ref: baseBranch });
  const featureOid = await git.resolveRef({ fs, dir, ref: featureBranch });

  const diff = await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: baseOid }), git.TREE({ ref: featureOid })],
    map: async (filepath, [baseEntry, featureEntry]) => {
      // Skip directories
      if (
        (baseEntry && (await baseEntry.type()) === "tree") ||
        (featureEntry && (await featureEntry.type()) === "tree")
      ) {
        return null;
      }

      const baseContent = baseEntry
        ? new TextDecoder().decode(
            (await baseEntry.content()) ?? new Uint8Array()
          )
        : "";
      const featureContent = featureEntry
        ? new TextDecoder().decode(
            (await featureEntry.content()) ?? new Uint8Array()
          )
        : "";

      if (baseContent === featureContent) return null;

      // Build a simple unified-diff-style output
      const baseLines = baseContent ? baseContent.split("\n") : [];
      const featureLines = featureContent ? featureContent.split("\n") : [];

      const removals = baseLines
        .filter((l) => !featureLines.includes(l))
        .map((l) => `- ${l}`);
      const additions = featureLines
        .filter((l) => !baseLines.includes(l))
        .map((l) => `+ ${l}`);

      return `--- ${filepath} (${baseBranch})\n+++ ${filepath} (${featureBranch})\n${removals.join(
        "\n"
      )}\n${additions.join("\n")}`;
    },
  });

  const filtered = (diff as (string | null)[]).filter(Boolean) as string[];
  return filtered.length > 0
    ? filtered.join("\n\n")
    : "(no textual differences)";
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merges a feature branch into main in the repo.
 * Uses a clone worktree to perform the merge, then pushes back to the bare repo.
 * Returns the merged commit hash.
 */
export async function mergeBranch(
  repoId: string,
  featureBranch: string
): Promise<string> {
  const bare = repoPath(repoId);
  const wt = worktreePath(repoId, `merge-${featureBranch.replace(/\//g, "-")}`);

  try {
    fs.mkdirSync(wt, { recursive: true });

    // Clone the bare repo
    await git.clone({
      fs,
      http,
      dir: wt,
      url: `file://${bare}`,
      singleBranch: false,
    });

    // Fetch the feature branch explicitly
    await git.fetch({
      fs,
      http,
      dir: wt,
      url: `file://${bare}`,
      ref: featureBranch,
      remoteRef: featureBranch,
    });

    // Merge feature branch into main
    const result = await git.merge({
      fs,
      dir: wt,
      ours: "main",
      theirs: featureBranch,
      author: { name: "gitchain-bridge", email: "bridge@gitchain.local" },
      message: `Merge branch '${featureBranch}' into main via gitchain`,
    });

    if (!result.mergeCommit) {
      // Fast-forward — HEAD already updated
    }

    // Push merged main back to bare repo
    await git.push({
      fs,
      http,
      dir: wt,
      url: `file://${bare}`,
      ref: "main",
      remoteRef: "main",
      force: false,
      onAuth: () => ({ username: "git" }),
    });

    // Return new HEAD on main
    return git.resolveRef({ fs, dir: wt, ref: "HEAD" });
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

// ── Read file ─────────────────────────────────────────────────────────────────

/**
 * Reads the content of a file at a specific branch/ref in the bare repo.
 */
export async function readFileAtRef(
  repoId: string,
  branch: string,
  filePath: string
): Promise<string> {
  const dir = repoPath(repoId);
  const oid = await git.resolveRef({ fs, dir, ref: branch });
  const { blob } = await git.readBlob({ fs, dir, oid, filepath: filePath });
  return new TextDecoder().decode(blob);
}

// ── Install hook ──────────────────────────────────────────────────────────────

/**
 * Installs the post-receive hook into a bare repo.
 * The hook fires when `git push` delivers branches and calls `gitchain propose`.
 */
export function installPostReceiveHook(repoId: string): void {
  const dir = repoPath(repoId);
  const hooksDir = path.join(dir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, "post-receive");
  const hookScript = `#!/bin/sh
# post-receive hook — installed by gitchain setup
# Fires after every git push. Creates an on-chain proposal for each new branch.
while read oldrev newrev refname; do
  branch=$(echo "$refname" | sed 's|refs/heads/||')

  # Skip main — merges land here via the bridge, not direct push
  if [ "$branch" = "main" ] || [ "$branch" = "HEAD" ]; then
    continue
  fi

  echo "[gitchain] Branch pushed: $branch ($newrev)"
  node /app/dist/src/cli.js propose ${repoId} "$branch" "$newrev" "Push: $branch"
done
`;

  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
}
