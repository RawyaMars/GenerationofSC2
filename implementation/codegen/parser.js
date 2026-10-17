'use strict';

const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

const NS = {
  bpmn:        'http://www.omg.org/spec/BPMN/20100524/MODEL',
  caterpillar: 'http://caterpillar.blockchain/bpmn',
  temporal:    'http://iobp.temporal-constraints/bpmn/level3',
};

const select = xpath.useNamespaces(NS);

function attr(node, name) {
  if (!node) return null;



  return node.hasAttribute(name) ? node.getAttribute(name) : null;
}

function nsattr(node, ns, localName) {
  return attr(node, `${ns}:${localName}`);
}

function parseNameType(raw) {
  if (!raw) return null;
  const [name, type] = raw.split(':');
  return { name: name.trim(), type: type.trim() };
}

// The five inter-organisational constraints of the thesis (§5.3.2) are
// verification-only: a violation is recorded, it never blocks execution.
// Cross-blockchain: CID, CBTD, NRD, CCGD, CCCW (and CCSD); mono-blockchain: COTD, GD.
const VERIFICATION_ONLY = new Set(['CID', 'CBTD', 'NRD', 'CCSD', 'CCGD', 'CCCW', 'COTD', 'GD']);

function parseConstraint(el) {
  const def = attr(el, 'def');
  return {
    def,
    variant:       attr(el, 'variant'),
    role:          attr(el, 'role'),
    subContractRef:attr(el, 'subContractRef'),
    cprMsgParam:   attr(el, 'cprMsgParam'),
    enforcement:   VERIFICATION_ONLY.has(def) ? 'verify' : (attr(el, 'enforcement') || 'hard'),
    call:          attr(el, 'call'),
    functionParam: attr(el, 'functionParam'),
    minD:          attr(el, 'minD'),
    maxD:          attr(el, 'maxD'),
    globalDeadline:attr(el, 'globalDeadline'),
    maxCompTime:   attr(el, 'maxCompTime'),
    orgExpr:       attr(el, 'orgExpr'),
    failureMsgParam:     attr(el, 'failureMsgParam'),
    compensationMsgParam:attr(el, 'compensationMsgParam'),
    doneMsgParam:        attr(el, 'doneMsgParam'),
  };
}

function parseSubContracts(processEl) {
  const subs = select('.//temporal:subContract', processEl);
  return subs.map(el => {
    const initGateEl = select('temporal:ccsdInitGate', el)[0] || null;
    return {
      id:           attr(el, 'id'),
      contractName: attr(el, 'contractName'),






      cprParam:     attr(el, 'cprParam'),






      importPath:   attr(el, 'importPath') || 'level3',
      initGate: initGateEl ? {
        orgs:    attr(initGateEl, 'orgs').split(',').map(s => s.trim()),
        maxWait: attr(initGateEl, 'maxWait'),
      } : null,
    };
  });
}

function parseCtorParams(processEl) {
  const params = select('.//caterpillar:constructorParam', processEl);
  return params.map(el => ({
    name: attr(el, 'name'),
    type: attr(el, 'type'),
    description: attr(el, 'description') || '',
  }));
}

function parseTasks(processEl, defaultExecutedBy = 'any') {
  const tasks = select('bpmn:task', processEl);
  return tasks.map((el, idx) => {
    const constraints = select('.//temporal:constraint', el).map(parseConstraint);

    const extraParams = constraints
      .filter(c => c.functionParam)
      .map(c => parseNameType(c.functionParam));

    return {
      id:          attr(el, 'id'),
      name:        attr(el, 'name'),
      inFlow:      nsattr(el, 'caterpillar', 'inFlow'),
      outFlow:     nsattr(el, 'caterpillar', 'outFlow'),
      executedBy:  nsattr(el, 'caterpillar', 'executedBy') || defaultExecutedBy,
      noTokenMove: nsattr(el, 'caterpillar', 'noTokenMove') === 'true',
      bitIndex:    idx,
      constraints,
      extraParams,
    };
  });
}

function parseCompensationSubprocess(processEl) {
  const subs = select('bpmn:subProcess[@isForCompensation="true"]', processEl);
  if (!subs.length) return null;
  const el = subs[0];
  const constraints = select('.//temporal:constraint', el).map(parseConstraint);
  return {
    id:          attr(el, 'id'),
    name:        attr(el, 'name'),
    constraints,
  };
}

function parseSequenceFlows(processEl) {
  const flows = select('bpmn:sequenceFlow', processEl);
  return flows.map(el => ({
    id:        attr(el, 'id'),
    sourceRef: attr(el, 'sourceRef'),
    targetRef: attr(el, 'targetRef'),




    condition: nsattr(el, 'caterpillar', 'condition'),
  }));
}

