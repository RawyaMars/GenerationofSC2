'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBPMN } = require('../parser.js');
const { genFabricChaincode } = require('../fabric-generator.js');

const FIXTURES = path.join(__dirname, 'fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function functionBody(goCode, ccName, taskId) {
  const marker = `func (cc *${ccName}) Execute_${taskId.replace(/^Task_/, '')}(`;
  const start = goCode.indexOf(marker);
  assert.ok(start >= 0, `function for ${taskId} not found`);
  const rest = goCode.slice(start);
  return rest.slice(0, rest.indexOf('\n}'));
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('conditional XOR: resolver task gains the decision parameter and resolves deterministically', () => {
  const model = parseBPMN(readFixture('xor_gateway_conditional.bpmn'));
  const goCode = genFabricChaincode(model);

  assert.match(goCode, /func checkXorChoice\(/);
  assert.match(goCode, /func resolveXorChoice\(/);

  const bodyA = functionBody(goCode, 'XorConditionalTestChaincode', 'Task_A');
  assert.match(bodyA, /qcResult string/);
  assert.match(bodyA, /GATEWAY-XOR-RESOLVE/);



  const passIdx = bodyA.indexOf('qcResult == "pass"');
  const failIdx = bodyA.indexOf('qcResult == "fail"');
  assert.ok(passIdx >= 0 && failIdx >= 0);
  assert.ok(passIdx < failIdx);


  assert.match(bodyA, /default:\s*\n\s*_xorTarget = "Task_D"/);

  assert.equal(countOccurrences(bodyA, 'resolveXorChoice(ctx, processID, "XorSplit",'), 1);
});

test('conditional XOR: branch tasks check the resolved choice, never claim', () => {
  const model = parseBPMN(readFixture('xor_gateway_conditional.bpmn'));
  const goCode = genFabricChaincode(model);

  for (const taskId of ['Task_B', 'Task_C', 'Task_D']) {
    const body = functionBody(goCode, 'XorConditionalTestChaincode', taskId);
    assert.match(body, new RegExp(`checkXorChoice\\(ctx, processID, "XorSplit", "${taskId}"\\)`));
    assert.doesNotMatch(body, /claimXorChoice/);
    assert.doesNotMatch(body, /GATEWAY-XOR-RESOLVE/);
  }
});

test('non-regression: unconditional XOR fixture generates the exact original claim block', () => {
  const model = parseBPMN(readFixture('xor_gateway.bpmn'));
  const goCode = genFabricChaincode(model);

  const bodyB = functionBody(goCode, 'XorGatewayTestChaincode', 'Task_B');

  const expectedBlock = `\t// GATEWAY-XOR-CLAIM Timer Guard (blocking): claim this XOR split so only
\t// the first sibling branch to execute proceeds.
\tif err := claimXorChoice(ctx, processID, "XorSplit", "Task_B"); err != nil {
\t\treturn err
\t}`;
  assert.ok(bodyB.includes(expectedBlock), 'unconditional XOR branch block changed from its pre-condition-support form');

  assert.doesNotMatch(bodyB, /checkXorChoice/);
  assert.doesNotMatch(bodyB, /GATEWAY-XOR-RESOLVE/);
  assert.doesNotMatch(bodyB, /resolveXorChoice/);
});
