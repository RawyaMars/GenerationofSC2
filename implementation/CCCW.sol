
pragma solidity ^0.8.19;

contract CCCW {
    enum CompState { ACTIVE, COMPENSATING, COMPLETED }

    event FailureRecorded(bytes32 indexed processId, bytes32 failureMsgId, uint256 tau, uint256 deadline);
    event CompensationStarted(bytes32 indexed processId, bytes32 compMsgId, uint256 tau);
    event CompensationCompleted(bytes32 indexed processId, bytes32 doneMsgId, uint256 tau);
    event CompensationWindowViolated(bytes32 indexed processId, uint256 failureTau, uint256 maxCompTime);

    struct CompRecord {
        bytes32   failureMsgId;
        uint256   failureTau;
        uint256   maxCompTime;
        CompState state;
        bool      violated;
    }


    mapping(bytes32 => CompRecord) public records;


    function withinCompWindow(uint256 failTau, uint256 compTau, uint256 maxT)
        internal
        pure
        returns (bool)
    {
        if (compTau < failTau) return false;
        return (compTau - failTau) <= maxT;
    }


    function recordFailure(
        bytes32 processId,
        bytes32 failureMsgId,
        uint256 failureTau,
        uint256 maxCompTime
    ) external {
        require(records[processId].state == CompState(0) &&
                records[processId].failureTau == 0,
                "already recorded");
        require(failureTau != 0, "invalid tau");

        records[processId] = CompRecord({
            failureMsgId: failureMsgId,
            failureTau:   failureTau,
            maxCompTime:  maxCompTime,
            state:        CompState.ACTIVE,
            violated:     false
        });
        emit FailureRecorded(processId, failureMsgId, failureTau, failureTau + maxCompTime);
    }




    function startCompensation(bytes32 processId, bytes32 compMsgId, uint256 compTau) external returns (bool) {
        CompRecord storage rec = records[processId];
        require(rec.state == CompState.ACTIVE, "not in ACTIVE state");
        require(compTau != 0, "invalid tau");


        // Verification only: a late compensation is recorded but still proceeds.
        bool ok = withinCompWindow(rec.failureTau, compTau, rec.maxCompTime);
        if (!ok && !rec.violated) {
            rec.violated = true;
            emit CompensationWindowViolated(processId, rec.failureTau, rec.maxCompTime);
        }

        rec.state = CompState.COMPENSATING;
        emit CompensationStarted(processId, compMsgId, compTau);
        return ok;
    }


    function completeCompensation(bytes32 processId, bytes32 doneMsgId, uint256 doneTau) external {
        CompRecord storage rec = records[processId];
        require(rec.state == CompState.COMPENSATING, "not in COMPENSATING state");
        require(doneTau != 0, "invalid tau");

        rec.state = CompState.COMPLETED;
        emit CompensationCompleted(processId, doneMsgId, doneTau);
    }


    function checkWindow(bytes32 processId, uint256 nowTau) external {
        CompRecord storage rec = records[processId];
        require(rec.state == CompState.ACTIVE, "not active");

        if (nowTau > rec.failureTau + rec.maxCompTime && !rec.violated) {
            rec.violated = true;
            emit CompensationWindowViolated(processId, rec.failureTau, rec.maxCompTime);
        }
    }

    function getState(bytes32 processId) external view returns (CompState) {
        return records[processId].state;
    }

    function isViolated(bytes32 processId) external view returns (bool) {
        return records[processId].violated;
    }
}
