'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { parseBPMN } = require('../parser.js');
const { genProcessContract } = require('../generator.js');
const { genFabricChaincode } = require('../fabric-generator.js');

function selectOrg(model, orgId) {
  const org = model.organizations.find(o => o.id === orgId);
  return {
    ...model,
    id:           `${model.id}_${org.id}`,
    baseContract: org.baseContract,
    markingBits:  org.markingBits,
    ctorParams:   org.ctorParams,
    subContracts: org.subContracts,
    compensation: org.compensation,
    tasks:    model.tasks.filter(t => t.ownerOrg === org.id || t.ownerOrg == null),
    flows:    model.flows.filter(f => f.ownerOrg === org.id || f.ownerOrg == null),
    gateways: model.gateways.filter(g => g.ownerOrg === org.id || g.ownerOrg == null),
  };
}

function taskById(model, id) {
  return model.tasks.find(t => t.id === id);
}

function wrapCollaboration({ orgAPlatform = 'Hyperledger Fabric', orgBPlatform = 'Ethereum' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:caterpillar="http://caterpillar.blockchain/bpmn"
                   xmlns:temporal="http://iobp.temporal-constraints/bpmn/level3"
                   id="Definitions_InlineCollab" targetNamespace="http://temporal-constraints/test">
  <bpmn:message id="Message_Ping" name="Ping"/>
  <bpmn:collaboration id="collab_test" name="Inline collaboration test">
    <bpmn:participant id="OrgA" name="OrgA" processRef="Process_OrgA" caterpillar:platform="${orgAPlatform}"/>
    <bpmn:participant id="OrgB" name="OrgB" processRef="Process_OrgB" caterpillar:platform="${orgBPlatform}"/>
    <bpmn:messageFlow id="MessageFlow_Ping" sourceRef="Task_A" targetRef="StartEvent_B" messageRef="Message_Ping"/>
  </bpmn:collaboration>

  <bpmn:process id="Process_OrgA" name="OrgA" isExecutable="false">
    <bpmn:startEvent id="StartEvent_A"><bpmn:outgoing>sfA0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="Task_A" name="A">
      <bpmn:extensionElements>
        <temporal:constraint def="CBTD" variant="FS" role="orgA" cprMsgParam="pingMsgId"/>
      </bpmn:extensionElements>
      <bpmn:incoming>sfA0</bpmn:incoming>
      <bpmn:outgoing>sfA1</bpmn:outgoing>
    </bpmn:task>
    <bpmn:endEvent id="EndEvent_A"><bpmn:incoming>sfA1</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="sfA0" sourceRef="StartEvent_A" targetRef="Task_A"/>
    <bpmn:sequenceFlow id="sfA1" sourceRef="Task_A" targetRef="EndEvent_A"/>
  </bpmn:process>

  <bpmn:process id="Process_OrgB" name="OrgB" isExecutable="false"
                caterpillar:baseContract="AbstractProcess" caterpillar:markingBits="8">
    <caterpillar:constructorParam name="_cpr" type="address" description="CPR registry"/>
    <temporal:subContract id="cbtd" contractName="CBTD"/>
    <bpmn:startEvent id="StartEvent_B"><bpmn:messageEventDefinition messageRef="Message_Ping"/><bpmn:outgoing>sfB0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="Task_B" name="B">
      <bpmn:extensionElements>
        <temporal:constraint def="CBTD" variant="FS" role="orgB" cprMsgParam="pingMsgId" minD="600" maxD="900"/>
      </bpmn:extensionElements>
      <bpmn:incoming>sfB0</bpmn:incoming>
      <bpmn:outgoing>sfB1</bpmn:outgoing>
    </bpmn:task>
    <bpmn:endEvent id="EndEvent_B"><bpmn:incoming>sfB1</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="sfB0" sourceRef="StartEvent_B" targetRef="Task_B"/>
    <bpmn:sequenceFlow id="sfB1" sourceRef="Task_B" targetRef="EndEvent_B"/>
  </bpmn:process>
</bpmn:definitions>`;
}

test('legacy single-process file: organizations/interactions are empty, behaviour unchanged', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:caterpillar="http://caterpillar.blockchain/bpmn"
                   id="Definitions_Legacy" targetNamespace="http://temporal-constraints/test">
  <bpmn:process id="legacy" name="Legacy" caterpillar:baseContract="AbstractProcess" caterpillar:markingBits="8">
    <bpmn:startEvent id="Start"><bpmn:outgoing>sf0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="Task_A" name="A"><bpmn:incoming>sf0</bpmn:incoming></bpmn:task>
    <bpmn:sequenceFlow id="sf0" sourceRef="Start" targetRef="Task_A"/>
  </bpmn:process>
</bpmn:definitions>`;
  const model = parseBPMN(xml);
  assert.equal(model.id, 'legacy');
  assert.deepEqual(model.organizations, []);
  assert.deepEqual(model.interactions, []);
  assert.equal(taskById(model, 'Task_A').executedBy, 'any');
  assert.equal(taskById(model, 'Task_A').ownerOrg, null);
});

