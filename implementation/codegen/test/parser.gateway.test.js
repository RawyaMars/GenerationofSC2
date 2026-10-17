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

function wrap(processInner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:caterpillar="http://caterpillar.blockchain/bpmn"
                   xmlns:temporal="http://iobp.temporal-constraints/bpmn/level3"
                   id="Definitions_Inline" targetNamespace="http://temporal-constraints/test">
  <bpmn:process id="InlineTest" name="Inline Test"
                caterpillar:baseContract="AbstractProcess" caterpillar:markingBits="8">
${processInner}
  </bpmn:process>
</bpmn:definitions>`;
}

function taskById(model, id) {
  return model.tasks.find(t => t.id === id);
}

test('plain sequential task: joinType=single, one predecessor', () => {
  const xml = wrap(`
    <bpmn:startEvent id="Start"/>
    <bpmn:sequenceFlow id="sf0" sourceRef="Start" targetRef="Task_A"/>
    <bpmn:task id="Task_A" name="A"/>
    <bpmn:sequenceFlow id="sf1" sourceRef="Task_A" targetRef="Task_B"/>
    <bpmn:task id="Task_B" name="B"/>
    <bpmn:sequenceFlow id="sf2" sourceRef="Task_B" targetRef="End"/>
    <bpmn:endEvent id="End"/>
  `);
  const model = parseBPMN(xml);

  assert.deepEqual(taskById(model, 'Task_A').predecessors, []);
  assert.equal(taskById(model, 'Task_A').joinType, 'none');

  assert.deepEqual(taskById(model, 'Task_B').predecessors, ['Task_A']);
  assert.equal(taskById(model, 'Task_B').joinType, 'single');
  assert.deepEqual(taskById(model, 'Task_B').xorSiblings, []);
});

test('implicit ad hoc fan-out (no gateway element): both downstream tasks stay single/single', () => {


  const xml = wrap(`
    <bpmn:startEvent id="Start"/>
    <bpmn:sequenceFlow id="sf0" sourceRef="Start" targetRef="Task_X"/>
    <bpmn:task id="Task_X" name="X"/>
    <bpmn:sequenceFlow id="sf1" sourceRef="Task_X" targetRef="Task_Y"/>
    <bpmn:sequenceFlow id="sf2" sourceRef="Task_X" targetRef="Task_Z"/>
    <bpmn:task id="Task_Y" name="Y"/>
    <bpmn:sequenceFlow id="sf3" sourceRef="Task_Y" targetRef="End"/>
    <bpmn:task id="Task_Z" name="Z"/>
    <bpmn:sequenceFlow id="sf4" sourceRef="Task_Z" targetRef="End"/>
    <bpmn:endEvent id="End"/>
  `);
  const model = parseBPMN(xml);

  assert.deepEqual(taskById(model, 'Task_Y').predecessors, ['Task_X']);
  assert.equal(taskById(model, 'Task_Y').joinType, 'single');

  assert.deepEqual(taskById(model, 'Task_Z').predecessors, ['Task_X']);
  assert.equal(taskById(model, 'Task_Z').joinType, 'single');
});

test('explicit parallel split + join', () => {
  const model = parseBPMN(readFixture('parallel_gateway.bpmn'));

  assert.equal(model.gateways.length, 2);
  assert.deepEqual(model.gateways.map(g => g.type).sort(), ['parallel', 'parallel']);


  assert.deepEqual(taskById(model, 'Task_B').predecessors, ['Task_A']);
  assert.equal(taskById(model, 'Task_B').joinType, 'single');
  assert.deepEqual(taskById(model, 'Task_C').predecessors, ['Task_A']);
  assert.equal(taskById(model, 'Task_C').joinType, 'single');


  const taskD = taskById(model, 'Task_D');
  assert.equal(taskD.joinType, 'parallel');
  assert.deepEqual([...taskD.predecessors].sort(), ['Task_B', 'Task_C']);
});

test('explicit XOR split + join', () => {
  const model = parseBPMN(readFixture('xor_gateway.bpmn'));

  assert.equal(model.gateways.length, 2);
  assert.deepEqual(model.gateways.map(g => g.type).sort(), ['exclusive', 'exclusive']);



  const taskB = taskById(model, 'Task_B');
  const taskC = taskById(model, 'Task_C');
  assert.equal(taskB.joinType, 'xor');
  assert.deepEqual(taskB.predecessors, ['Task_A']);
  assert.deepEqual(taskB.xorSiblings, ['Task_C']);
  assert.equal(taskB.xorGatewayId, 'XorSplit');

  assert.equal(taskC.joinType, 'xor');
  assert.deepEqual(taskC.xorSiblings, ['Task_B']);
  assert.equal(taskC.xorGatewayId, 'XorSplit');



  const taskD = taskById(model, 'Task_D');
  assert.equal(taskD.joinType, 'xor');
  assert.deepEqual([...taskD.predecessors].sort(), ['Task_B', 'Task_C']);
  assert.deepEqual(taskD.xorSiblings, []);
  assert.equal(taskD.xorGatewayId, null);
});
