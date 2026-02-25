// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReviewerRegistry.sol";

/// @title ProposalManager
/// @notice Manages the full lifecycle of a code-change proposal:
///         create → vote (approve/reject) → auto-merge trigger → record merged hash.
contract ProposalManager {
    enum ProposalState {
        Open,
        Approved,
        Rejected,
        Merged
    }

    struct Proposal {
        uint256 id;
        string repoId;
        string branchName;
        string commitHash;
        string description;
        address proposer;
        ProposalState state;
        uint256 approvalCount;
        uint256 rejectionCount;
        string mergedCommitHash;
        // voters tracked separately in _votes mapping
    }

    /// @notice Flat view struct — no nested mappings, safe to return from external calls.
    struct ProposalInfo {
        uint256 id;
        string repoId;
        string branchName;
        string commitHash;
        string description;
        address proposer;
        ProposalState state;
        uint256 approvalCount;
        uint256 rejectionCount;
        string mergedCommitHash;
    }

    ReviewerRegistry public immutable registry;
    uint256 public immutable approvalThreshold;
    uint256 public proposalCount;

    mapping(uint256 => Proposal) private _proposals;
    // proposalId => voter => hasVoted
    mapping(uint256 => mapping(address => bool)) private _votes;

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        string branchName,
        string commitHash
    );
    event VoteRecorded(
        uint256 indexed id,
        address indexed voter,
        bool approved
    );
    event MergeApproved(
        uint256 indexed id,
        string branchName,
        string commitHash
    );
    event MergeRecorded(uint256 indexed id, string mergedCommitHash);

    constructor(address registryAddress, uint256 threshold) {
        require(registryAddress != address(0), "ProposalManager: zero registry");
        require(threshold > 0, "ProposalManager: threshold must be > 0");
        registry = ReviewerRegistry(registryAddress);
        approvalThreshold = threshold;
    }

    /// @notice Create a new proposal from a branch push.
    function createProposal(
        string calldata repoId,
        string calldata branchName,
        string calldata commitHash,
        string calldata description
    ) external returns (uint256) {
        require(bytes(repoId).length > 0, "ProposalManager: empty repoId");
        require(bytes(branchName).length > 0, "ProposalManager: empty branch");
        require(bytes(commitHash).length > 0, "ProposalManager: empty hash");

        uint256 id = proposalCount++;
        _proposals[id] = Proposal({
            id: id,
            repoId: repoId,
            branchName: branchName,
            commitHash: commitHash,
            description: description,
            proposer: msg.sender,
            state: ProposalState.Open,
            approvalCount: 0,
            rejectionCount: 0,
            mergedCommitHash: ""
        });

        emit ProposalCreated(id, msg.sender, branchName, commitHash);
        return id;
    }

    /// @notice Cast a vote on an open proposal.
    ///         Requires: active reviewer, not already voted, proposal is Open.
    function vote(uint256 proposalId, bool approve) external {
        require(proposalId < proposalCount, "ProposalManager: invalid id");
        require(registry.isReviewer(msg.sender), "ProposalManager: not a reviewer");
        require(!_votes[proposalId][msg.sender], "ProposalManager: already voted");

        Proposal storage p = _proposals[proposalId];
        require(p.state == ProposalState.Open, "ProposalManager: not open");

        _votes[proposalId][msg.sender] = true;

        if (approve) {
            p.approvalCount++;
        } else {
            p.rejectionCount++;
        }

        emit VoteRecorded(proposalId, msg.sender, approve);

        // Auto-transition: if threshold met, mark Approved and emit MergeApproved
        if (p.approvalCount >= approvalThreshold) {
            p.state = ProposalState.Approved;
            emit MergeApproved(proposalId, p.branchName, p.commitHash);
        }
    }

    /// @notice Record the merged commit hash after the bridge executes the merge.
    ///         Can be called by anyone (the bridge uses wallet 0).
    function recordMerge(
        uint256 proposalId,
        string calldata mergedCommitHash
    ) external {
        require(proposalId < proposalCount, "ProposalManager: invalid id");
        Proposal storage p = _proposals[proposalId];
        require(p.state == ProposalState.Approved, "ProposalManager: not approved");
        require(bytes(mergedCommitHash).length > 0, "ProposalManager: empty hash");

        p.state = ProposalState.Merged;
        p.mergedCommitHash = mergedCommitHash;

        emit MergeRecorded(proposalId, mergedCommitHash);
    }

    /// @notice Returns the flat ProposalInfo for a given ID.
    function getProposal(uint256 proposalId)
        external
        view
        returns (ProposalInfo memory)
    {
        require(proposalId < proposalCount, "ProposalManager: invalid id");
        Proposal storage p = _proposals[proposalId];
        return ProposalInfo({
            id: p.id,
            repoId: p.repoId,
            branchName: p.branchName,
            commitHash: p.commitHash,
            description: p.description,
            proposer: p.proposer,
            state: p.state,
            approvalCount: p.approvalCount,
            rejectionCount: p.rejectionCount,
            mergedCommitHash: p.mergedCommitHash
        });
    }

    /// @notice Returns true if the voter has voted on the proposal.
    function hasVoted(uint256 proposalId, address voter)
        external
        view
        returns (bool)
    {
        return _votes[proposalId][voter];
    }
}
