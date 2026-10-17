'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBPMN } = require('../parser.js');

const FIXTURES = path.join(__dirname, 'fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function taskById(model, id) {
  return model.tasks.find(t => t.id === id);
}

test('conditional XOR gateway: decisionParam/default/condition are parsed', () => {
  const model = parseBPMN(readFixture('xor_gateway_conditional.bpmn'));

  const xorSplit = model.gateways.find(g => g.id === 'XorSplit');
  assert.deepEqual(xorSplit.decisionParam, { name: 'qcResult', type: 'string' });
  assert.equal(xorSplit.defaultFlowId, 'sf_default');
  assert.equal(xorSplit.conditionsDeclared, true);

  const sf2 = model.flows.find(f => f.id === 'sf2');
  const sf3 = model.flows.find(f => f.id === 'sf3');
  const sfDefault = model.flows.find(f => f.id === 'sf_default');
  assert.equal(sf2.condition, 'qcResult == "pass"');
  assert.equal(sf3.condition, 'qcResult == "fail"');
  assert.equal(sfDefault.condition, null);
});

test('conditional XOR gateway: resolution is attached to the resolver task in declaration order', () => {
  const model = parseBPMN(readFixture('xor_gateway_conditional.bpmn'));
  const taskA = taskById(model, 'Task_A');

  assert.equal(taskA.xorResolves.length, 1);
  const resolution = taskA.xorResolves[0];
  assert.equal(resolution.gatewayId, 'XorSplit');
  assert.deepEqual(resolution.decisionParam, { name: 'qcResult', type: 'string' });
  assert.deepEqual(resolution.branches, [
    { condition: 'qcResult == "pass"', targetTaskId: 'Task_B' },
    { condition: 'qcResult == "fail"', targetTaskId: 'Task_C' },
  ]);
  assert.equal(resolution.defaultTargetTaskId, 'Task_D');
});

test('conditional XOR gateway: branch tasks are flagged condition-resolved', () => {
  const model = parseBPMN(readFixture('xor_gateway_conditional.bpmn'));

  assert.equal(taskById(model, 'Task_B').xorGatewayConditionsDeclared, true);
  assert.equal(taskById(model, 'Task_C').xorGatewayConditionsDeclared, true);
  assert.equal(taskById(model, 'Task_D').xorGatewayConditionsDeclared, true);



  assert.equal(taskById(model, 'Task_E').xorGatewayConditionsDeclared, false);
});

test('non-regression: unconditional XOR gateway fixture stays on the claim path', () => {
  const model = parseBPMN(readFixture('xor_gateway.bpmn'));

  const xorSplit = model.gateways.find(g => g.id === 'XorSplit');
  assert.equal(xorSplit.conditionsDeclared, false);
  assert.equal(xorSplit.decisionParam, null);

  model.tasks.forEach(task => {
    assert.deepEqual(task.xorResolves, []);
    assert.equal(task.xorGatewayConditionsDeclared, false);
  });
});
