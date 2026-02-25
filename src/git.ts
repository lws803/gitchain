/**
 * git.ts — Git operations using shell git.
 *
 * Repos are bare (git init --bare). All ops use child_process for reliability.
 */
import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";

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
 * Initialises a true bare git repository (git init --bare).
 * Git daemon expects bare repos; post-receive hooks live at repo/hooks.
 */
export function initBareRepo(repoId: string): void {
  const dir = repoPath(repoId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(path.join(dir, "HEAD"))) return; // already a bare repo
  child_process.execFileSync("git", ["init", "--bare", dir]);
}

/**
 * Creates the initial commit and pushes to the bare repo.
 */
export function createInitialCommit(
  repoId: string,
  files: Record<string, string>,
  author: { name: string; email: string }
): string {
  const bare = repoPath(repoId);
  const wt = worktreePath(repoId, "init");

  fs.mkdirSync(wt, { recursive: true });
  child_process.execFileSync("git", ["init", "-b", "master"], { cwd: wt });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(wt, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  child_process.execFileSync("git", ["add", "-A"], { cwd: wt });
  child_process.execFileSync(
    "git",
    [
      "commit",
      "-m",
      "Initial commit",
      `--author=${author.name} <${author.email}>`,
    ],
    {
      cwd: wt,
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      },
    }
  );

  const sha = child_process
    .execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" })
    .trim();

  child_process.execFileSync("git", ["remote", "add", "origin", bare], {
    cwd: wt,
  });
  child_process.execFileSync("git", ["push", "-u", "origin", "master"], {
    cwd: wt,
  });

  fs.rmSync(wt, { recursive: true, force: true });
  return sha;
}

// ── Branch operations ─────────────────────────────────────────────────────────

/**
 * Returns the commit hash (SHA) of the HEAD of a branch.
 */
export function getCommitHash(repoId: string, branch: string): string {
  const dir = repoPath(repoId);
  return child_process
    .execFileSync("git", ["--git-dir", dir, "rev-parse", branch], {
      encoding: "utf8",
    })
    .trim();
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

  // Clone, branch, commit, push — isomorphic-git doesn't support file://; use shell git
  fs.mkdirSync(wt, { recursive: true });
  child_process.execFileSync("git", ["clone", "--branch", "master", bare, wt]);
  child_process.execFileSync("git", ["checkout", "-b", branch], { cwd: wt });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(wt, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  child_process.execFileSync("git", ["add", "-A"], { cwd: wt });
  child_process.execFileSync(
    "git",
    ["commit", "-m", message, `--author=${author.name} <${author.email}>`],
    {
      cwd: wt,
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      },
    }
  );

  const sha = child_process
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
    })
    .trim();

  child_process.execFileSync("git", ["push", "origin", branch], { cwd: wt });

  fs.rmSync(wt, { recursive: true, force: true });
  return sha;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Returns a unified diff between two branches using shell git.
 * Works reliably on bare repos; avoids isomorphic-git's bare-repo quirks.
 */
export function getDiff(
  repoId: string,
  baseBranch: string,
  featureBranch: string
): string {
  const dir = repoPath(repoId);
  try {
    const out = child_process.execFileSync(
      "git",
      ["--git-dir", dir, "diff", `${baseBranch}..${featureBranch}`],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
    return out.trim() || "(no textual differences)";
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(
      `Could not get diff: ${baseBranch}..${featureBranch} — ${msg}`
    );
  }
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
    child_process.execFileSync("git", ["clone", bare, wt]);
    child_process.execFileSync(
      "git",
      [
        "merge",
        `origin/${featureBranch}`,
        "-m",
        `Merge branch '${featureBranch}' into master via gitchain`,
      ],
      {
        cwd: wt,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "gitchain-bridge",
          GIT_AUTHOR_EMAIL: "bridge@gitchain.local",
        },
      }
    );
    const sha = child_process
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt,
        encoding: "utf8",
      })
      .trim();

    child_process.execFileSync("git", ["push", "origin", "master"], {
      cwd: wt,
      env: {
        ...process.env,
        [GITCHAIN_BRIDGE_MERGE]: "1",
      },
    });
    return sha;
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

// ── Read file ─────────────────────────────────────────────────────────────────

/**
 * Reads the content of a file at a specific branch/ref in the bare repo.
 */
export function readFileAtRef(
  repoId: string,
  branch: string,
  filePath: string
): string {
  const dir = repoPath(repoId);
  return child_process
    .execFileSync("git", ["--git-dir", dir, "show", `${branch}:${filePath}`], {
      encoding: "utf8",
    })
    .trim();
}

// ── Install hooks ─────────────────────────────────────────────────────────────

/** Env var the bridge sets when pushing to master. Pre-receive allows master push only when set. */
export const GITCHAIN_BRIDGE_MERGE = "GITCHAIN_BRIDGE_MERGE";

/**
 * Installs the pre-receive hook into the bare repo.
 * Rejects direct pushes to master; the bridge sets GITCHAIN_BRIDGE_MERGE=1 when merging.
 */
export function installPreReceiveHook(repoId: string): void {
  const dir = repoPath(repoId);
  const hooksDir = path.join(dir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, "pre-receive");
  const hookScript = `#!/bin/sh
# pre-receive hook — reject direct pushes to master; bridge sets GITCHAIN_BRIDGE_MERGE when merging
while read oldrev newrev refname; do
  case "$refname" in
    refs/heads/master)
      if [ "$GITCHAIN_BRIDGE_MERGE" = "1" ]; then
        :
      else
        echo "error: Direct pushes to master are rejected. Create a branch and push it for review."
        exit 1
      fi
      ;;
  esac
done
exit 0
`;

  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
}

/**
 * Installs the post-receive hook into the bare repo.
 * For bare repos, hooks live at repo/hooks (repo root = $GIT_DIR).
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
  if [ "$branch" = "master" ] || [ "$branch" = "HEAD" ]; then
    continue
  fi

  echo "[gitchain] Branch pushed: $branch ($newrev)"
  if ! node /app/dist/src/cli.js propose ${repoId} "$branch" "$newrev" "Push: $branch" 2>&1; then
    echo "[gitchain] WARNING: propose failed for $branch — agents will not see this proposal"
  fi
done
`;

  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
}
