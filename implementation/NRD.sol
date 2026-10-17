
pragma solidity ^0.8.19;

contract NRD {
    enum AckState { PENDING, ACKNOWLEDGED, EVIDENCE_ISSUED }

    event SendRecorded(bytes32 indexed messageId, bytes32 sendMsgId, uint256 tau, uint256 deadline);
    event AckRecorded(bytes32 indexed messageId, bytes32 ackMsgId, uint256 tau, uint256 lag);
    event NonReceiptEvidence(
        bytes32 indexed messageId,
        bytes32         sendMsgId,
        uint256         sendTau,
        uint256         maxAckTime,
        uint256         evidenceTimestamp
    );

    struct NRDRecord {
        bytes32  sendMsgId;
        uint256  sendTau;
        uint256  maxAckTime;
        AckState state;
    }


    mapping(bytes32 => NRDRecord) public nrdRecords;


    function withinAckWindow(uint256 sendTau, uint256 ackTau, uint256 maxT)
        internal
        pure
        returns (bool)
    {
        if (ackTau < sendTau) return false;
        return (ackTau - sendTau) <= maxT;
    }


    function registerSend(
        bytes32 messageId,
        bytes32 sendMsgId,
        uint256 sendTau,
        uint256 maxAckTime
    ) external {
        require(nrdRecords[messageId].sendTau == 0, "already registered");
        require(sendTau != 0, "invalid tau");

        nrdRecords[messageId] = NRDRecord({
            sendMsgId:  sendMsgId,
            sendTau:    sendTau,
            maxAckTime: maxAckTime,
            state:      AckState.PENDING
        });
        emit SendRecorded(messageId, sendMsgId, sendTau, sendTau + maxAckTime);
    }




    function registerAck(bytes32 messageId, bytes32 ackMsgId) external returns (bool) {
        NRDRecord storage rec = nrdRecords[messageId];
        require(rec.state == AckState.PENDING, "not pending");
        uint256 ackTau = block.timestamp;


        if (!withinAckWindow(rec.sendTau, ackTau, rec.maxAckTime)) {
            rec.state = AckState.EVIDENCE_ISSUED;
            emit NonReceiptEvidence(
                messageId,
                rec.sendMsgId,
                rec.sendTau,
                rec.maxAckTime,
                block.timestamp
            );
            return false;
        }

        rec.state = AckState.ACKNOWLEDGED;
        emit AckRecorded(messageId, ackMsgId, ackTau, ackTau - rec.sendTau);
        return true;
    }


    function claimNonReceipt(bytes32 messageId, uint256 nowTau) external {
        NRDRecord storage rec = nrdRecords[messageId];
        require(rec.state == AckState.PENDING, "not pending");
        require(nowTau > rec.sendTau + rec.maxAckTime, "window not yet expired");

        rec.state = AckState.EVIDENCE_ISSUED;
        emit NonReceiptEvidence(
            messageId,
            rec.sendMsgId,
            rec.sendTau,
            rec.maxAckTime,
            block.timestamp
        );
    }

    function getState(bytes32 messageId) external view returns (AckState) {
        return nrdRecords[messageId].state;
    }
}