test('collaboration: organizations carry id/name/platform/processRef', () => {
  const model = parseBPMN(wrapCollaboration());
  assert.equal(model.id, 'collab_test');
  assert.equal(model.name, 'Inline collaboration test');
  assert.equal(model.organizations.length, 2);
  const orgA = model.organizations.find(o => o.id === 'OrgA');
  const orgB = model.organizations.find(o => o.id === 'OrgB');
  assert.equal(orgA.platform, 'Hyperledger Fabric');
  assert.equal(orgA.processRef, 'Process_OrgA');
  assert.equal(orgB.platform, 'Ethereum');
  assert.equal(orgB.subContracts.length, 1);
  assert.equal(orgB.subContracts[0].contractName, 'CBTD');
  assert.equal(orgB.ctorParams.length, 1);
});

test('collaboration: messageFlow is parsed into interactions', () => {
  const model = parseBPMN(wrapCollaboration());
  assert.equal(model.interactions.length, 1);
  assert.equal(model.interactions[0].id, 'MessageFlow_Ping');
  assert.equal(model.interactions[0].sourceRef, 'Task_A');
  assert.equal(model.interactions[0].targetRef, 'StartEvent_B');
});

test('collaboration: tasks are tagged with their owning organisation (ownerOrg)', () => {
  const model = parseBPMN(wrapCollaboration());
  assert.equal(taskById(model, 'Task_A').ownerOrg, 'OrgA');
  assert.equal(taskById(model, 'Task_B').ownerOrg, 'OrgB');
  assert.equal(model.tasks.length, 2);
});

test('collaboration: a task with no explicit caterpillar:executedBy defaults to its owning organisation, not "any"', () => {
  const model = parseBPMN(wrapCollaboration());
  assert.equal(taskById(model, 'Task_A').executedBy, 'OrgA');
  assert.equal(taskById(model, 'Task_B').executedBy, 'OrgB');
});

test('collaboration: sequenceFlow never crosses a pool boundary, so predecessors/joinType stay scoped per organisation', () => {
  const model = parseBPMN(wrapCollaboration());



  assert.deepEqual(taskById(model, 'Task_A').predecessors, []);
  assert.equal(taskById(model, 'Task_A').joinType, 'none');
  assert.deepEqual(taskById(model, 'Task_B').predecessors, []);
  assert.equal(taskById(model, 'Task_B').joinType, 'none');
});

test('real fixture PharmaInterOrgCollaboration.bpmn: two organisations, CBTD split orgA/orgB, --org-ready', () => {
  const xml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaInterOrgCollaboration.bpmn'), 'utf8');
  const model = parseBPMN(xml);

  assert.equal(model.id, 'pharma_interorg');
  assert.equal(model.organizations.length, 2);

  const fabricant = model.organizations.find(o => o.id === 'Fabricant');
  const regulateur = model.organizations.find(o => o.id === 'Regulateur');
  assert.equal(fabricant.platform, 'Hyperledger Fabric');
  assert.equal(regulateur.platform, 'Ethereum');
  assert.equal(regulateur.subContracts[0].contractName, 'CBTD');

  const notify = taskById(model, 'Task_NotifyAvailability');
  const validate = taskById(model, 'Task_ValidateLot');
  assert.equal(notify.ownerOrg, 'Fabricant');
  assert.equal(validate.ownerOrg, 'Regulateur');
  assert.equal(notify.constraints[0].role, 'orgA');
  assert.equal(validate.constraints[0].role, 'orgB');
  assert.equal(validate.constraints[0].minD, '600');
  assert.equal(validate.constraints[0].maxD, '900');

  assert.equal(model.interactions.length, 1);
  assert.equal(model.interactions[0].sourceRef, 'Task_NotifyAvailability');
  assert.equal(model.interactions[0].targetRef, 'StartEvent_ValidationTriggered');
});

