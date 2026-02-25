import { expect } from "chai";
import { ethers } from "hardhat";
import { ReviewerRegistry, ProposalManager } from "../typechain-types";

describe("Gitchain Contracts", function () {
  let registry: ReviewerRegistry;
  let proposals: ProposalManager;

  let owner: Awaited<ReturnType<typeof ethers.getSigner>>;
  let alice: Awaited<ReturnType<typeof ethers.getSigner>>;
  let bob: Awaited<ReturnType<typeof ethers.getSigner>>;
  let charlie: Awaited<ReturnType<typeof ethers.getSigner>>;
  let stranger: Awaited<ReturnType<typeof ethers.getSigner>>;

  beforeEach(async function () {
    [owner, alice, bob, charlie, stranger] = await ethers.getSigners();

    // Deploy ReviewerRegistry
    const RegistryFactory = await ethers.getContractFactory("ReviewerRegistry");
    registry = (await RegistryFactory.deploy()) as ReviewerRegistry;

    // Deploy ProposalManager with threshold = 2
    const PMFactory = await ethers.getContractFactory("ProposalManager");
    proposals = (await PMFactory.deploy(
      await registry.getAddress(),
      2
    )) as ProposalManager;

    // Register Alice and Bob as reviewers
    await registry.registerReviewer(alice.address, "Alice", "alice-pubkey");
    await registry.registerReviewer(bob.address, "Bob", "bob-pubkey");
  });

  // ── ReviewerRegistry ────────────────────────────────────────────────────────

  describe("ReviewerRegistry", function () {
    it("sets owner on deploy", async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("registers a reviewer", async function () {
      expect(await registry.isReviewer(alice.address)).to.be.true;
      const agent = await registry.getReviewer(alice.address);
      expect(agent.name).to.equal("Alice");
    });

    it("rejects duplicate registration", async function () {
      await expect(
        registry.registerReviewer(alice.address, "Alice2", "key")
      ).to.be.revertedWith("ReviewerRegistry: already registered");
    });

    it("removes a reviewer", async function () {
      await registry.removeReviewer(alice.address);
      expect(await registry.isReviewer(alice.address)).to.be.false;
    });

    it("rejects non-owner registration", async function () {
      await expect(
        registry.connect(stranger).registerReviewer(stranger.address, "X", "y")
      ).to.be.revertedWith("ReviewerRegistry: not owner");
    });
  });

  // ── ProposalManager ─────────────────────────────────────────────────────────

  describe("ProposalManager", function () {
    it("creates a proposal", async function () {
      await expect(
        proposals.createProposal(
          "sample-repo",
          "feature/add-hello",
          "abc123",
          "Add hello function"
        )
      )
        .to.emit(proposals, "ProposalCreated")
        .withArgs(0n, owner.address, "feature/add-hello", "abc123");

      expect(await proposals.proposalCount()).to.equal(1n);
    });

    it("allows a reviewer to vote approve", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");

      await expect(proposals.connect(alice).vote(0n, true))
        .to.emit(proposals, "VoteRecorded")
        .withArgs(0n, alice.address, true);

      const p = await proposals.getProposal(0n);
      expect(p.approvalCount).to.equal(1n);
    });

    it("emits MergeApproved when threshold is met", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");

      await proposals.connect(alice).vote(0n, true);
      await expect(proposals.connect(bob).vote(0n, true))
        .to.emit(proposals, "MergeApproved")
        .withArgs(0n, "branch", "hash");

      const p = await proposals.getProposal(0n);
      expect(p.state).to.equal(1); // Approved
    });

    it("rejects double voting", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");
      await proposals.connect(alice).vote(0n, true);

      await expect(proposals.connect(alice).vote(0n, true)).to.be.revertedWith(
        "ProposalManager: already voted"
      );
    });

    it("rejects non-reviewer vote", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");

      await expect(
        proposals.connect(stranger).vote(0n, true)
      ).to.be.revertedWith("ProposalManager: not a reviewer");
    });

    it("records a merge", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");
      await proposals.connect(alice).vote(0n, true);
      await proposals.connect(bob).vote(0n, true); // triggers Approved

      await expect(proposals.recordMerge(0n, "merged-hash"))
        .to.emit(proposals, "MergeRecorded")
        .withArgs(0n, "merged-hash");

      const p = await proposals.getProposal(0n);
      expect(p.state).to.equal(3); // Merged
      expect(p.mergedCommitHash).to.equal("merged-hash");
    });

    it("cannot record merge on non-approved proposal", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");

      await expect(proposals.recordMerge(0n, "merged-hash")).to.be.revertedWith(
        "ProposalManager: not approved"
      );
    });

    it("tracks hasVoted per proposal", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");
      expect(await proposals.hasVoted(0n, alice.address)).to.be.false;

      await proposals.connect(alice).vote(0n, true);
      expect(await proposals.hasVoted(0n, alice.address)).to.be.true;
      expect(await proposals.hasVoted(0n, bob.address)).to.be.false;
    });

    it("handles rejection votes", async function () {
      await proposals.createProposal("repo", "branch", "hash", "desc");
      await proposals.connect(alice).vote(0n, false);

      const p = await proposals.getProposal(0n);
      expect(p.rejectionCount).to.equal(1n);
      expect(p.state).to.equal(0); // Still Open (no rejection threshold in this PoC)
    });

    it("cannot vote on a merged proposal", async function () {
      // Register charlie so we have a third voter
      await registry.registerReviewer(charlie.address, "Charlie", "charlie-key");

      await proposals.createProposal("repo", "branch", "hash", "desc");
      await proposals.connect(alice).vote(0n, true);
      await proposals.connect(bob).vote(0n, true); // Approved
      await proposals.recordMerge(0n, "merged");

      await expect(
        proposals.connect(charlie).vote(0n, true)
      ).to.be.revertedWith("ProposalManager: not open");
    });
  });
});
