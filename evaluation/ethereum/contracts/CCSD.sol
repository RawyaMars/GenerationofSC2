
pragma solidity ^0.8.19;

contract CCSD {
    event OrgSynced(bytes32 indexed processId, bytes32 indexed orgId, bytes32 msgId, uint256 tau);
    event SyncFired(bytes32 indexed processId, uint256 firedAt);
    event SyncAborted(bytes32 indexed processId, string reason);

    struct CCSDGate {
        uint256   firstCompletionTau;
        uint256   maxWait;
        uint256   requiredCount;
        uint256   completedCount;
        bool      fired;
        bool      aborted;
        bool      initialised;
        mapping(bytes32 => bool) required;
        mapping(bytes32 => bool) completed;
    }


    mapping(bytes32 => CCSDGate) private gates;


    function initGate(
        bytes32          processId,
        bytes32[] calldata orgIds,
        uint256          maxWait
    ) external {
        CCSDGate storage g = gates[processId];
        require(!g.initialised,     "already initialised");
        require(orgIds.length > 0,  "at least one org required");

        g.maxWait       = maxWait;
        g.requiredCount = orgIds.length;
        g.initialised   = true;

        for (uint256 i = 0; i < orgIds.length; i++) {
            g.required[orgIds[i]] = true;
        }
    }


    function withinWindow(uint256 firstTau, uint256 thisTau, uint256 maxWait)
        internal
        pure
        returns (bool)
    {
        return thisTau <= firstTau + maxWait;
    }


    function markComplete(
        bytes32 processId,
        bytes32 orgId,
        bytes32 msgId,
        uint256 tau
    ) external {
        CCSDGate storage g = gates[processId];
        require(g.initialised,           "not initialised");
        require(!g.fired,                "sync already fired");
        require(!g.aborted,              "sync aborted");
        require(g.required[orgId],       "org is not a required participant");
        require(!g.completed[orgId],     "org already completed");
        require(tau != 0,                "invalid tau");


        if (g.firstCompletionTau == 0) {
            g.firstCompletionTau = tau;
        }

        emit OrgSynced(processId, orgId, msgId, tau);


        if (!withinWindow(g.firstCompletionTau, tau, g.maxWait)) {
            g.aborted = true;
            emit SyncAborted(processId, "org exceeded maxWait");
            require(false, "CCSD: org completion outside sync window");
        }

        g.completed[orgId] = true;
        g.completedCount  += 1;

        if (g.completedCount == g.requiredCount) {
            g.fired = true;
            emit SyncFired(processId, tau);
        }
    }


    function checkExpiry(bytes32 processId, uint256 nowTau) external {
        CCSDGate storage g = gates[processId];
        require(g.initialised, "not initialised");
        if (g.fired || g.aborted || g.firstCompletionTau == 0) return;

        if (nowTau > g.firstCompletionTau + g.maxWait) {
            g.aborted = true;
            emit SyncAborted(processId, "maxWait expired without all orgs");
        }
    }


    function isFired(bytes32 processId)   external view returns (bool) { return gates[processId].fired; }
    function isAborted(bytes32 processId) external view returns (bool) { return gates[processId].aborted; }
    function completedCount(bytes32 processId) external view returns (uint256) { return gates[processId].completedCount; }
}