test('PharmaInterOrgCollaboration.bpmn: --org Fabricant generates only Fabricant\'s task as valid Go', () => {
  const xml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaInterOrgCollaboration.bpmn'), 'utf8');
  const model = selectOrg(parseBPMN(xml), 'Fabricant');

  assert.equal(model.tasks.length, 1);
  assert.equal(model.tasks[0].id, 'Task_NotifyAvailability');

  const goCode = genFabricChaincode(model);
  assert.match(goCode, /Task_NotifyAvailability/);
  assert.doesNotMatch(goCode, /Task_ValidateLot/);

  let goAvailable = true;
  try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch { goAvailable = false; }
  if (!goAvailable) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-fabricant-test-'));
  const goFile = path.join(tmpDir, 'chaincode.go');
  fs.writeFileSync(goFile, goCode);
  try {
    assert.doesNotThrow(() => execFileSync('gofmt', ['-l', goFile], { encoding: 'utf8' }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PharmaInterOrgCollaboration.bpmn: --org Regulateur generates only Regulateur\'s task, composing CBTD', () => {
  const xml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaInterOrgCollaboration.bpmn'), 'utf8');
  const model = selectOrg(parseBPMN(xml), 'Regulateur');

  assert.equal(model.tasks.length, 1);
  assert.equal(model.tasks[0].id, 'Task_ValidateLot');
  assert.equal(model.subContracts.length, 1);
  assert.equal(model.subContracts[0].contractName, 'CBTD');

  const sol = genProcessContract(model);
  assert.match(sol, /Task_ValidateLot|ValidateLot/);
  assert.doesNotMatch(sol, /NotifyAvailability/);
  assert.match(sol, /CBTD/);
});

test('PharmaInterOrgCollaborationInverted.bpmn: platform is read from caterpillar:platform, not the organisation name', () => {
  const xml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaInterOrgCollaborationInverted.bpmn'), 'utf8');
  const model = parseBPMN(xml);

  const fabricant = model.organizations.find(o => o.id === 'Fabricant');
  const regulateur = model.organizations.find(o => o.id === 'Regulateur');
  assert.equal(fabricant.platform, 'Ethereum');
  assert.equal(regulateur.platform, 'Hyperledger Fabric');
  assert.equal(fabricant.subContracts[0].contractName, 'CBTD');
});

test('PharmaInterOrgCollaborationInverted.bpmn: --org Fabricant generates Solidity (emitter, orgA)', () => {
  const xml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaInterOrgCollaborationInverted.bpmn'), 'utf8');
  const model = selectOrg(parseBPMN(xml), 'Fabricant');

  assert.equal(model.tasks.length, 1);
  assert.equal(model.tasks[0].id, 'Task_NotifyAvailability');
  const sol = genProcessContract(model);
  assert.match(sol, /executeNotifyAvailability/);
  assert.match(sol, /recordOrgARef/);
  assert.doesNotMatch(sol, /ValidateLot/);
});

test('PharmaInterOrgCollaborationInverted.bpmn: --org Regulateur generates valid Go (receiver+verifier, orgB)', () => {
  const xml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaInterOrgCollaborationInverted.bpmn'), 'utf8');
  const model = selectOrg(parseBPMN(xml), 'Regulateur');

  assert.equal(model.tasks.length, 1);
  assert.equal(model.tasks[0].id, 'Task_ValidateLot');

  const goCode = genFabricChaincode(model);
  assert.match(goCode, /Execute_ValidateLot/);
  assert.match(goCode, /CBTD-9/);
  assert.doesNotMatch(goCode, /NotifyAvailability/);

  let goAvailable = true;
  try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch { goAvailable = false; }
  if (!goAvailable) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-inverted-test-'));
  const goFile = path.join(tmpDir, 'chaincode.go');
  fs.writeFileSync(goFile, goCode);
  try {
    assert.doesNotThrow(() => execFileSync('gofmt', ['-l', goFile], { encoding: 'utf8' }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
