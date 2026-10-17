'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { genFabricChaincode } = require('../fabric-generator.js');

const baseTask = (id, def, extra) => ({
  id, name: id,
  constraints: [{ def, enforcement: extra.enforcement, ...extra }],
  extraParams: [],
  predecessors: [], joinType: 'none', xorSiblings: [], xorGatewayId: null,
});

const model = {
  id: 'SyntheticEnforcement',
  name: 'Synthetic Enforcement Test',
  subContracts: [],
  tasks: [
    baseTask('Task_DurHard', 'DUR', { role: 'end', minD: 10, maxD: 100, enforcement: 'hard' }),
    baseTask('Task_DurSoft', 'DUR', { role: 'end', minD: 10, maxD: 100, enforcement: 'soft' }),
    baseTask('Task_CardHard', 'CARD', { role: 'guard', enforcement: 'hard' }),
    baseTask('Task_CardSoft', 'CARD', { role: 'guard', enforcement: 'soft' }),
    baseTask('Task_TdHard', 'TD', { role: 'refB', variant: 'FS', minD: 10, maxD: 100, enforcement: 'hard' }),
    baseTask('Task_TdSoft', 'TD', { role: 'refB', variant: 'FS', minD: 10, maxD: 100, enforcement: 'soft' }),
    baseTask('Task_AbsHard', 'ABS', { variant: 'SNLT', enforcement: 'hard' }),
    baseTask('Task_AbsSoft', 'ABS', { variant: 'SNLT', enforcement: 'soft' }),
    baseTask('Task_CotdHard', 'COTD', { role: 'guard', minD: 10, maxD: 100, enforcement: 'hard' }),
    baseTask('Task_CotdSoft', 'COTD', { role: 'guard', minD: 10, maxD: 100, enforcement: 'soft' }),
    baseTask('Task_GdHard', 'GD', { role: 'end', maxD: 100, enforcement: 'hard' }),
    baseTask('Task_GdSoft', 'GD', { role: 'end', maxD: 100, enforcement: 'soft' }),


    baseTask('Task_SyncForcedAdvisory', 'SYNC', { enforcement: 'hard' }),
  ],
  compensation: null,
};

const goCode = genFabricChaincode(model);

function functionBody(taskId) {
  const marker = `func (cc *SyntheticEnforcementChaincode) Execute_${taskId.replace(/^Task_/, '')}(`;
  const start = goCode.indexOf(marker);
  assert.ok(start >= 0, `function for ${taskId} not found in generated code`);
  const rest = goCode.slice(start);
  return rest.slice(0, rest.indexOf('\n}'));
}

for (const [taskId, def] of [
  ['Task_DurHard', 'DUR-1'],
  ['Task_CardHard', 'CARD-2'],
  ['Task_TdHard', 'TD-3'],
  ['Task_AbsHard', 'ABS-4'],
]) {
  test(`${def} hard: generates return fmt.Errorf, not emitAdvisory`, () => {
    const body = functionBody(taskId);
    assert.match(body, new RegExp(`return fmt\\.Errorf\\("${def}:`));
    assert.doesNotMatch(body, new RegExp(`emitAdvisory\\(ctx, "${def}"`));
  });
}

for (const [taskId, def] of [
  ['Task_DurSoft', 'DUR-1'],
  ['Task_CardSoft', 'CARD-2'],
  ['Task_TdSoft', 'TD-3'],
  ['Task_AbsSoft', 'ABS-4'],
  ['Task_CotdSoft', 'COTD-5'],
  ['Task_GdSoft', 'GD-7'],
]) {
  test(`${def} soft: generates emitAdvisory, not return fmt.Errorf`, () => {
    const body = functionBody(taskId);
    assert.match(body, new RegExp(`emitAdvisory\\(ctx, "${def}"`));
    assert.doesNotMatch(body, new RegExp(`return fmt\\.Errorf\\("${def}:`));
  });
}

for (const [taskId, def] of [
  ['Task_CotdHard', 'COTD-5'],
  ['Task_GdHard', 'GD-7'],
]) {
  test(`${def} with enforcement="hard" is verification only: emitAdvisory, never return fmt.Errorf`, () => {
    const body = functionBody(taskId);
    assert.match(body, new RegExp(`emitAdvisory\\(ctx, "${def}"`));
    assert.doesNotMatch(body, new RegExp(`return fmt\\.Errorf\\("${def}:`));
  });
}

test('SYNC-6 with enforcement="hard" still generates emitAdvisory (forced carve-out)', () => {
  const body = functionBody('Task_SyncForcedAdvisory');
  assert.match(body, /emitAdvisory\(ctx, "SYNC-6"/);
  assert.doesNotMatch(body, /return fmt\.Errorf\("SYNC-6:/);
});

test('CARD hard: does not increment/persist Count or emit TaskExecuted past the cap check', () => {
  const body = functionBody('Task_CardHard');
  // The violation return must come before Count is committed and before
  // TaskExecuted is emitted — check-before-mutate ordering.
  const errIdx = body.indexOf('return fmt.Errorf("CARD-2:');
  const commitIdx = body.indexOf('cardS.Count = newCount');
  const eventIdx = body.indexOf('SetEvent("TaskExecuted"');
  assert.ok(errIdx >= 0 && commitIdx >= 0 && eventIdx >= 0);
  assert.ok(errIdx < commitIdx);
  assert.ok(errIdx < eventIdx);
});
