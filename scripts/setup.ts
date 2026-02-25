/**
 * setup.ts — One-shot cluster initialiser.
 *
 * Runs once at startup (Docker: `node dist/scripts/setup.js`).
 * 1. Waits for Hardhat RPC to be ready
 * 2. Deploys ReviewerRegistry + ProposalManager
 * 3. Saves contract addresses to /app/shared/deployed.json
 * 4. Registers 3 AI reviewer agents (wallets 1-3)
 * 5. Initialises the sample bare repo with a seed commit
 * 6. Installs the post-receive hook into the bare repo
 * 7. Exits 0 — Docker marks it service_completed_successfully
 */
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import chalk from "chalk";
import { HARDHAT_RPC, REPOS_DIR, saveAddresses, sleep } from "../src/config";
import {
  initBareRepo,
  createInitialCommit,
  installPostReceiveHook,
} from "../src/git";
import { getContracts, registerReviewer } from "../src/chain";

const SAMPLE_REPO = "sample-repo";
const APPROVAL_THRESHOLD = 2;

// Reviewers: wallets 1-3 (wallet 0 = gateway/owner)
const REVIEWERS = [
  { index: 1, name: "Alice", publicKey: "alice-pk" },
  { index: 2, name: "Bob", publicKey: "bob-pk" },
  { index: 3, name: "Charlie", publicKey: "charlie-pk" },
];

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const candidates = [
    path.join("/app/artifacts/contracts", `${name}.sol`, `${name}.json`),
    path.join(__dirname, "../artifacts/contracts", `${name}.sol`, `${name}.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  throw new Error(`Artifact not found for ${name}. Run 'npx hardhat compile'.`);
}

// ── 1. Wait for Hardhat ───────────────────────────────────────────────────────

async function waitForHardhat(): Promise<ethers.JsonRpcProvider> {
  console.log(chalk.cyan(`[setup] Waiting for Hardhat node at ${HARDHAT_RPC}...`));
  while (true) {
    try {
      const provider = new ethers.JsonRpcProvider(HARDHAT_RPC);
      await provider.getBlockNumber();
      console.log(chalk.green("[setup] Hardhat node is ready."));
      return provider;
    } catch {
      await sleep(2_000);
    }
  }
}

// ── 2. Deploy contracts ───────────────────────────────────────────────────────

async function deployContracts(
  provider: ethers.JsonRpcProvider
): Promise<{ registryAddress: string; proposalManagerAddress: string }> {
  console.log(chalk.cyan("[setup] Deploying contracts..."));

  const deployer = await provider.getSigner(0);

  // Deploy ReviewerRegistry
  const registryArtifact = loadArtifact("ReviewerRegistry");
  const RegistryFactory = new ethers.ContractFactory(
    registryArtifact.abi as ethers.InterfaceAbi,
    registryArtifact.bytecode,
    deployer
  );
  const registry = await RegistryFactory.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(chalk.green(`[setup]   ReviewerRegistry:  ${registryAddress}`));

  // Deploy ProposalManager
  const pmArtifact = loadArtifact("ProposalManager");
  const PMFactory = new ethers.ContractFactory(
    pmArtifact.abi as ethers.InterfaceAbi,
    pmArtifact.bytecode,
    deployer
  );
  const pm = await PMFactory.deploy(registryAddress, APPROVAL_THRESHOLD);
  await pm.waitForDeployment();
  const proposalManagerAddress = await pm.getAddress();
  console.log(chalk.green(`[setup]   ProposalManager:   ${proposalManagerAddress}`));
  console.log(chalk.dim(`[setup]   Approval threshold: ${APPROVAL_THRESHOLD}`));

  return { registryAddress, proposalManagerAddress };
}

// ── 3. Register reviewers ─────────────────────────────────────────────────────

async function registerReviewers(addresses: {
  registryAddress: string;
  proposalManagerAddress: string;
}): Promise<void> {
  console.log(chalk.cyan("\n[setup] Registering reviewer agents..."));

  // Owner wallet (index 0) registers the reviewers
  const contracts = await getContracts(0, addresses);
  const provider = contracts.provider;

  for (const r of REVIEWERS) {
    const walletAddress = await (await provider.getSigner(r.index)).getAddress();
    await registerReviewer(contracts, walletAddress, r.name, r.publicKey);
    console.log(
      chalk.green(`[setup]   ${r.name} (wallet ${r.index}): ${walletAddress}`)
    );
  }
}

// ── 4. Initialise sample repo ─────────────────────────────────────────────────

async function initSampleRepo(): Promise<void> {
  const repoDir = path.join(REPOS_DIR, SAMPLE_REPO);

  if (fs.existsSync(path.join(repoDir, "HEAD"))) {
    console.log(chalk.dim(`\n[setup] Repo "${SAMPLE_REPO}" already exists — skipping init.`));
    return;
  }

  console.log(chalk.cyan(`\n[setup] Initialising sample repo "${SAMPLE_REPO}"...`));

  fs.mkdirSync(REPOS_DIR, { recursive: true });

  await initBareRepo(SAMPLE_REPO);

  // Seed file: a simple TypeScript module that agents will propose changes to
  const seedFiles: Record<string, string> = {
    "hello.ts": `// hello.ts — sample codebase managed by gitchain
export const greet = (): string => {
  return "hello";
};
`,
    "README.md": `# sample-repo

This repository is managed by **gitchain** — a blockchain-based zero-trust
code review system. Changes must be approved by AI agent reviewers before merging.

## Contributing

1. Clone: \`git clone git://localhost:9418/sample-repo\`
2. Create a branch with your changes
3. Push: \`git push -u origin feature/your-branch\` (use \`-u\` to set upstream)
4. Agents will review and vote automatically
`,
  };

  const sha = await createInitialCommit(SAMPLE_REPO, seedFiles, {
    name: "gitchain-setup",
    email: "setup@gitchain.local",
  });

  console.log(chalk.green(`[setup]   Initial commit: ${sha}`));
}

