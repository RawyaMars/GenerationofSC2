'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { parseBPMN } = require('../parser.js');
const { genFabricChaincode } = require('../fabric-generator.js');

const BPMN_PATH = path.join(__dirname, '..', '..', 'bpmn-models', 'PharmaBatchProcess.bpmn');

function loadModel() {
  return parseBPMN(fs.readFileSync(BPMN_PATH, 'utf8'));
}

test('PharmaBatchProcess.bpmn: task set and structural graph unchanged by gateway support', () => {
  const model = loadModel();

  const taskIds = model.tasks.map(t => t.id);
  assert.deepEqual(taskIds, [
    'Task_BatchRelease',
    'Task_RegulatoryFiling',
    'Task_RegulatoryAck',
    'Task_Dispatch',
    'Task_RegulatoryShipmentConfirm',
    'Task_Delivery',
  ]);




  assert.equal(model.gateways.length, 0);

  const byId = id => model.tasks.find(t => t.id === id);

  assert.deepEqual(byId('Task_Dispatch').predecessors, ['Task_RegulatoryAck']);
  assert.equal(byId('Task_Dispatch').joinType, 'single');

  assert.deepEqual(byId('Task_RegulatoryShipmentConfirm').predecessors, ['Task_Dispatch']);
  assert.equal(byId('Task_RegulatoryShipmentConfirm').joinType, 'single');

  assert.deepEqual(byId('Task_Delivery').predecessors, ['Task_Dispatch']);
  assert.equal(byId('Task_Delivery').joinType, 'single');
});

test('PharmaBatchProcess.bpmn: generated Fabric chaincode keeps existing constraint bodies intact', () => {
  const model = loadModel();
  const goCode = genFabricChaincode(model);


  for (const marker of ['CBTD-9', 'CCSD-10', 'NRD-14', 'CCGD-12']) {
    const count = goCode.split(marker).length - 1;
    assert.ok(count >= 1, `expected marker ${marker} to appear in generated code`);
  }


  assert.match(goCode, /hasTaskExecuted\(ctx, processID, "Task_RegulatoryAck"\)/);
  assert.match(goCode, /recordTaskExecuted\(ctx, processID, "Task_Dispatch", now\)/);
});

test('PharmaBatchProcess.bpmn: generated Fabric chaincode is valid Go (skips if go/gofmt unavailable)', () => {
  const model = loadModel();
  const goCode = genFabricChaincode(model);

  let goAvailable = true;
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
  } catch {
    goAvailable = false;
  }
  if (!goAvailable) {

    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-gateway-test-'));
  const goFile = path.join(tmpDir, 'chaincode.go');
  fs.writeFileSync(goFile, goCode);

  try {




    assert.doesNotThrow(() => execFileSync('gofmt', ['-l', goFile], { encoding: 'utf8' }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
