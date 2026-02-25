/**
 * bridge.ts — On-chain event bridge.
 *
 * Listens for MergeApproved events from the ProposalManager contract.
 * When triggered, executes the actual git merge on the shared repo volume
 * and records the merged commit hash back on-chain.
 *
 * Run: node dist/src/bridge.js
 */
import chalk from "chalk";
import { ethers } from "ethers";
import { getContracts, recordMerge } from "./chain";
import { mergeBranch } from "./git";
import { waitForAddresses, sleep } from "./config";

const BRIDGE_WALLET = 0; // Uses wallet 0 (same as setup/owner)

async function startBridge(): Promise<void> {
  console.log(
    chalk.cyan("[bridge] Starting — waiting for deployed contracts...")
  );

  const addresses = await waitForAddresses();
  const contracts = await getContracts(BRIDGE_WALLET, addresses);

  console.log(chalk.cyan("[bridge] Connected to contracts."));
  console.log(
    chalk.cyan(
      `[bridge]   ProposalManager: ${addresses.proposalManagerAddress}`
    )
  );
  console.log(chalk.cyan("[bridge] Listening for MergeApproved events...\n"));

  // ── Event listener ──────────────────────────────────────────────────────────

  contracts.proposals.on(
    "MergeApproved",
    async (proposalId: bigint, branchName: string, commitHash: string) => {
      const id = proposalId.toString();
      console.log(
        chalk.bold.green(`\n[bridge] ✓ MergeApproved — proposal #${id}`) +
          `\n         Branch: ${chalk.blue(branchName)}` +
          `\n         Commit: ${commitHash}`
      );

      try {
        // Fetch the proposal to get the repoId
        const raw = await contracts.proposals.getProposal(proposalId);
        const repoId: string = raw.repoId;

        console.log(
          chalk.cyan(
            `[bridge] Merging branch "${branchName}" into main in repo "${repoId}"...`
          )
        );

        const mergedHash = await mergeBranch(repoId, branchName);

        console.log(
          chalk.green(`[bridge] Merge complete. Merged commit: ${mergedHash}`)
        );

        // Record the merged hash on-chain
        await recordMerge(contracts, proposalId, mergedHash);

        console.log(
          chalk.green(
            `[bridge] ✓ Merge recorded on-chain for proposal #${id}\n`
          )
        );
      } catch (err) {
        console.error(
          chalk.red(
            `[bridge] ✗ Failed to process proposal #${id}: ${
              (err as Error).message
            }`
          )
        );
      }
    }
  );

  // ── Event listener for MergeRecorded (audit log) ───────────────────────────

  contracts.proposals.on(
    "MergeRecorded",
    (proposalId: bigint, mergedCommitHash: string) => {
      console.log(
        chalk.dim(
          `[bridge] [audit] Proposal #${proposalId} merged as ${mergedCommitHash}`
        )
      );
    }
  );

  // ── Keep alive ──────────────────────────────────────────────────────────────

  // ethers.js polls the RPC — keep the process alive indefinitely.
  console.log(chalk.dim("[bridge] Bridge active. Press Ctrl+C to stop."));
  while (true) {
    await sleep(60_000);
  }
}

// ── Error handling ────────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => {
  console.error(chalk.red("[bridge] Unhandled rejection:"), err);
  process.exit(1);
});

startBridge().catch((err) => {
  console.error(chalk.red("[bridge] Fatal:"), err);
  process.exit(1);
});
