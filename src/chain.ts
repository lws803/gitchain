/**
 * chain.ts — ethers.js wrappers for interacting with deployed gitchain contracts.
 *
 * Hardhat's built-in accounts (indices 0-19) act as the agent wallets.
 * Wallet 0 = gateway/owner (deployer, used by setup and CLI hook).
 * Wallets 1-3 = AI reviewer agents (Alice, Bob, Charlie).
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  HARDHAT_RPC,
  DeployedAddresses,
  ProposalInfo,
  ProposalState,
  waitForAddresses,
} from "./config";

// ── ABI fragments ─────────────────────────────────────────────────────────────
// We load the compiled artifacts rather than duplicating ABIs here.

function loadArtifact(name: string): { abi: unknown[] } {
  // Try both Docker path and local dev path
  const candidates = [
    path.join("/app/artifacts/contracts", `${name}.sol`, `${name}.json`),
    path.join(
      __dirname,
      "../artifacts/contracts",
      `${name}.sol`,
      `${name}.json`
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  throw new Error(
    `Artifact not found for ${name}. Run 'npx hardhat compile' first.`
  );
}

// ── Connection ────────────────────────────────────────────────────────────────

export interface Contracts {
  registry: ethers.Contract;
  proposals: ethers.Contract;
  signer: ethers.Signer;
  provider: ethers.JsonRpcProvider;
}

/**
 * Connects to deployed contracts using the given Hardhat wallet index.
 * Loads addresses from deployed.json (written by setup.ts).
 */
export async function getContracts(
  walletIndex: number = 0,
  addresses?: DeployedAddresses
): Promise<Contracts> {
  const addrs = addresses ?? (await waitForAddresses());

  const provider = new ethers.JsonRpcProvider(HARDHAT_RPC);
  const signer = await provider.getSigner(walletIndex);

  const registryArtifact = loadArtifact("ReviewerRegistry");
  const pmArtifact = loadArtifact("ProposalManager");

  const registry = new ethers.Contract(
    addrs.registryAddress,
    registryArtifact.abi as ethers.InterfaceAbi,
    signer
  );

  const proposals = new ethers.Contract(
    addrs.proposalManagerAddress,
    pmArtifact.abi as ethers.InterfaceAbi,
    signer
  );

  return { registry, proposals, signer, provider };
}

// ── Registry operations ───────────────────────────────────────────────────────

export async function registerReviewer(
  contracts: Contracts,
  wallet: string,
  name: string,
  publicKey: string
): Promise<void> {
  const tx = await contracts.registry.registerReviewer(wallet, name, publicKey);
  await tx.wait();
}

export async function isReviewer(
  contracts: Contracts,
  wallet: string
): Promise<boolean> {
  return contracts.registry.isReviewer(wallet);
}

// ── Proposal operations ───────────────────────────────────────────────────────

export async function createProposal(
  contracts: Contracts,
  repoId: string,
  branchName: string,
  commitHash: string,
  description: string
): Promise<bigint> {
  const tx = await contracts.proposals.createProposal(
    repoId,
    branchName,
    commitHash,
    description
  );
  const receipt = await tx.wait();

  // Extract proposalId from ProposalCreated event
  const event = receipt?.logs
    ?.map((log: ethers.Log) => {
      try {
        return contracts.proposals.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e: ethers.LogDescription | null) => e?.name === "ProposalCreated");

  return event?.args?.[0] ?? 0n;
}

export async function castVote(
  contracts: Contracts,
  proposalId: bigint,
  approve: boolean
): Promise<void> {
  const tx = await contracts.proposals.vote(proposalId, approve);
  await tx.wait();
}

export async function recordMerge(
  contracts: Contracts,
  proposalId: bigint,
  mergedCommitHash: string
): Promise<void> {
  const tx = await contracts.proposals.recordMerge(
    proposalId,
    mergedCommitHash
  );
  await tx.wait();
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getProposal(
  contracts: Contracts,
  proposalId: bigint
): Promise<ProposalInfo> {
  const raw = await contracts.proposals.getProposal(proposalId);
  return normalizeProposal(raw);
}

export async function getAllProposals(
  contracts: Contracts
): Promise<ProposalInfo[]> {
  const count: bigint = await contracts.proposals.proposalCount();
  const results: ProposalInfo[] = [];
  for (let i = 0n; i < count; i++) {
    results.push(await getProposal(contracts, i));
  }
  return results;
}

export async function hasVoted(
  contracts: Contracts,
  proposalId: bigint,
  voterAddress: string
): Promise<boolean> {
  return contracts.proposals.hasVoted(proposalId, voterAddress);
}

// ── Normalizer ────────────────────────────────────────────────────────────────

// ethers returns structs as array-like objects — normalise to plain ProposalInfo.
function normalizeProposal(raw: {
  id: bigint;
  repoId: string;
  branchName: string;
  commitHash: string;
  description: string;
  proposer: string;
  state: bigint;
  approvalCount: bigint;
  rejectionCount: bigint;
  mergedCommitHash: string;
}): ProposalInfo {
  return {
    id: raw.id,
    repoId: raw.repoId,
    branchName: raw.branchName,
    commitHash: raw.commitHash,
    description: raw.description,
    proposer: raw.proposer,
    state: Number(raw.state) as ProposalState,
    approvalCount: raw.approvalCount,
    rejectionCount: raw.rejectionCount,
    mergedCommitHash: raw.mergedCommitHash,
  };
}
