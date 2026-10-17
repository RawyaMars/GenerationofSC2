'use strict';

const indent = (n, s) => s.split('\n').map(l => (l ? ' '.repeat(n) + l : '')).join('\n');
const I4  = s => indent(4,  s);
const I8  = s => indent(8,  s);

function taskFnName(task) {
  const base = task.id.replace(/^Task_/, '');
  return 'execute' + base;
}

function saBitName(task) {
  return 'SA_' + task.id.replace(/^Task_/, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}

function genImports(model) {
  const lines = [
    'import "../caterpillar/AbstractProcess.sol";',
  ];




  if (model.subContracts.some(s => s.cprParam)) {
    lines.push('import "../level3/ICPRRegistry.sol";');
  }
  const seenImports = new Set();
  model.subContracts.forEach(s => {
    const key = `${s.importPath}/${s.contractName}`;
    if (seenImports.has(key)) return;
    seenImports.add(key);
    const dir = s.importPath === '.' ? '' : `${s.importPath}/`;
    lines.push(`import "../${dir}${s.contractName}.sol";`);
  });
  return lines.join('\n');
}

function genEdgeBits(model) {
  const seen = new Set();
  model.tasks.forEach(t => {
    if (t.inFlow  && t.inFlow  !== 'end') seen.add(parseInt(t.inFlow));
    if (t.outFlow && t.outFlow !== 'end') seen.add(parseInt(t.outFlow));
  });
  return [...seen].sort((a, b) => a - b)
    .map(n => `    uint256 private constant E${n} = 1 << ${n};`)
    .join('\n');
}

function genSaBits(model) {
  return model.tasks.map(t =>
    `    uint256 private constant ${saBitName(t)} = 1 << ${t.bitIndex};`
  ).join('\n');
}

function genOrgVars(model) {
  return model.ctorParams
    .filter(p => p.type === 'address' && p.name !== '_cpr')
    .map(p => `    address public ${p.name.replace(/^_/, '')};`)
    .join('\n');
}

function genSubContractVars(model) {
  return model.subContracts.map(s =>
    `    ${s.contractName}  public immutable ${s.id};`
  ).join('\n');
}

function genMsgIdVars(model) {
  const msgIds = new Set();
  model.tasks.forEach(t =>
    t.constraints.forEach(c => {
      if (c.cprMsgParam) msgIds.add(c.cprMsgParam);
    })
  );
  if (model.compensation) {
    model.compensation.constraints.forEach(c => {
      if (c.failureMsgParam)       msgIds.add(c.failureMsgParam);
      if (c.compensationMsgParam)  msgIds.add(c.compensationMsgParam);
      if (c.doneMsgParam)          msgIds.add(c.doneMsgParam);
    });
  }
  return [...msgIds].map(id => `    bytes32 public ${id};`).join('\n');
}

function genConstructor(model) {

  const allParams = [
    'address _parent',
    'address _worklist',
    'address _processRegistry',
    ...model.ctorParams.map(p => `${p.type} ${p.name}`),
  ];

  const orgAssignments = model.ctorParams
    .filter(p => p.type === 'address' && p.name !== '_cpr')
    .map(p => `        ${p.name.replace(/^_/, '')} = ${p.name};`);

  const subContractDeployments = model.subContracts.map(s => {
    const lines = [`        ${s.id} = new ${s.contractName}(${s.cprParam || ''});`];
    if (s.initGate) {
      lines.push(`        {`);
      lines.push(`            bytes32[] memory _orgs = new bytes32[](${s.initGate.orgs.length});`);
      s.initGate.orgs.forEach((o, i) =>
        lines.push(`            _orgs[${i}] = keccak256(abi.encodePacked(${o}));`)
      );
      lines.push(`            ${s.id}.initGate(_pid, _orgs, ${s.initGate.maxWait});`);
      lines.push(`        }`);
    }
    return lines.join('\n');
  });

  return `    constructor(
        ${allParams.join(',\n        ')}
    ) AbstractProcess(_parent, _worklist, _processRegistry) {
        bytes32 _pid = bytes32(uint256(uint160(address(this))));
        _instanceId = _pid;
${orgAssignments.join('\n')}
${subContractDeployments.join('\n')}
    }`;
}

function genStartExecution(model) {
  const firstTask = model.tasks.find(t => t.inFlow === '0');
  const firstTaskName = firstTask ? firstTask.name : 'Task0';
  return `    function startExecution() public override {
        require(msg.sender == owner || msg.sender == parent, "Only owner/parent");
        require(marking == 0, "Already started");
        marking = E0;
        emit ProcessStarted(address(this), marking);
        emit ActivityEnabled("${firstTaskName}", marking);
    }`;
}

const EMITTER_ONLY_ROLE = { CID: 'send', CBTD: 'orgA', CCGD: 'start', NRD: 'send', CECW: 'offer' };

function needsTauParam(c, model) {
  if (!c.cprMsgParam || !c.subContractRef) return false;
  const sub = model.subContracts.find(s => s.id === c.subContractRef);
  if (!sub || sub.cprParam) return false;
  const emitterRole = EMITTER_ONLY_ROLE[c.def];
  if (emitterRole !== undefined) return c.role === emitterRole;
  return true;
}

function resolveCall(call, task, model) {

  let expr = call.replace(/\binstanceId\b/g, '_instanceId');




  task.extraParams.forEach(p => {
    const re = new RegExp(`\\b${p.name}\\b`, 'g');
    expr = expr.replace(re, `_${p.name}`);
  });


  const tauNames = new Set(
    task.constraints.filter(c => needsTauParam(c, model)).map(c => c.cprMsgParam)
  );
  tauNames.forEach(p => {
    const re = new RegExp(`\\btau_${p}\\b`, 'g');
    expr = expr.replace(re, `_tau_${p}`);
  });

  return expr;
}

function genConstraintCalls(task, model) {
  const lines = [];
  for (const c of task.constraints) {
    if (!c.call) continue;
    const callExpr = resolveCall(c.call, task, model);
    if (c.enforcement === 'hard') {
      lines.push(`        ${callExpr};`);
    } else if (c.enforcement === 'soft') {
      lines.push(`        ${callExpr}; // advisory: state persists on violation`);
    } else if (c.enforcement === 'verify') {
      lines.push(`        ${callExpr}; // verification only: violation recorded, execution continues`);
    } else if (c.enforcement === 'hard-via-wrapper') {
      lines.push(`        { bool _ok = ${callExpr}; require(_ok, "${c.def}: constraint violated"); }`);
    }
  }
  return lines.join('\n');
}

function genCrossChainTriggers(task) {
  const seen = new Set();
  const lines = [];
  task.constraints.forEach(c => {
    if (!c.cprMsgParam) return;
    const key = `${c.def}:${c.cprMsgParam}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`        emit CrossBlockchainInteractionTriggered(_instanceId, "${c.def}", ${c.cprMsgParam}, block.timestamp);`);
  });
  return lines.join('\n');
}

function genMsgIdSave(task) {
  const saved = new Set();
  const lines = [];
  task.constraints.forEach(c => {
    if (c.cprMsgParam && !saved.has(c.cprMsgParam)) {
      lines.push(`        ${c.cprMsgParam} = _${c.cprMsgParam};`);
      saved.add(c.cprMsgParam);
    }
  });
  return lines.join('\n');
}

function genTaskFunction(task, model) {
  const fnName = taskFnName(task);
  const inBit  = `E${task.inFlow}`;
  const outBit = task.outFlow === 'end' ? null : `E${task.outFlow}`;
  const saName = saBitName(task);


  const accessCheck = task.executedBy !== 'any'
    ? `        require(msg.sender == ${task.executedBy}, "Only ${task.executedBy}");\n`
    : '';


  const extraParamStr = task.extraParams.length
    ? task.extraParams.map(p => `${p.type} _${p.name}`).join(', ')
    : '';


  const cprParams = [...new Set(task.constraints
    .filter(c => c.cprMsgParam)
    .map(c => c.cprMsgParam))];
  const cprParamStr = cprParams.map(p => `bytes32 _${p}`).join(', ');



  const tauParams = [...new Set(task.constraints
    .filter(c => needsTauParam(c, model))
    .map(c => c.cprMsgParam))];
  const tauParamStr = tauParams.map(p => `uint256 _tau_${p}`).join(', ');

  const allParamsStr = [cprParamStr, tauParamStr, extraParamStr].filter(Boolean).join(', ');


  const isTerminal = !task.outFlow || task.outFlow === 'end';
  const tokenMove = task.noTokenMove
    ? '// no token move (concurrent completion)'
    : (isTerminal
        ? `marking = marking & ~${inBit};`
        : `marking = (marking & ~${inBit}) | ${outBit};`);

  const completion = isTerminal
    ? `        emit ActivityCompleted("${task.name}", msg.sender, marking);\n        _checkProcessEnd();`
    : `        emit ActivityCompleted("${task.name}", msg.sender, marking);\n        step();`;


  const saveMsgIds = genMsgIdSave(task);
  const crossChainTriggers = genCrossChainTriggers(task);
  const constraintCalls = genConstraintCalls(task, model);

  return `    // ── ${task.name} ──────────────────────────────────────────────────
    function ${fnName}(${allParamsStr}) external {
${accessCheck}        require(marking & ${inBit} != 0, "Precondition ${inBit} not met");
        startedActivities |= ${saName};
        emit ActivityStarted("${task.name}", msg.sender, marking);
${saveMsgIds ? '\n' + saveMsgIds : ''}
${crossChainTriggers ? '\n' + crossChainTriggers : ''}
${constraintCalls ? '\n' + constraintCalls : ''}
        ${tokenMove}
        startedActivities &= ~${saName};
${completion}
    }`;
}

function genCompensationFunctions(comp) {
  if (!comp) return '';
  const c = comp.constraints.find(x => x.def === 'CCCW');
  if (!c) return '';





  return `
    // ── Cold-chain compensation (CCCW) ──────────────────────────────────────
    function reportFailure(bytes32 _${c.failureMsgParam}, uint256 _tau_${c.failureMsgParam}) external {
        ${c.failureMsgParam} = _${c.failureMsgParam};
        cccw.recordFailure(_instanceId, _${c.failureMsgParam}, _tau_${c.failureMsgParam}, ${c.maxCompTime});
    }

    function startCompensation(bytes32 _${c.compensationMsgParam}, uint256 _tau_${c.compensationMsgParam}) external {
        // Verification only: a late start is recorded by CCCW, not reverted.
        cccw.startCompensation(_instanceId, _${c.compensationMsgParam}, _tau_${c.compensationMsgParam});
    }

    function completeCompensation(bytes32 _${c.doneMsgParam}, uint256 _tau_${c.doneMsgParam}) external {
        cccw.completeCompensation(_instanceId, _${c.doneMsgParam}, _tau_${c.doneMsgParam});
    }`;
}

function genOverrides(model) {
  const lastTask = model.tasks[model.tasks.length - 1];
  const lastBit  = lastTask ? `E${lastTask.outFlow !== 'end' ? lastTask.outFlow : lastTask.inFlow}` : 'E4';

  return `
    // ── AbstractProcess required overrides ──────────────────────────────────

    function handleEvent(
        bytes32 /*code*/,
        bytes32 /*eventType*/,
        uint256 /*_instanceIndex*/,
        bool    isInstanceCompleted
    ) public override {
        if (isInstanceCompleted) _checkProcessEnd();
    }

    function killProcess() public override {
        require(msg.sender == owner || msg.sender == parent, "Only owner/parent");
        (marking, startedActivities) = killProcess(0, marking, startedActivities);
    }

    function killProcess(
        uint256 /*elementIndex*/,
        uint256 _marking,
        uint256 _started
    ) internal override returns (uint256, uint256) {
        emit ProcessEnded(address(this), "Killed");
        return (0, 0);
    }

    function broadcastSignal(
        uint256 tmpMarking,
        uint256 tmpStarted,
        uint256 /*sourceChild*/
    ) internal override returns (uint256, uint256) {
        return (tmpMarking, tmpStarted);
    }

    function step() internal {
        // No auto-fire gateways in this linear process.
        // Extend here for XOR/AND gateways.
    }

    function _checkProcessEnd() internal {
        if (marking == 0 && startedActivities == 0) {
            emit ProcessEnded(address(this), "Completed");
            if (parent != address(0))
                AbstractProcess(parent).handleEvent(
                    "ProcessCompleted", "Signal", instanceIndex, true);
        }
    }`;
}

function genEvents() {
  return `    event ProcessStarted(address indexed instance, uint256 initialMarking);
    event ActivityEnabled(string activityName, uint256 marking);
    event ActivityStarted(string activityName, address indexed performer, uint256 marking);
    event ActivityCompleted(string activityName, address indexed performer, uint256 newMarking);
    event ProcessEnded(address indexed instance, string outcome);
    event CrossBlockchainInteractionTriggered(bytes32 indexed processId, string def, bytes32 msgId, uint256 localTau);`;
}

function genProcessContract(model) {
  const sections = [
    `// SPDX-License-Identifier: MIT`,
    `// AUTO-GENERATED by caterpillar-temporal-codegen`,
    `// Source process: ${model.name || model.id}`,
    `// Caterpillar pattern: López-Pintado et al. SPE 2019`,
    `// Temporal extensions: Mars, Kallel, Cheikhrouhou 2024 (Definitions 8-14)`,
    `pragma solidity ^0.8.20;`,
    ``,
    genImports(model),
    ``,
    `contract ${model.id} is AbstractProcess {`,
    ``,
    `    // ── Petri-net state ──────────────────────────────────────────────────`,
    `    uint256 public marking;`,
    `    uint256 public startedActivities;`,
    `    bytes32 public _instanceId;`,
    ``,
    `    // ── Sequence-flow edge bits ──────────────────────────────────────────`,
    genEdgeBits(model),
    ``,
    `    // ── Task started-activity bits ───────────────────────────────────────`,
    genSaBits(model),
    ``,
    `    // ── Participant addresses ────────────────────────────────────────────`,
    genOrgVars(model),
    ``,
    `    // ── Level-3 temporal constraint sub-contracts ────────────────────────`,
    genSubContractVars(model),
    ``,
    `    // ── CPR message IDs stored during execution ──────────────────────────`,
    genMsgIdVars(model),
    ``,
    `    // ── Events ──────────────────────────────────────────────────────────`,
    genEvents(),
    ``,
    genConstructor(model),
    ``,
    genStartExecution(model),
    ``,
    ...model.tasks.map(t => genTaskFunction(t, model)),
    genCompensationFunctions(model.compensation),
    genOverrides(model),
    `}`,
  ];
  return sections.join('\n');
}

function genFactory(model) {
  const orgCtorParams = model.ctorParams.filter(p => p.type === 'address');






  const orgParamsDecl = orgCtorParams.map(p => `,\n        ${p.type} ${p.name}`).join('');
  const orgArgsDecl = orgCtorParams.map(p => `,\n            ${p.name}`).join('');

  return `// SPDX-License-Identifier: MIT
// AUTO-GENERATED by caterpillar-temporal-codegen
pragma solidity ^0.8.20;

import "../caterpillar/AbstractFactory.sol";
import "./${model.id}.sol";

contract ${model.id}_Factory is AbstractFactory {

    address[] public instances;
    event InstanceCreated(address indexed instance, uint256 index);

    constructor() {}

    function newInstance(address _parent, address /*_globalFactory*/)
        public override returns (address)
    {
        revert("Use createInstance(...)");
    }

    function startInstanceExecution(address processAddress) public override {
        ${model.id}(processAddress).startExecution();
    }

    function createInstance(
        address _processRegistry${orgParamsDecl}
    ) external returns (address) {
        ${model.id} inst = new ${model.id}(
            address(0),
            worklist,
            _processRegistry${orgArgsDecl}
        );
        instances.push(address(inst));
        emit InstanceCreated(address(inst), instances.length - 1);
        return address(inst);
    }

    function instanceCount() external view returns (uint256) {
        return instances.length;
    }
}
`;
}

module.exports = { genProcessContract, genFactory };
