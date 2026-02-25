// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReviewerRegistry
/// @notice Maps wallet addresses to agent identities for the gitchain system.
///         Only the owner (deployer) can register or remove reviewers.
contract ReviewerRegistry {
    struct Agent {
        string name;
        string publicKey;
        bool isActive;
    }

    address public owner;
    mapping(address => Agent) private _agents;
    address[] private _reviewerList;

    event ReviewerRegistered(address indexed wallet, string name);
    event ReviewerRemoved(address indexed wallet);

    modifier onlyOwner() {
        require(msg.sender == owner, "ReviewerRegistry: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Register a new reviewer. Only callable by owner.
    function registerReviewer(
        address wallet,
        string calldata name,
        string calldata publicKey
    ) external onlyOwner {
        require(wallet != address(0), "ReviewerRegistry: zero address");
        require(bytes(name).length > 0, "ReviewerRegistry: empty name");
        require(!_agents[wallet].isActive, "ReviewerRegistry: already registered");

        _agents[wallet] = Agent({ name: name, publicKey: publicKey, isActive: true });
        _reviewerList.push(wallet);

        emit ReviewerRegistered(wallet, name);
    }

    /// @notice Deactivate a reviewer. Only callable by owner.
    function removeReviewer(address wallet) external onlyOwner {
        require(_agents[wallet].isActive, "ReviewerRegistry: not a reviewer");
        _agents[wallet].isActive = false;
        emit ReviewerRemoved(wallet);
    }

    /// @notice Returns true if the address is an active reviewer.
    function isReviewer(address wallet) external view returns (bool) {
        return _agents[wallet].isActive;
    }

    /// @notice Returns the agent struct for a wallet.
    function getReviewer(address wallet) external view returns (Agent memory) {
        return _agents[wallet];
    }

    /// @notice Returns all ever-registered reviewer addresses (including inactive).
    function getReviewerList() external view returns (address[] memory) {
        return _reviewerList;
    }
}