function parseGateways(processEl) {
  const gateways = select('bpmn:exclusiveGateway|bpmn:parallelGateway', processEl);
  return gateways.map(el => ({
    id:   attr(el, 'id'),
    name: attr(el, 'name'),
    type: el.localName === 'exclusiveGateway' ? 'exclusive' : 'parallel',




    decisionParam: parseNameType(nsattr(el, 'caterpillar', 'decisionParam')),
    defaultFlowId: attr(el, 'default'),
  }));
}

function buildFlowGraph(tasks, gateways, flows) {
  const incoming    = new Map();
  const outgoing     = new Map();
  const kind         = new Map();
  const gatewayType  = new Map();

  tasks.forEach(t => kind.set(t.id, 'task'));
  gateways.forEach(g => { kind.set(g.id, 'gateway'); gatewayType.set(g.id, g.type); });

  flows.forEach(f => {
    if (!kind.has(f.targetRef)) kind.set(f.targetRef, 'other');
    if (!kind.has(f.sourceRef)) kind.set(f.sourceRef, 'other');
    if (!incoming.has(f.targetRef)) incoming.set(f.targetRef, []);
    incoming.get(f.targetRef).push(f.sourceRef);
    if (!outgoing.has(f.sourceRef)) outgoing.set(f.sourceRef, []);
    outgoing.get(f.sourceRef).push(f.targetRef);
  });

  return { incoming, outgoing, kind, gatewayType };
}

function walkToTasks(nodeId, adjMap, kind, visited) {
  const found = [];
  const neighbours = adjMap.get(nodeId) || [];
  for (const n of neighbours) {
    if (visited.has(n)) continue;
    visited.add(n);
    const k = kind.get(n);
    if (k === 'task') {
      found.push(n);
    } else if (k === 'gateway') {
      found.push(...walkToTasks(n, adjMap, kind, visited));
    }

  }
  return found;
}

function resolveTaskPredecessors(task, graph) {
  const raw = (graph.incoming.get(task.id) || []).filter(n => graph.kind.get(n) !== 'other');
  if (raw.length === 0) return { predecessors: [], joinType: 'none' };

  const hasExclusiveImmediate = raw.some(n =>
    graph.kind.get(n) === 'gateway' && graph.gatewayType.get(n) === 'exclusive');

  const resolved = new Set();
  for (const n of raw) {
    if (graph.kind.get(n) === 'gateway') {
      walkToTasks(n, graph.incoming, graph.kind, new Set([task.id, n]))
        .forEach(t => resolved.add(t));
    } else {
      resolved.add(n);
    }
  }

  let joinType;
  if (hasExclusiveImmediate) joinType = 'xor';
  else if (resolved.size > 1) joinType = 'parallel';
  else joinType = 'single';

  return { predecessors: [...resolved], joinType };
}

function resolveXorSiblings(task, graph) {
  const raw = (graph.incoming.get(task.id) || []).filter(n => graph.kind.get(n) !== 'other');
  const siblings = new Set();
  let gatewayId = null;
  for (const n of raw) {
    if (graph.kind.get(n) === 'gateway' && graph.gatewayType.get(n) === 'exclusive') {
      if (gatewayId === null) gatewayId = n;
      walkToTasks(n, graph.outgoing, graph.kind, new Set([n]))
        .filter(id => id !== task.id)
        .forEach(id => siblings.add(id));
    }
  }
  const list = [...siblings];
  return { siblings: list, gatewayId: list.length > 0 ? gatewayId : null };
}

function resolveXorConditions(model, graph) {
  const flowsById = new Map(model.flows.map(f => [f.id, f]));
  const resolversByTask = new Map();

  model.gateways.forEach(gateway => {
    if (gateway.type !== 'exclusive') { gateway.conditionsDeclared = false; return; }

    const conditionedFlows = model.flows.filter(f => f.sourceRef === gateway.id && f.condition);

    gateway.conditionsDeclared = !!gateway.decisionParam && conditionedFlows.length > 0;
    if (!gateway.conditionsDeclared) return;

    const branches = conditionedFlows.map(f => ({ condition: f.condition, targetTaskId: f.targetRef }));
    const defaultFlow = gateway.defaultFlowId ? flowsById.get(gateway.defaultFlowId) : null;
    const defaultTargetTaskId = defaultFlow ? defaultFlow.targetRef : null;

    const resolvers = walkToTasks(gateway.id, graph.incoming, graph.kind, new Set([gateway.id]));
    resolvers.forEach(taskId => {
      if (!resolversByTask.has(taskId)) resolversByTask.set(taskId, []);
      resolversByTask.get(taskId).push({
        gatewayId: gateway.id,
        decisionParam: gateway.decisionParam,
        branches,
        defaultTargetTaskId,
      });
    });
  });

  return resolversByTask;
}

