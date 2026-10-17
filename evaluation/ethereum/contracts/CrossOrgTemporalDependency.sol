
pragma solidity ^0.8.19;

contract CrossOrgTemporalDependency {
    event OrgARegistered(bytes32 indexed processId, address orgA);
    event OrgBRegistered(bytes32 indexed processId, address orgB);
    event RefPointStored(bytes32 indexed processId, string role, string variant, uint256 ts);
    event DesignerNotified(bytes32 indexed processId, string variant, string reason);

    struct ProcessOrgs {
        address orgA;
        address orgB;
    }


    mapping(bytes32 => ProcessOrgs)   public processOrgs;
    mapping(bytes32 => uint256)        public orgA_startTime;
    mapping(bytes32 => uint256)        public orgA_endTime;
    mapping(bytes32 => uint256)        public orgB_startTime;
    mapping(bytes32 => uint256)        public orgB_endTime;

    modifier onlyOrgA(bytes32 processId) {
        require(processOrgs[processId].orgA == msg.sender, "caller is not OrgA");
        _;
    }

    modifier onlyOrgB(bytes32 processId) {
        require(processOrgs[processId].orgB == msg.sender, "caller is not OrgB");
        _;
    }


    function registerOrgA(bytes32 processId) external {
        require(processOrgs[processId].orgA == address(0), "OrgA already registered");
        processOrgs[processId].orgA = msg.sender;
        emit OrgARegistered(processId, msg.sender);
    }

    function registerOrgB(bytes32 processId) external {
        require(processOrgs[processId].orgB == address(0), "OrgB already registered");
        processOrgs[processId].orgB = msg.sender;
        emit OrgBRegistered(processId, msg.sender);
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


    function orgA_finish_FS(bytes32 processId) external onlyOrgA(processId) {
        orgA_endTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgA", "FS", block.timestamp);
    }

    function orgB_start_FS(bytes32 processId, uint256 minD, uint256 maxD)
        external
        onlyOrgB(processId)
    {
        orgB_startTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgB", "FS", block.timestamp);


        if (!checkGap(orgA_endTime[processId], block.timestamp, minD, maxD)) {
            notifyDesigner(processId, "FS", "Cross-org FS constraint violated");
        }
    }


    function orgA_start_SS(bytes32 processId) external onlyOrgA(processId) {
        orgA_startTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgA", "SS", block.timestamp);
    }

    function orgB_start_SS(bytes32 processId, uint256 minD, uint256 maxD)
        external
        onlyOrgB(processId)
    {
        orgB_startTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgB", "SS", block.timestamp);


        if (!checkGap(orgA_startTime[processId], block.timestamp, minD, maxD)) {
            notifyDesigner(processId, "SS", "Cross-org SS constraint violated");
        }
    }


    function orgA_finish_FF(bytes32 processId) external onlyOrgA(processId) {
        orgA_endTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgA", "FF", block.timestamp);
    }

    function orgB_finish_FF(bytes32 processId, uint256 minD, uint256 maxD)
        external
        onlyOrgB(processId)
    {
        orgB_endTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgB", "FF", block.timestamp);


        if (!checkGap(orgA_endTime[processId], block.timestamp, minD, maxD)) {
            notifyDesigner(processId, "FF", "Cross-org FF constraint violated");
        }
    }


    function orgA_start_SF(bytes32 processId) external onlyOrgA(processId) {
        orgA_startTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgA", "SF", block.timestamp);
    }

    function orgB_finish_SF(bytes32 processId, uint256 minD, uint256 maxD)
        external
        onlyOrgB(processId)
    {
        orgB_endTime[processId] = block.timestamp;
        emit RefPointStored(processId, "OrgB", "SF", block.timestamp);


        if (!checkGap(orgA_startTime[processId], block.timestamp, minD, maxD)) {
            notifyDesigner(processId, "SF", "Cross-org SF constraint violated");
        }
    }

    function notifyDesigner(bytes32 processId, string memory variant, string memory reason)
        internal
    {
        emit DesignerNotified(processId, variant, reason);
    }
}
