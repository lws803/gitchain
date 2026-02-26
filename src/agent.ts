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

import {
  getContracts,
  getAllProposals,
  castVote,
  getOpenUnvotedProposals,
} from "./chain";
import {
  getDiff,
  readFileAtRef,
  listBranches,
  listFilesAtRef,
  grepInRepo,
  getCommitHash,
} from "./git";
import {
  waitForAddresses,
  sleep,
  POLL_INTERVAL_MS,
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

You are given a list of open proposals you have not yet voted on.
For each proposal, you can:
- getProposalDiff — get the unified diff
- readFile — read a file at a specific branch (use master or the proposal branch)
- grepInRepo — search for a pattern in files at a branch
- listFiles — list files in a branch
- listBranches — list branches in the repo
- inspectBranch — get the HEAD commit of a branch (confirm it exists)

Then approveProposal if the change looks correct and safe, or rejectProposal
if it introduces a bug, breaks existing logic, or is unclear. Always provide a brief reason.
When done with all proposals, stop calling tools.`,

    tools: {
      readFile: tool({
        description:
          "Read the contents of a file at a given branch in a repo. Use to inspect full file context beyond the diff.",
        inputSchema: z.object({
          repoId: z.string().describe("The repo ID (e.g. from a proposal)"),
          branch: z
            .string()
            .describe(
              "Branch to read from (e.g. master or the proposal branch)"
            ),
          filePath: z
            .string()
            .describe("Path to the file relative to repo root"),
        }),
        execute: async ({ repoId, branch, filePath }) => {
          try {
            const content = readFileAtRef(repoId, branch, filePath);
            logTool("readFile", `${repoId}/${branch}:${filePath}`);
            return { repoId, branch, filePath, content };
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      }),

      grepInRepo: tool({
        description:
          "Search for a text pattern in files at a given branch. Returns matching lines with file, line number, and content.",
        inputSchema: z.object({
          repoId: z.string().describe("The repo ID"),
          branch: z.string().describe("Branch to search in"),
          pattern: z.string().describe("Search pattern (plain text or regex)"),
        }),
        execute: async ({ repoId, branch, pattern }) => {
          try {
            const matches = grepInRepo(repoId, branch, pattern);
            logTool(
              "grepInRepo",
              `${repoId}/${branch} "${pattern}" → ${matches.length} matches`
            );
            return { repoId, branch, pattern, matches };
          } catch (err) {
            return { error: (err as Error).message };
          }
        },
      }),

      listFiles: tool({
        description:
          "List files in a branch, optionally under a directory. Use to explore the codebase structure.",
        inputSchema: z.object({
          repoId: z.string().describe("The repo ID"),
          branch: z.string().describe("Branch to list from"),
          dirPath: z
            .string()
            .optional()
            .describe("Optional subdirectory (e.g. src/)"),
        }),
        execute: async ({ repoId, branch, dirPath }) => {
          const files = listFilesAtRef(repoId, branch, dirPath ?? "");
          logTool(
            "listFiles",
            `${repoId}/${branch}${dirPath ? `/${dirPath}` : ""} → ${
              files.length
            } files`
          );
          return { repoId, branch, dirPath: dirPath ?? "", files };
        },
      }),

      listBranches: tool({
        description:
          "List branches in a repo. Use to see what branches exist (master, feature branches, etc).",
        inputSchema: z.object({
          repoId: z.string().describe("The repo ID"),
        }),
        execute: async ({ repoId }) => {
          const branches = listBranches(repoId);
          logTool("listBranches", `${repoId} → ${branches.length} branches`);
          return { repoId, branches };
        },
      }),

      inspectBranch: tool({
        description:
          "Get the HEAD commit hash of a branch. Use to confirm a branch exists and to see what commit it points to.",
        inputSchema: z.object({
          repoId: z.string().describe("The repo ID"),
          branch: z.string().describe("Branch name to inspect"),
        }),
        execute: async ({ repoId, branch }) => {
          try {
            const commitHash = getCommitHash(repoId, branch);
            logTool("inspectBranch", `${repoId}/${branch} → ${commitHash}`);
            return { repoId, branch, commitHash };
          } catch (err) {
            return { error: (err as Error).message };
          }
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

          const diff = getDiff(p.repoId, "master", p.branchName);
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
      const unvoted = await getOpenUnvotedProposals(contracts, signerAddress);

      if (unvoted.length === 0) {
        log(chalk.dim("No open proposals to review"));
      } else {
        log(`Found ${unvoted.length} open proposal(s) to review`);
        const proposalList = unvoted
          .map(
            (p) =>
              `- #${p.id} (${p.repoId}/${p.branch}): ${
                p.description || "(no description)"
              }`
          )
          .join("\n");
        await agent.generate({
          prompt: `Review these open proposals:\n${proposalList}\n\nFor each, call getProposalDiff then approve or reject with a brief reason.`,
        });
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
