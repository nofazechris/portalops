// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PortalBounty: post a task, submit work, approve it. A four-step lifecycle that makes a good webhook story.
/// @notice Demo only. It holds no value: rewards are recorded as numbers in events, like PortalQuest.
contract PortalBounty {
    enum Status { None, Open, Submitted, Approved, Cancelled }

    struct Bounty {
        address poster;
        address hunter;
        uint256 reward;
        Status status;
    }

    uint256 public bountyCount;
    uint256 public constant MAX_TEXT_BYTES = 140;
    mapping(uint256 => Bounty) public bounties;

    event BountyPosted(uint256 indexed bountyId, address indexed poster, string title, uint256 reward);
    event WorkSubmitted(uint256 indexed bountyId, address indexed hunter, string proof);
    event BountyApproved(uint256 indexed bountyId, address indexed hunter, uint256 reward);
    event BountyCancelled(uint256 indexed bountyId, address indexed poster);

    error TextTooLong();
    error UnknownBounty();
    error WrongStatus();
    error NotPoster();
    error PosterCannotSubmit();

    function postBounty(string calldata title, uint256 reward) external returns (uint256 bountyId) {
        if (bytes(title).length > MAX_TEXT_BYTES) revert TextTooLong();
        bountyId = ++bountyCount;
        bounties[bountyId] = Bounty({poster: msg.sender, hunter: address(0), reward: reward, status: Status.Open});
        emit BountyPosted(bountyId, msg.sender, title, reward);
    }

    function submitWork(uint256 bountyId, string calldata proof) external {
        Bounty storage b = _get(bountyId);
        if (b.status != Status.Open) revert WrongStatus();
        if (b.poster == msg.sender) revert PosterCannotSubmit();
        if (bytes(proof).length > MAX_TEXT_BYTES) revert TextTooLong();
        b.hunter = msg.sender;
        b.status = Status.Submitted;
        emit WorkSubmitted(bountyId, msg.sender, proof);
    }

    function approve(uint256 bountyId) external {
        Bounty storage b = _get(bountyId);
        if (b.poster != msg.sender) revert NotPoster();
        if (b.status != Status.Submitted) revert WrongStatus();
        b.status = Status.Approved;
        emit BountyApproved(bountyId, b.hunter, b.reward);
    }

    function cancel(uint256 bountyId) external {
        Bounty storage b = _get(bountyId);
        if (b.poster != msg.sender) revert NotPoster();
        if (b.status != Status.Open) revert WrongStatus();
        b.status = Status.Cancelled;
        emit BountyCancelled(bountyId, msg.sender);
    }

    function _get(uint256 bountyId) private view returns (Bounty storage b) {
        b = bounties[bountyId];
        if (b.status == Status.None) revert UnknownBounty();
    }
}
