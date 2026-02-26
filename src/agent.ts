/**
 * agent.ts — AI-powered code review agent using Anthropic Claude Agent SDK.
 *
 * Each agent runs as a separate process with its own wallet (index).
 * It polls every POLL_INTERVAL_MS for open proposals it hasn't voted on,
 * creates a temporary clone for the proposal branch, runs Claude with
 * built-in Read/Grep/Glob plus custom approve/reject tools, then removes the clone.
 *
 * Run: node dist/src/agent.js --wallet 1 --name Alice
 */
import { Command } from "commander";
import chalk from "chalk";
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  getContracts,
  getAllProposals,
  castVote,
  getOpenUnvotedProposals,
} from "./chain";
import { getDiff, createReviewClone, removeReviewClone } from "./git";
import type { ProposalInfo } from "./config";
import {
  DEFAULT_BRANCH,
  waitForAddresses,
  sleep,
  POLL_INTERVAL_MS,
} from "./config";
import type { Contracts } from "./chain";

// ── CLI args ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .option("-w, --wallet <index>", "Hardhat wallet index for this agent", "1")
  .option("-n, --name <name>", "Agent display name", "Agent")
  .parse(process.argv);

const opts = program.opts<{ wallet: string; name: string }>();
const WALLET_INDEX = parseInt(opts.wallet, 10);
const AGENT_NAME = opts.name;

// ── Auth ─────────────────────────────────────────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(chalk.red(`[${AGENT_NAME}] ANTHROPIC_API_KEY is not set.`));
  process.exit(1);
}

// ── Logging helpers ───────────────────────────────────────────────────────────

const log = (msg: string) =>
  console.log(`${chalk.bold.magenta(`[${AGENT_NAME}]`)} ${msg}`);

const logTool = (name: string, detail: string) =>
  console.log(
    `${chalk.bold.magenta(`[${AGENT_NAME}]`)} ${chalk.dim(
      `→ ${name}:`
    )} ${detail}`
  );

// ── MCP server with gitchain tools ───────────────────────────────────────────

function buildGitchainMcpServer(contracts: Contracts) {
  return createSdkMcpServer({
    name: "gitchain",
    version: "1.0.0",
    tools: [
      tool(
        "getProposalDiff",
        "Returns the unified diff of code changes proposed in a given proposal. Use for proposals in repos where you don't have a clone.",
        {
          proposalId: z.string().describe("The proposal ID as a string"),
        },
        async ({ proposalId }) => {
          const all = await getAllProposals(contracts);
          const p = all.find(
            (x: ProposalInfo) => x.id.toString() === proposalId
          );
          if (!p) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: "Proposal not found" }),
                },
              ],
            };
          }
          const diff = getDiff(p.repoId, DEFAULT_BRANCH, p.branchName);
          logTool(
            "getProposalDiff",
            `proposal #${proposalId} (${p.branchName})`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  proposalId,
                  branch: p.branchName,
                  diff,
                }),
              },
            ],
          };
        }
      ),
      tool(
        "approveProposal",
        "Vote to approve a proposal. Use when the change looks correct and safe.",
        {
          proposalId: z.string().describe("The proposal ID to approve"),
          reason: z.string().describe("Brief reason for approving"),
        },
        async ({ proposalId, reason }) => {
          await castVote(contracts, BigInt(proposalId), true);
          logTool(
            "approveProposal",
            chalk.green(`#${proposalId} APPROVED — "${reason}"`)
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "voted",
                  vote: "approve",
                  proposalId,
                  reason,
                }),
              },
            ],
          };
        }
      ),
      tool(
        "rejectProposal",
        "Vote to reject a proposal. Use when the change is problematic or unclear.",
        {
          proposalId: z.string().describe("The proposal ID to reject"),
          reason: z.string().describe("Brief reason for rejecting"),
        },
        async ({ proposalId, reason }) => {
          await castVote(contracts, BigInt(proposalId), false);
          logTool(
            "rejectProposal",
            chalk.red(`#${proposalId} REJECTED — "${reason}"`)
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "voted",
                  vote: "reject",
                  proposalId,
                  reason,
                }),
              },
            ],
          };
        }
      ),
    ],
  });
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  const model = "claude-sonnet-4-6";
  log(`Starting (wallet index ${WALLET_INDEX}, model: ${model})`);

  const addresses = await waitForAddresses();
  const contracts = await getContracts(WALLET_INDEX, addresses);
  const signerAddress = await contracts.signer.getAddress();

  log(`Connected. Signer: ${chalk.dim(signerAddress)}`);

  const mcpServer = buildGitchainMcpServer(contracts);

  log("Entering poll loop...\n");

  while (true) {
    try {
      const unvoted = await getOpenUnvotedProposals(contracts, signerAddress);

      if (unvoted.length === 0) {
        log(chalk.dim("No open proposals to review"));
      } else {
        log(`Found ${unvoted.length} open proposal(s) to review`);
        const first = unvoted[0];
        const clonePath = createReviewClone(first.repoId, first.branch);
        try {
          const proposalList = unvoted
            .map(
              (p) =>
                `- #${p.id} (${p.repoId}/${p.branch}): ${
                  p.description || "(no description)"
                }`
            )
            .join("\n");

          const prompt = `You are ${AGENT_NAME}, an AI code reviewer in the gitchain system.
Your wallet address is ${signerAddress}.

Review these open proposals you have not yet voted on:
${proposalList}

For each proposal:
1. Use getProposalDiff to get the code changes.
2. Use Read, Grep, or Glob to inspect relevant files in the clone if needed.
3. Call approveProposal or rejectProposal with a brief reason.

The clone is checked out to the first proposal's branch (${first.branch}).

You MUST vote (approve or reject) on every proposal in the list. Provide a brief reason for each vote. When done with all, stop.`;

          const q = query({
            prompt,
            options: {
              cwd: clonePath,
              model,
              mcpServers: { gitchain: mcpServer },
              allowedTools: [
                "Read",
                "Grep",
                "Glob",
                "mcp__gitchain__getProposalDiff",
                "mcp__gitchain__approveProposal",
                "mcp__gitchain__rejectProposal",
              ],
            },
          });

          for await (const _msg of q) {
            // consume messages until done
          }
          q.close();
        } finally {
          removeReviewClone(clonePath);
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      log(chalk.yellow(`Poll error: ${msg}`));
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => {
  console.error(chalk.red(`[${AGENT_NAME}] Unhandled rejection:`), err);
  process.exit(1);
});

runAgent().catch((err) => {
  console.error(chalk.red(`[${AGENT_NAME}] Fatal:`), err);
  process.exit(1);
});
