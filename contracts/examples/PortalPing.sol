// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A tiny demo contract for PortalOps. Anyone can `ping` with a note or record a `milestone`;
/// each call emits an event, so you can watch PortalOps capture and decode them live.
contract PortalPing {
    uint256 public total;

    event Ping(address indexed from, uint256 indexed seq, string note);

    function ping(string calldata note) external returns (uint256 seq) {
        seq = ++total;
        emit Ping(msg.sender, seq, note);
    }
}
