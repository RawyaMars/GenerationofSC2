
pragma solidity ^0.8.19;

contract CBTD {
    event OrgARefRecorded(bytes32 indexed processId, string variant, bytes32 msgId, uint256 tau);
    event OrgBRefRecorded(bytes32 indexed processId, string variant, bytes32 msgId, uint256 tau, uint256 gap);
    event CBTDViolation(bytes32 indexed processId, string variant, uint256 gap, uint256 minD, uint256 maxD);



    mapping(bytes32 => bytes32) public orgAMsgId;
    mapping(bytes32 => uint256) public orgATau;

    function _key(bytes32 processId, string memory variant)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(processId, variant));
    }


    function checkGap(uint256 refI, uint256 refJ, uint256 minD, uint256 maxD)
        internal
        pure
        returns (bool)
    {
        if (refJ < refI) return false;
        uint256 gap = refJ - refI;
        return gap >= minD && gap <= maxD;
    }


    function recordOrgARef(
        bytes32        processId,
        string calldata variant,
        bytes32        msgId,
        uint256        tau
    ) external {
        bytes32 k = _key(processId, variant);
        require(orgAMsgId[k] == bytes32(0), "OrgA ref already recorded");
        require(tau != 0, "invalid tau");
        orgAMsgId[k] = msgId;
        orgATau[k]   = tau;
        emit OrgARefRecorded(processId, variant, msgId, tau);
    }


    function recordOrgBRef(
        bytes32        processId,
        string calldata variant,
        bytes32        msgId,
        uint256        minD,
        uint256        maxD
    ) external returns (bool ok) {
        bytes32 k     = _key(processId, variant);
        bytes32 aMsgId = orgAMsgId[k];
        require(aMsgId != bytes32(0), "OrgA ref not yet recorded");

        uint256 tauB = block.timestamp;
        uint256 tauA = orgATau[k];
        uint256 gap = tauB >= tauA ? tauB - tauA : 0;
        emit OrgBRefRecorded(processId, variant, msgId, tauB, gap);


        // Verification only: a violation is recorded, execution is not blocked.
        ok = checkGap(tauA, tauB, minD, maxD);
        if (!ok) {
            emit CBTDViolation(processId, variant, gap, minD, maxD);
        }
    }
}
