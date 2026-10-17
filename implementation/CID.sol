// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title CID — Definition 8: Cross-Chain Interaction Deadline
/// tau_CPR(receive) - tau_CPR(send) <= MaxD
///
/// Verification only: a missed deadline is recorded (CIDViolation + return
/// value), the receive event is never blocked.
///
/// The emitter (registerSend) receives tau_CPR as a parameter, already
/// resolved off-chain by the Cross-ZID client, since its event may
/// originate on a different chain. The receiver (registerReceive) reads
/// its own local chain clock (block.timestamp) directly: it always
/// executes live, on whichever chain hosts it, at the moment of its own
/// event — no ICPRRegistry dependency on either side. See
/// docs/implementation_section.tex, "Ce que recouvre concretement le
/// registre de preuves", for the architectural discussion.
contract CID {
    event SendRegistered(bytes32 indexed processId, bytes32 sendMsgId, uint256 tauCPR);
    event ReceiveRegistered(bytes32 indexed processId, bytes32 recvMsgId, uint256 tauCPR, uint256 lag);
    event CIDViolation(bytes32 indexed processId, uint256 lag, uint256 maxD);

    // timer variable: send-event CPR message id and tau per process
    mapping(bytes32 => bytes32) public sendMsgId;
    mapping(bytes32 => uint256) public sendTau;

    // ── Timer Function ────────────────────────────────────────────────────────
    function checkCID(uint256 tauSend, uint256 tauRecv, uint256 maxD)
        internal
        pure
        returns (bool)
    {
        if (tauRecv < tauSend) return false;
        return (tauRecv - tauSend) <= maxD;
    }

    // ── Step 1 (emitter): record send event, tau received as parameter ───────
    function registerSend(bytes32 processId, bytes32 _sendMsgId, uint256 tauSend) external {
        require(sendMsgId[processId] == bytes32(0), "send already registered");
        require(tauSend != 0, "invalid tau");
        sendMsgId[processId] = _sendMsgId;
        sendTau[processId] = tauSend;
        emit SendRegistered(processId, _sendMsgId, tauSend);
    }

    // ── Step 2 (receiver) + Timer Guard: local clock, verification only ──────
    function registerReceive(
        bytes32 processId,
        bytes32 recvMsgId,
        uint256 maxD
    ) external returns (bool ok) {
        bytes32 sid = sendMsgId[processId];
        require(sid != bytes32(0), "send not registered");

        uint256 tauRecv = block.timestamp;
        uint256 tauSend = sendTau[processId];
        uint256 lag = tauRecv >= tauSend ? tauRecv - tauSend : 0;
        emit ReceiveRegistered(processId, recvMsgId, tauRecv, lag);

        // ── Timer Guard (verification only) ───────────────────────────────────
        ok = checkCID(tauSend, tauRecv, maxD);
        if (!ok) {
            emit CIDViolation(processId, lag, maxD);
        }
    }
}