// ── 5. Install post-receive hook ──────────────────────────────────────────────

function installHook(): void {
  console.log(chalk.cyan("\n[setup] Installing post-receive hook..."));
  installPostReceiveHook(SAMPLE_REPO);
  console.log(chalk.green("[setup]   Hook installed."));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(chalk.bold.cyan("\n╔══════════════════════════════╗"));
  console.log(chalk.bold.cyan("║     Gitchain Setup           ║"));
  console.log(chalk.bold.cyan("╚══════════════════════════════╝\n"));

  const provider = await waitForHardhat();

  const addresses = await deployContracts(provider);
  saveAddresses(addresses);
  console.log(chalk.green(`\n[setup] Addresses saved to deployed.json`));

  await registerReviewers(addresses);
  await initSampleRepo();
  installHook();

  console.log(chalk.bold.green("\n╔══════════════════════════════════════════════════╗"));
  console.log(chalk.bold.green("║  Gitchain is ready!                              ║"));
  console.log(chalk.bold.green("╠══════════════════════════════════════════════════╣"));
  console.log(chalk.bold.green("║  Clone the repo and push a branch:               ║"));
  console.log(chalk.bold.green("║                                                  ║"));
  console.log(chalk.bold.green("║    git clone git://localhost:9418/sample-repo    ║"));
  console.log(chalk.bold.green("║    cd sample-repo                                ║"));
  console.log(chalk.bold.green("║    git checkout -b feature/add-farewell          ║"));
  console.log(chalk.bold.green("║    # Edit hello.ts — add a farewell() function   ║"));
  console.log(chalk.bold.green("║    git add . && git commit -m 'Add farewell'    ║"));
  console.log(chalk.bold.green("║    git push -u origin feature/add-farewell       ║"));
  console.log(chalk.bold.green("║                                                  ║"));
  console.log(chalk.bold.green("║  Visualize the review process:                   ║"));
  console.log(chalk.bold.green("║    docker compose logs -f agent-alice agent-bob  ║"));
  console.log(chalk.bold.green("║      agent-charlie bridge                        ║"));
  console.log(chalk.bold.green("╚══════════════════════════════════════════════════╝\n"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(chalk.red("[setup] Fatal:"), err);
    process.exit(1);
  });
