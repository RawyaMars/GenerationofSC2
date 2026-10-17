
pragma solidity ^0.8.19;

contract CCGD {
    event ProcessStartRecorded(bytes32 indexed processId, bytes32 startMsgId, uint256 tau);
    event ProcessEndRecorded(bytes32 indexed processId, bytes32 endMsgId, uint256 tau, uint256 duration);
    event CCGDViolation(bytes32 indexed processId, uint256 duration, uint256 globalDeadline);

    struct CCGDState {
        bytes32 startMsgId;
        uint256 startTau;
        bool    started;
        bool    ended;
    }


    mapping(bytes32 => CCGDState) public processes;


    function withinGlobalDeadline(uint256 startTau, uint256 endTau, uint256 D)
        internal
        pure
        returns (bool)
    {
        return (endTau - startTau) <= D;
    }


    function recordStart(bytes32 processId, bytes32 startMsgId, uint256 tau) external {
        require(!processes[processId].started, "process already started");
        require(tau != 0, "invalid tau");

        processes[processId] = CCGDState({
            startMsgId: startMsgId,
            startTau:   tau,
            started:    true,
            ended:      false
        });
        emit ProcessStartRecorded(processId, startMsgId, tau);
    }


    function recordEnd(
        bytes32 processId,
        bytes32 endMsgId,
        uint256 globalDeadline
    ) external returns (bool ok) {
        CCGDState storage ps = processes[processId];
        require(ps.started, "process not started");
        require(!ps.ended,  "process already ended");

        uint256 endTau = block.timestamp;
        ps.ended = true;
        uint256 duration = endTau - ps.startTau;
        emit ProcessEndRecorded(processId, endMsgId, endTau, duration);


        // Verification only: a violation is recorded, execution is not blocked.
        ok = withinGlobalDeadline(ps.startTau, endTau, globalDeadline);
        if (!ok) {
            emit CCGDViolation(processId, duration, globalDeadline);
        }
    }
}
