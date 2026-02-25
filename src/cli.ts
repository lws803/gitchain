#!/usr/bin/env node
/**
 * cli.ts — Gitchain CLI
 *
 * Entry point for both the post-receive hook (`propose`) and
 * manual inspection (`list`, `status`, `diff`).
 *
 * Usage:
 *   gitchain propose <repoId> <branch> <commitHash> [description]
 *   gitchain list
 *   gitchain status <proposalId>
 *   gitchain diff <proposalId>
 */
import { Command } from "commander";
import chalk from "chalk";

import {
  getContracts,
  createProposal,
  getAllProposals,
  getProposal,
} from "./chain";
import { getDiff } from "./git";
import { ProposalState, stateLabel } from "./config";

const program = new Command();

program
  .name("gitchain")
  .description("Blockchain-based git review system")
  .version("0.1.0");

// ── propose ───────────────────────────────────────────────────────────────────

program
  .command("propose <repoId> <branch> <commitHash> [description]")
  .description(
    "Create an on-chain proposal for a pushed branch (called by post-receive hook)"
  )
  .option("-w, --wallet <index>", "Hardhat wallet index to sign with", "0")
  .action(
    async (
      repoId: string,
      branch: string,
      commitHash: string,
      description: string | undefined,
      opts: { wallet: string }
    ) => {
      try {
        const walletIndex = parseInt(opts.wallet, 10);
        const contracts = await getContracts(walletIndex);
        const desc = description ?? `Push: ${branch}`;

        const proposalId = await createProposal(
          contracts,
          repoId,
          branch,
          commitHash,
          desc
        );

        console.log(
          chalk.green(
            `[gitchain] Proposal #${proposalId} created for branch "${branch}" (${commitHash.slice(
              0,
              8
            )})`
          )
        );
        process.exit(0);
      } catch (err) {
        console.error(
          chalk.red(`[gitchain] propose failed: ${(err as Error).message}`)
        );
        process.exit(1);
      }
    }
  );

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all proposals with their current state")
  .action(async () => {
    try {
      const contracts = await getContracts(0);
      const all = await getAllProposals(contracts);

      if (all.length === 0) {
        console.log(chalk.yellow("No proposals yet."));
        return;
      }

      console.log(chalk.bold("\nGitchain Proposals\n"));
      for (const p of all) {
        const stateColor =
          p.state === ProposalState.Merged
            ? chalk.green
            : p.state === ProposalState.Approved
            ? chalk.cyan
            : p.state === ProposalState.Rejected
            ? chalk.red
            : chalk.yellow;

        console.log(
          `  ${chalk.bold(`#${p.id}`)}  ${stateColor(
            stateLabel(p.state).padEnd(10)
          )}` +
            `  ${chalk.blue(p.branchName.padEnd(40))}` +
            `  ${p.description}`
        );
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`list failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status <proposalId>")
  .description("Show detailed status of a proposal")
  .action(async (proposalIdStr: string) => {
    try {
      const contracts = await getContracts(0);
      const proposalId = BigInt(proposalIdStr);
      const p = await getProposal(contracts, proposalId);

      const stateColor =
        p.state === ProposalState.Merged
          ? chalk.green
          : p.state === ProposalState.Approved
          ? chalk.cyan
          : p.state === ProposalState.Rejected
          ? chalk.red
          : chalk.yellow;

      console.log(chalk.bold(`\nProposal #${p.id}\n`));
      console.log(`  Branch:      ${chalk.blue(p.branchName)}`);
      console.log(`  Commit:      ${p.commitHash}`);
      console.log(`  Repo:        ${p.repoId}`);
      console.log(`  Description: ${p.description}`);
      console.log(`  Proposer:    ${p.proposer}`);
      console.log(`  State:       ${stateColor(stateLabel(p.state))}`);
      console.log(`  Approvals:   ${p.approvalCount}`);
      console.log(`  Rejections:  ${p.rejectionCount}`);
      if (p.mergedCommitHash) {
        console.log(`  Merged as:   ${chalk.green(p.mergedCommitHash)}`);
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`status failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ── diff ──────────────────────────────────────────────────────────────────────

program
  .command("diff <proposalId>")
  .description("Show the code diff for a proposal")
  .action(async (proposalIdStr: string) => {
    try {
      const contracts = await getContracts(0);
      const proposalId = BigInt(proposalIdStr);
      const p = await getProposal(contracts, proposalId);

      console.log(
        chalk.bold(`\nDiff for Proposal #${p.id} — ${p.branchName}\n`)
      );

      const diffText = getDiff(p.repoId, "master", p.branchName);

      // Colorize diff output
      for (const line of diffText.split("\n")) {
        if (line.startsWith("+")) {
          console.log(chalk.green(line));
        } else if (line.startsWith("-")) {
          console.log(chalk.red(line));
        } else if (
          line.startsWith("@") ||
          line.startsWith("---") ||
          line.startsWith("+++")
        ) {
          console.log(chalk.cyan(line));
        } else {
          console.log(line);
        }
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`diff failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