function annotateFlowGraph(model) {
  const graph = buildFlowGraph(model.tasks, model.gateways, model.flows);
  const gatewaysById = new Map(model.gateways.map(g => [g.id, g]));
  const resolversByTask = resolveXorConditions(model, graph);

  model.tasks.forEach(task => {
    const { predecessors, joinType } = resolveTaskPredecessors(task, graph);
    task.predecessors = predecessors;
    task.joinType      = joinType;
    task.xorResolves    = resolversByTask.get(task.id) || [];
    if (joinType === 'xor') {
      const { siblings, gatewayId } = resolveXorSiblings(task, graph);
      task.xorSiblings  = siblings;
      task.xorGatewayId = gatewayId;
      task.xorGatewayConditionsDeclared = gatewayId
        ? !!gatewaysById.get(gatewayId).conditionsDeclared
        : false;
    } else {
      task.xorSiblings  = [];
      task.xorGatewayId = null;
      task.xorGatewayConditionsDeclared = false;
    }
  });
}

function parseParticipants(doc) {
  const participants = select('//bpmn:collaboration/bpmn:participant', doc);
  return participants.map(el => ({
    id:         attr(el, 'id'),
    name:       attr(el, 'name'),
    platform:   nsattr(el, 'caterpillar', 'platform'),
    processRef: attr(el, 'processRef'),
  }));
}

function parseMessageFlows(doc) {
  const flows = select('//bpmn:collaboration/bpmn:messageFlow', doc);
  return flows.map(el => ({
    id:        attr(el, 'id'),
    name:      attr(el, 'name'),
    sourceRef: attr(el, 'sourceRef'),
    targetRef: attr(el, 'targetRef'),
  }));
}

function parseBPMN(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  const participants = parseParticipants(doc);
  const interactions  = parseMessageFlows(doc);
  const collaborationEl = select('//bpmn:collaboration', doc)[0] || null;





  const orgProcesses = participants.length
    ? participants.map(org => {
        const processEl = select(`//bpmn:process[@id="${org.processRef}"]`, doc)[0];
        if (!processEl) {
          throw new Error(`No <bpmn:process id="${org.processRef}"> found for participant "${org.id}"`);
        }
        return { org, processEl };
      })
    : [{ org: null, processEl: (() => {
        const processEl = select('//bpmn:process', doc)[0];
        if (!processEl) throw new Error('No <bpmn:process> element found');
        return processEl;
      })() }];

  const model = {
    id:   collaborationEl ? attr(collaborationEl, 'id')   : attr(orgProcesses[0].processEl, 'id'),
    name: collaborationEl ? attr(collaborationEl, 'name') : attr(orgProcesses[0].processEl, 'name'),
    baseContract: 'AbstractProcess',
    markingBits:  8,
    ctorParams:   [],
    subContracts: [],
    tasks:        [],
    flows:        [],
    gateways:     [],
    compensation: null,
    organizations: participants.map(p => ({ ...p })),
    interactions,
  };

  orgProcesses.forEach(({ org, processEl }, idx) => {
    const ownerId       = org ? org.id : null;
    const baseContract  = nsattr(processEl, 'caterpillar', 'baseContract') || 'AbstractProcess';
    const markingBits   = parseInt(nsattr(processEl, 'caterpillar', 'markingBits') || '8');
    const ctorParams    = parseCtorParams(processEl);
    const subContracts  = parseSubContracts(processEl);
    const compensation  = parseCompensationSubprocess(processEl);
    const tasks         = parseTasks(processEl, ownerId || 'any')
      .map(t => ({ ...t, ownerOrg: ownerId }));
    const flows         = parseSequenceFlows(processEl).map(f => ({ ...f, ownerOrg: ownerId }));
    const gateways      = parseGateways(processEl).map(g => ({ ...g, ownerOrg: ownerId }));

    if (org) {
      const orgEntry = model.organizations.find(o => o.id === org.id);
      Object.assign(orgEntry, { baseContract, markingBits, ctorParams, subContracts, compensation });
    } else if (idx === 0) {


      model.baseContract = baseContract;
      model.markingBits  = markingBits;
    }

    model.ctorParams.push(...ctorParams);
    model.subContracts.push(...subContracts);
    model.tasks.push(...tasks);
    model.flows.push(...flows);
    model.gateways.push(...gateways);
    if (compensation && !model.compensation) model.compensation = compensation;
  });








  annotateFlowGraph(model);

  return model;
}

function serializeModel(model) {
  return JSON.stringify(model, null, 2);
}

module.exports = { parseBPMN, serializeModel, VERIFICATION_ONLY };
