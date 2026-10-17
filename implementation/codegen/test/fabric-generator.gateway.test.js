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

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('parallel gateway: generated Go checks all predecessors and records completion', () => {
  const model = parseBPMN(readFixture('parallel_gateway.bpmn'));
  const goCode = genFabricChaincode(model);

  assert.match(goCode, /type FlowState struct/);
  assert.match(goCode, /func hasTaskExecuted\(/);
  assert.match(goCode, /func recordTaskExecuted\(/);


  assert.match(goCode, /hasTaskExecuted\(ctx, processID, "Task_A"\)/);


  assert.match(goCode, /GATEWAY-PJOIN/);
  assert.match(goCode, /return fmt\.Errorf\("GATEWAY-PJOIN:/);
  assert.match(goCode, /"Task_B",/);
  assert.match(goCode, /"Task_C",/);

  // Self-firing guard: appears twice per task (comment + return fmt.Errorf
  // message) for Task_A/B/C/D = 8.
  assert.equal(countOccurrences(goCode, 'GATEWAY-REFIRE'), 8);

  // Every task records its own completion exactly once.
  assert.equal(countOccurrences(goCode, 'recordTaskExecuted(ctx, processID, "Task_A", now)'), 1);
  assert.equal(countOccurrences(goCode, 'recordTaskExecuted(ctx, processID, "Task_D", now)'), 1);

  // Source order within Task_D: predecessor check precedes completion recording.
  const execTaskD = goCode.slice(goCode.indexOf('func (cc *ParallelGatewayTestChaincode) Execute_D'));
  const body = execTaskD.slice(0, execTaskD.indexOf('\n}'));
  assert.ok(body.indexOf('GATEWAY-PJOIN') < body.indexOf('recordTaskExecuted(ctx, processID, "Task_D", now)'));
});

test('XOR gateway: generated Go blocks a losing sibling via an atomic claim', () => {
  const model = parseBPMN(readFixture('xor_gateway.bpmn'));
  const goCode = genFabricChaincode(model);

  assert.match(goCode, /GATEWAY-XOR\b/);
  assert.match(goCode, /GATEWAY-XOR-CLAIM/);
  assert.match(goCode, /xorchoice_/);
  assert.match(goCode, /func claimXorChoice\(/);

  // Task_B claims the shared gateway id, not its sibling's task id.
  const execTaskB = goCode.slice(goCode.indexOf('func (cc *XorGatewayTestChaincode) Execute_B'));
  const bodyB = execTaskB.slice(0, execTaskB.indexOf('\n}'));
  assert.match(bodyB, /claimXorChoice\(ctx, processID, "XorSplit", "Task_B"\)/);
});

test('structural flow tracker composes with an existing CCSD constraint without duplication', () => {
  // Built directly (not via XML parsing) to isolate genFabricChaincode's
  // composition behaviour: a task carrying a CCSD constraint AND a structural
  // predecessor from the flow graph.
  const model = {
    id: 'CompositionTest',
    name: 'Composition Test',
    subContracts: [],
    tasks: [
      {
        id: 'Task_Prep', name: 'Prep',
        constraints: [], extraParams: [],
        predecessors: [], joinType: 'none', xorSiblings: [], xorGatewayId: null,
      },
      {
        id: 'Task_Confirm', name: 'Confirm',
        constraints: [{ def: 'CCSD', cprMsgParam: 'confirmMsgId' }],
        extraParams: [],
        predecessors: ['Task_Prep'], joinType: 'single', xorSiblings: [], xorGatewayId: null,
      },
    ],
    compensation: null,
  };

  const goCode = genFabricChaincode(model);

  // Each marker naturally appears twice (once in a comment, once in the
  // return fmt.Errorf(...)/emitAdvisory() call) — the point is that structural
  // and CCSD blocks each appear exactly their own natural count, not
  // duplicated by composition. CCSD stays emitAdvisory (forced-advisory
  // carve-out) even though this constraint object has no `enforcement` field
  // at all (undefined !== 'hard', so isHard() would say false anyway — but
  // the carve-out is unconditional, it doesn't rely on that).
  assert.equal(countOccurrences(goCode, 'GATEWAY-SEQ'), 2);
  assert.equal(countOccurrences(goCode, 'CCSD-10'), 2);
  assert.match(goCode, /emitAdvisory\(ctx, "CCSD-10"/);
  // hasTaskExecuted(Task_Prep) is called twice: once by Task_Prep's own
  // self-firing guard (checking itself), once by Task_Confirm's predecessor
  // check (checking Task_Prep).
  assert.equal(countOccurrences(goCode, 'hasTaskExecuted(ctx, processID, "Task_Prep")'), 2);
  assert.equal(countOccurrences(goCode, 'recordTaskExecuted(ctx, processID, "Task_Confirm", now)'), 1);
  assert.match(goCode, /ccsd_%s/); // constraint state key untouched
  assert.match(goCode, /flow_%s_%s/); // structural state key untouched

  // Task_Prep (joinType 'none', no predecessors) still gets a self-firing
  // guard — that guard is unconditional, unlike the predecessor check.
  const execPrep = goCode.slice(goCode.indexOf('func (cc *CompositionTestChaincode) Execute_Prep'));
  assert.match(execPrep.slice(0, execPrep.indexOf('\n}')), /GATEWAY-REFIRE/);
});
