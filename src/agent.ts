/**
 * agent.ts — AI-powered code review agent using Vercel AI SDK's ToolLoopAgent.
 *
 * Each agent runs as a separate process with its own wallet (index).
 * It polls every POLL_INTERVAL_MS for open proposals it hasn't voted on,
 * then uses a ToolLoopAgent to read the diff and cast a vote.
 *
 * Run: node dist/src/agent.js --wallet 1 --name Alice
 */
import { Command } from "commander";
import chalk from "chalk";
import { ToolLoopAgent, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

import { getContracts, getAllProposals, castVote, hasVoted } from "./chain";
import { getDiff } from "./git";
import {
  waitForAddresses,
  sleep,
  POLL_INTERVAL_MS,
  ProposalState,
  ProposalInfo,
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

// ── OpenRouter setup ─────────────────────────────────────────────────────────

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.AGENT_MODEL ?? "openai/gpt-4o-mini";

if (!apiKey) {
  console.error(chalk.red(`[${AGENT_NAME}] OPENROUTER_API_KEY is not set.`));
  process.exit(1);
}

const openrouter = createOpenRouter({ apiKey });

// ── Logging helpers ───────────────────────────────────────────────────────────

const log = (msg: string) =>
  console.log(`${chalk.bold.magenta(`[${AGENT_NAME}]`)} ${msg}`);

const logTool = (name: string, detail: string) =>
  console.log(
    `${chalk.bold.magenta(`[${AGENT_NAME}]`)} ${chalk.dim(
      `→ ${name}:`
    )} ${detail}`
  );

// ── Build ToolLoopAgent ───────────────────────────────────────────────────────

/**
 * Creates a ToolLoopAgent with access to gitchain tools.
 * Contracts are injected via closure so they're available to tool executors.
 */
function buildAgent(contracts: Contracts, signerAddress: string) {
  return new ToolLoopAgent({
    model: openrouter.chat(model),

    instructions: `You are ${AGENT_NAME}, an AI code reviewer in the gitchain system.
Your wallet address is ${signerAddress}.

Your job each round:
1. Call getOpenProposals to list proposals you have not yet voted on.
2. For each proposal, call getProposalDiff to read the code changes.
3. Decide: call approveProposal if the change looks correct and safe,
   or rejectProposal if the change introduces a bug, breaks existing logic,
   or is unclear. Always provide a brief reason.

Only vote on proposals listed by getOpenProposals (others are already voted or closed).
When there are no proposals left to review, stop calling tools.`,

    tools: {
      getOpenProposals: tool({
        description:
          "Returns all proposals in Open state that this agent has not yet voted on.",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await getAllProposals(contracts);
          const unvoted: Array<{
            id: string;
            repoId: string;
            branch: string;
            commitHash: string;
            description: string;
          }> = [];

          for (const p of all) {
            if (p.state !== ProposalState.Open) continue;
            const voted = await hasVoted(contracts, p.id, signerAddress);
            if (!voted) {
              unvoted.push({
                id: p.id.toString(),
                repoId: p.repoId,
                branch: p.branchName,
                commitHash: p.commitHash,
                description: p.description,
              });
            }
          }

          logTool("getOpenProposals", `found ${unvoted.length} unvoted`);
          return unvoted;
        },
      }),

      getProposalDiff: tool({
        description:
          "Returns the unified diff of code changes proposed in a given proposal.",
        inputSchema: z.object({
          proposalId: z.string().describe("The proposal ID as a string"),
        }),
        execute: async ({ proposalId }) => {
          const all = await getAllProposals(contracts);
          const p = all.find(
            (x: ProposalInfo) => x.id.toString() === proposalId
          );
          if (!p) return { error: "Proposal not found" };

          const diff = await getDiff(p.repoId, "main", p.branchName);
          logTool(
            "getProposalDiff",
            `proposal #${proposalId} (${p.branchName})`
          );
          return { proposalId, branch: p.branchName, diff };
        },
      }),

      approveProposal: tool({
        description:
          "Vote to approve a proposal. Use when the change looks correct and safe.",
        inputSchema: z.object({
          proposalId: z.string().describe("The proposal ID to approve"),
          reason: z.string().describe("Brief reason for approving"),
        }),
        execute: async ({ proposalId, reason }) => {
          await castVote(contracts, BigInt(proposalId), true);
          logTool(
            "approveProposal",
            chalk.green(`#${proposalId} APPROVED — "${reason}"`)
          );
          return { status: "voted", vote: "approve", proposalId, reason };
        },
      }),

      rejectProposal: tool({
        description:
          "Vote to reject a proposal. Use when the change is problematic or unclear.",
        inputSchema: z.object({
          proposalId: z.string().describe("The proposal ID to reject"),
          reason: z.string().describe("Brief reason for rejecting"),
        }),
        execute: async ({ proposalId, reason }) => {
          await castVote(contracts, BigInt(proposalId), false);
          logTool(
            "rejectProposal",
            chalk.red(`#${proposalId} REJECTED — "${reason}"`)
          );
          return { status: "voted", vote: "reject", proposalId, reason };
        },
      }),
    },
  });
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  log(`Starting (wallet index ${WALLET_INDEX}, model: ${model})`);

  const addresses = await waitForAddresses();
  const contracts = await getContracts(WALLET_INDEX, addresses);
  const signerAddress = await contracts.signer.getAddress();

  log(`Connected. Signer: ${chalk.dim(signerAddress)}`);

  const agent = buildAgent(contracts, signerAddress);

  log("Entering poll loop...\n");

  while (true) {
    try {
      log("Checking for open proposals...");
      await agent.generate({
        prompt:
          "Check for open proposals and review any you have not yet voted on. " +
          "When done, stop.",
      });
    } catch (err) {
      // If it's just "no proposals", that's fine
      const msg = (err as Error).message ?? "";
      if (!msg.includes("No open proposals")) {
        log(chalk.yellow(`Poll error: ${msg}`));
      }
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
