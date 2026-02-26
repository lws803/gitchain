import * as fs from "fs";
import * as path from "path";

// ── Environment ────────────────────────────────────────────────────────────────

export const HARDHAT_RPC = process.env.HARDHAT_RPC ?? "http://127.0.0.1:8545";

// When running in Docker, volumes are mounted at /app/shared and /app/repos.
// For local development, fall back to paths relative to the project root.
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const SHARED_DIR = fs.existsSync("/app/shared")
  ? "/app/shared"
  : path.join(PROJECT_ROOT, "shared");

export const REPOS_DIR = fs.existsSync("/app/repos")
  ? "/app/repos"
  : path.join(PROJECT_ROOT, "repos");

export const ADDRESSES_FILE = path.join(SHARED_DIR, "deployed.json");

/** Default branch name for gitchain-managed repos (e.g. sample-repo). */
export const DEFAULT_BRANCH = "main";

// ── Timing ─────────────────────────────────────────────────────────────────────

/** How often agents poll for new proposals (ms). */
export const POLL_INTERVAL_MS = 5_000;

/** How long to wait between retries when waiting for deployed.json (ms). */
const WAIT_RETRY_MS = 2_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeployedAddresses {
  registryAddress: string;
  proposalManagerAddress: string;
}

export enum ProposalState {
  Open = 0,
  Approved = 1,
  Rejected = 2,
  Merged = 3,
}

export interface ProposalInfo {
  id: bigint;
  repoId: string;
  branchName: string;
  commitHash: string;
  description: string;
  proposer: string;
  state: ProposalState;
  approvalCount: bigint;
  rejectionCount: bigint;
  mergedCommitHash: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reads deployed.json. Retries indefinitely until the file appears. */
export async function waitForAddresses(): Promise<DeployedAddresses> {
  while (true) {
    try {
      fs.mkdirSync(SHARED_DIR, { recursive: true });
      const raw = fs.readFileSync(ADDRESSES_FILE, "utf8");
      return JSON.parse(raw) as DeployedAddresses;
    } catch {
      process.stdout.write(
        `[config] Waiting for deployed.json at ${ADDRESSES_FILE}...\n`
      );
      await sleep(WAIT_RETRY_MS);
    }
  }
}

/** Writes deployed addresses to shared volume. */
export function saveAddresses(addresses: DeployedAddresses): void {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(addresses, null, 2), "utf8");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stateLabel(state: ProposalState): string {
  return (
    { 0: "Open", 1: "Approved", 2: "Rejected", 3: "Merged" }[state] ?? "Unknown"
  );
}
