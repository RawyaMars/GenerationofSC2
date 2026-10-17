'use strict';

const { ethers } = require('hardhat');
const { time }   = require('@nomicfoundation/hardhat-network-helpers');
const fs         = require('fs');
const path       = require('path');

const b32 = s => ethers.encodeBytes32String(s);

async function deployContract(name, args = []) {
  const F   = await ethers.getContractFactory(name);
  const c   = await F.deploy(...args);
  const tx  = c.deploymentTransaction();
  const rec = await tx.wait();
  return { contract: c, deployGas: Number(rec.gasUsed) };
}

async function gasOf(txPromise) {
  const tx  = await txPromise;
  const rec = await tx.wait();
  return Number(rec.gasUsed);
}

function hasEvent(receipt, name) {
  return receipt.logs.some(l => l.fragment && l.fragment.name === name);
}

const results = {
  generated_at:    new Date().toISOString(),
  platform:        'Ethereum (Hardhat local network)',
  solidity_version: '0.8.19',
  hardhat_version: '2.22.19',
  node_version:    process.version,
  contracts:       {},
  pharma_scenario: {},
  summary:         {}
};

function rec(label, data) { results.contracts[label] = data; }

async function evalDuration() {
  console.log('\n── Def 1: Duration ───────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('Duration');
  console.log(`  deploy: ${deployGas} gas`);


  const pid1 = b32('dur-happy');
  const startGas = await gasOf(c.startTask(pid1));
  await time.increase(120);
  const tx1     = await c.endTask(pid1, 60n, 300n);
  const r1      = await tx1.wait();
  const endGas  = Number(r1.gasUsed);
  const vio1    = hasEvent(r1, 'DesignerNotified');
  console.log(`  startTask: ${startGas} gas`);
  console.log(`  endTask (happy 120s in [60,300]): ${endGas} gas, violated=${vio1}`);


  const pid2 = b32('dur-short');
  await c.startTask(pid2);
  await time.increase(30);
  const tx2    = await c.endTask(pid2, 600n, 3600n);
  const r2     = await tx2.wait();
  const vioGas = Number(r2.gasUsed);
  const vio2   = hasEvent(r2, 'DesignerNotified');
  console.log(`  endTask (violation 30s < minD=600): ${vioGas} gas, violated=${vio2}`);

  rec('Def1_Duration', {
    deploy_gas: deployGas, startTask_gas: startGas,
    endTask_happy_gas: endGas, endTask_violation_gas: vioGas,
    happy_elapsed_s: 120, window: [60, 300],
    violation_elapsed_s: 30, violation_window: [600, 3600],
    violation_detected: vio2
  });
}

async function evalCardinality() {
  console.log('\n── Def 2: Cardinality ────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('Cardinality');
  console.log(`  deploy: ${deployGas} gas`);

  const tid = b32('card-t1');
  const initGas  = await gasOf(c.initTask(tid, 3n, 3600n));
  const exec1Gas = await gasOf(c.executeTask(tid));
  await c.executeTask(tid);
  await c.executeTask(tid);
  const tx4    = await c.executeTask(tid);
  const r4     = await tx4.wait();
  const exec4Gas = Number(r4.gasUsed);
  const vio4   = hasEvent(r4, 'DesignerNotified');
  console.log(`  initTask: ${initGas} gas`);
  console.log(`  executeTask (1st): ${exec1Gas} gas`);
  console.log(`  executeTask (4th, >Nmax=3): ${exec4Gas} gas, violated=${vio4}`);

  rec('Def2_Cardinality', {
    deploy_gas: deployGas, initTask_gas: initGas,
    executeTask_first_gas: exec1Gas, executeTask_violation_gas: exec4Gas,
    nmax: 3, dmax_s: 3600, violation_detected: vio4
  });
}

async function evalTemporalDependency() {
  console.log('\n── Def 3: TemporalDependency ─────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('TemporalDependency');
  console.log(`  deploy: ${deployGas} gas`);


  const pid1     = b32('td-fs-ok');
  const finAGas  = await gasOf(c.finishTaskA_FS(pid1));
  await time.increase(7200);
  const tx1      = await c.startTaskB_FS(pid1, 3600n, 14400n);
  const r1       = await tx1.wait();
  const startBGs = Number(r1.gasUsed);
  const vio1     = hasEvent(r1, 'DesignerNotified');
  console.log(`  finishTaskA_FS: ${finAGas} gas`);
  console.log(`  startTaskB_FS (happy 7200s in [3600,14400]): ${startBGs} gas, violated=${vio1}`);


  const pid2   = b32('td-fs-vio');
  await c.finishTaskA_FS(pid2);
  await time.increase(60);
  const tx2    = await c.startTaskB_FS(pid2, 3600n, 14400n);
  const r2     = await tx2.wait();
  const vioGas = Number(r2.gasUsed);
  const vio2   = hasEvent(r2, 'DesignerNotified');
  console.log(`  startTaskB_FS (violation 60s < minD=3600): ${vioGas} gas, violated=${vio2}`);

  rec('Def3_TemporalDependency', {
    deploy_gas: deployGas, finishTaskA_FS_gas: finAGas,
    startTaskB_FS_happy_gas: startBGs, startTaskB_FS_violation_gas: vioGas,
    variant: 'FS', happy_gap_s: 7200, window: [3600, 14400],
    violation_gap_s: 60, violation_detected: vio2
  });
}

async function evalAbsoluteConstraints() {
  console.log('\n── Def 4: AbsoluteConstraints ────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('AbsoluteConstraints');
  console.log(`  deploy: ${deployGas} gas`);

  const blockTs = BigInt((await ethers.provider.getBlock('latest')).timestamp);


  const pid1    = b32('abs-snlt-ok');
  const snltOkG = await gasOf(c.startTask_SNLT(pid1, blockTs + 600n));
  console.log(`  startTask_SNLT (happy, before deadline): ${snltOkG} gas`);


  const pid2     = b32('abs-snlt-vio');
  const tx2      = await c.startTask_SNLT(pid2, blockTs - 1n);
  const r2       = await tx2.wait();
  const snltVioG = Number(r2.gasUsed);
  const vio2     = hasEvent(r2, 'DesignerNotified');
  console.log(`  startTask_SNLT (violation, past deadline): ${snltVioG} gas, violated=${vio2}`);


  const blockTs2 = BigInt((await ethers.provider.getBlock('latest')).timestamp);
  const pid3    = b32('abs-mso-ok');
  const msoOkG  = await gasOf(c.startTask_MSO(pid3, blockTs2 + 10n));
  console.log(`  startTask_MSO (happy, delta=10s < tol=30s): ${msoOkG} gas`);


  const blockTs3  = BigInt((await ethers.provider.getBlock('latest')).timestamp);
  const pid4      = b32('abs-mso-vio');
  const tx4       = await c.startTask_MSO(pid4, blockTs3 + 200n);
  const r4        = await tx4.wait();
  const msoVioG   = Number(r4.gasUsed);
  const vio4      = hasEvent(r4, 'DesignerNotified');
  console.log(`  startTask_MSO (violation, delta=200s > tol=30s): ${msoVioG} gas, violated=${vio4}`);


  const blockTs4 = BigInt((await ethers.provider.getBlock('latest')).timestamp);
  const pid5    = b32('abs-fnlt-ok');
  const fnltOkG = await gasOf(c.finishTask_FNLT(pid5, blockTs4 + 600n));
  console.log(`  finishTask_FNLT (happy): ${fnltOkG} gas`);

  rec('Def4_AbsoluteConstraints', {
    deploy_gas: deployGas,
    startTask_SNLT_happy_gas: snltOkG, startTask_SNLT_violation_gas: snltVioG,
    startTask_MSO_happy_gas: msoOkG, startTask_MSO_violation_gas: msoVioG,
    finishTask_FNLT_happy_gas: fnltOkG,
    mso_tolerance_s: 30, snlt_violation_detected: vio2, mso_violation_detected: vio4
  });
}

async function evalCrossOrgTD() {
  console.log('\n── Def 5: CrossOrgTD ─────────────────────────────────────────────');
  const [orgA, orgB] = await ethers.getSigners();
  const { contract: c, deployGas } = await deployContract('CrossOrgTemporalDependency');
  console.log(`  deploy: ${deployGas} gas`);


  const pid1 = b32('cotd-happy');
  await c.connect(orgA).registerOrgA(pid1);
  await c.connect(orgB).registerOrgB(pid1);
  const finAGas = await gasOf(c.connect(orgA).orgA_finish_FS(pid1));
  await time.increase(7200);
  const tx1     = await c.connect(orgB).orgB_start_FS(pid1, 1800n, 14400n);
  const r1      = await tx1.wait();
  const startBG = Number(r1.gasUsed);
  const vio1    = hasEvent(r1, 'DesignerNotified');
  console.log(`  orgA_finish_FS: ${finAGas} gas`);
  console.log(`  orgB_start_FS (happy 7200s in [1800,14400]): ${startBG} gas, violated=${vio1}`);


  const pid2 = b32('cotd-vio');
  await c.connect(orgA).registerOrgA(pid2);
  await c.connect(orgB).registerOrgB(pid2);
  await c.connect(orgA).orgA_finish_FS(pid2);
  await time.increase(600);
  const tx2    = await c.connect(orgB).orgB_start_FS(pid2, 1800n, 14400n);
  const r2     = await tx2.wait();
  const vioGas = Number(r2.gasUsed);
  const vio2   = hasEvent(r2, 'DesignerNotified');
  console.log(`  orgB_start_FS (violation 600s < minD=1800): ${vioGas} gas, violated=${vio2}`);

  rec('Def5_CrossOrgTD', {
    deploy_gas: deployGas, orgA_finish_FS_gas: finAGas,
    orgB_start_FS_happy_gas: startBG, orgB_start_FS_violation_gas: vioGas,
    variant: 'FS', happy_gap_s: 7200, window: [1800, 14400],
    violation_gap_s: 600, violation_detected: vio2
  });
}

async function evalSyncDeadline() {
  console.log('\n── Def 6: SyncDeadline ───────────────────────────────────────────');
  const [, org1, org2] = await ethers.getSigners();
  const { contract: c, deployGas } = await deployContract('SyncDeadline');
  console.log(`  deploy: ${deployGas} gas`);

  const pid1     = b32('sync-happy');
  const initGas  = await gasOf(c.initSyncGate(pid1, [org1.address, org2.address], 5400n));
  const m1Gas    = await gasOf(c.connect(org1).markComplete(pid1));
  await time.increase(3600);
  const tx2      = await c.connect(org2).markComplete(pid1);
  const r2       = await tx2.wait();
  const m2Gas    = Number(r2.gasUsed);
  const fired    = hasEvent(r2, 'SyncFired');
  console.log(`  initSyncGate: ${initGas} gas`);
  console.log(`  markComplete (1st): ${m1Gas} gas`);
  console.log(`  markComplete (2nd, 3600s < maxWait=5400): ${m2Gas} gas, fired=${fired}`);


  const pid2 = b32('sync-vio');
  await c.initSyncGate(pid2, [org1.address, org2.address], 5400n);
  await c.connect(org1).markComplete(pid2);
  await time.increase(8000);
  const tx3    = await c.connect(org2).markComplete(pid2);
  const r3     = await tx3.wait();
  const vioGas = Number(r3.gasUsed);
  const aborted = hasEvent(r3, 'SyncAborted');
  console.log(`  markComplete (violation 8000s > maxWait=5400): ${vioGas} gas, aborted=${aborted}`);

  rec('Def6_SyncDeadline', {
    deploy_gas: deployGas, initSyncGate_gas: initGas,
    markComplete_first_gas: m1Gas, markComplete_fires_gas: m2Gas,
    markComplete_violation_gas: vioGas,
    happy_gap_s: 3600, maxwait_s: 5400, violation_gap_s: 8000,
    gate_fired: fired, violation_detected: aborted
  });
}

async function evalGlobalDeadline() {
  console.log('\n── Def 7: GlobalDeadline ─────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('GlobalDeadline');
  console.log(`  deploy: ${deployGas} gas`);

  const pid1    = b32('gd-happy');
  const startGs = await gasOf(c.startProcess(pid1));
  await time.increase(86400);
  const tx1     = await c.endProcess(pid1, 172800n);
  const r1      = await tx1.wait();
  const endGs   = Number(r1.gasUsed);
  const vio1    = hasEvent(r1, 'DesignerNotified');
  console.log(`  startProcess: ${startGs} gas`);
  console.log(`  endProcess (happy 24h < 48h): ${endGs} gas, violated=${vio1}`);

  const pid2   = b32('gd-vio');
  await c.startProcess(pid2);
  await time.increase(216000);
  const tx2    = await c.endProcess(pid2, 172800n);
  const r2     = await tx2.wait();
  const vioGas = Number(r2.gasUsed);
  const vio2   = hasEvent(r2, 'DesignerNotified');
  console.log(`  endProcess (violation 60h > 48h): ${vioGas} gas, violated=${vio2}`);

  rec('Def7_GlobalDeadline', {
    deploy_gas: deployGas, startProcess_gas: startGs,
    endProcess_happy_gas: endGs, endProcess_violation_gas: vioGas,
    happy_elapsed_h: 24, limit_h: 48, violation_elapsed_h: 60,
    violation_detected: vio2
  });
}

async function deployMock() {
  const { contract: mock, deployGas } = await deployContract('MockCPRRegistry');
  console.log(`\n  MockCPRRegistry deploy: ${deployGas} gas`);
  results.contracts['MockCPRRegistry'] = { deploy_gas: deployGas };
  return mock;
}

async function evalCID(mock) {
  console.log('\n── Def 8: CID ────────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('CID', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);

  const pid1  = b32('cid-happy');
  const SEND1 = b32('cid-s1');
  const RECV1 = b32('cid-r1');
  await mock.register(SEND1, 1_000_000n, true);
  await mock.register(RECV1, 1_000_000n + 2700n, true);
  const regSendGs = await gasOf(c.registerSend(pid1, SEND1));
  const regRecvGs = await gasOf(c.registerReceive(pid1, RECV1, 3600n));
  console.log(`  registerSend: ${regSendGs} gas`);
  console.log(`  registerReceive (happy lag=2700s < maxD=3600): ${regRecvGs} gas`);


  const pid2  = b32('cid-vio');
  const SEND2 = b32('cid-s2');
  const RECV2 = b32('cid-r2');
  await mock.register(SEND2, 1_000_000n, true);
  await mock.register(RECV2, 1_000_000n + 7200n, true);
  await c.registerSend(pid2, SEND2);
  let reverted = false;
  try {
    await (await c.registerReceive(pid2, RECV2, 3600n)).wait();
  } catch { reverted = true; }
  console.log(`  registerReceive (violation lag=7200 > maxD=3600): HARD reverted=${reverted}`);

  rec('Def8_CID', {
    deploy_gas: deployGas, registerSend_gas: regSendGs,
    registerReceive_happy_gas: regRecvGs,
    happy_lag_s: 2700, max_d_s: 3600, violation_lag_s: 7200,
    violation_reverted: reverted, enforcement: 'HARD'
  });
}

async function evalCBTD(mock) {
  console.log('\n── Def 9: CBTD ───────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('CBTD', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);

  const pid1  = b32('cbtd-happy');
  const MSGA  = b32('cbtd-a1');
  const MSGB  = b32('cbtd-b1');
  await mock.register(MSGA, 1_000_000n, true);
  await mock.register(MSGB, 1_000_000n + 7200n, true);
  const recAGs = await gasOf(c.recordOrgARef(pid1, 'FS', MSGA));
  const recBGs = await gasOf(c.recordOrgBRef(pid1, 'FS', MSGB, 1800n, 14400n));
  console.log(`  recordOrgARef (FS): ${recAGs} gas`);
  console.log(`  recordOrgBRef (happy gap=7200s in [1800,14400]): ${recBGs} gas`);


  const pid2  = b32('cbtd-vio');
  const MSGA2 = b32('cbtd-a2');
  const MSGB2 = b32('cbtd-b2');
  await mock.register(MSGA2, 1_000_000n, true);
  await mock.register(MSGB2, 1_000_000n + 50000n, true);
  await c.recordOrgARef(pid2, 'FS', MSGA2);
  let reverted = false;
  try {
    await (await c.recordOrgBRef(pid2, 'FS', MSGB2, 1800n, 14400n)).wait();
  } catch { reverted = true; }
  console.log(`  recordOrgBRef (violation gap=50000 > maxD=14400): HARD reverted=${reverted}`);

  rec('Def9_CBTD', {
    deploy_gas: deployGas, recordOrgARef_gas: recAGs,
    recordOrgBRef_happy_gas: recBGs,
    variant: 'FS', happy_gap_s: 7200, window: [1800, 14400],
    violation_gap_s: 50000, violation_reverted: reverted, enforcement: 'HARD'
  });
}

async function evalCCSD(mock) {
  console.log('\n── Def 10: CCSD ──────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('CCSD', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);

  const pid1  = b32('ccsd-happy');
  const ORG1  = b32('logistics');
  const ORG2  = b32('regulatory');
  const MSG1  = b32('ccsd-m1');
  const MSG2  = b32('ccsd-m2');
  await mock.register(MSG1, 1_000_000n, true);
  await mock.register(MSG2, 1_000_000n + 3600n, true);
  const initGs = await gasOf(c.initGate(pid1, [ORG1, ORG2], 5400n));
  const m1Gs   = await gasOf(c.markComplete(pid1, ORG1, MSG1));
  const tx2    = await c.markComplete(pid1, ORG2, MSG2);
  const r2     = await tx2.wait();
  const m2Gs   = Number(r2.gasUsed);
  const fired  = hasEvent(r2, 'SyncFired');
  console.log(`  initGate: ${initGs} gas`);
  console.log(`  markComplete (1st): ${m1Gs} gas`);
  console.log(`  markComplete (2nd, fires, lag=3600 < maxWait=5400): ${m2Gs} gas, fired=${fired}`);


  const pid2  = b32('ccsd-vio');
  const MSG3  = b32('ccsd-m3');
  const MSG4  = b32('ccsd-m4');
  await mock.register(MSG3, 1_000_000n, true);
  await mock.register(MSG4, 1_000_000n + 9000n, true);
  await c.initGate(pid2, [ORG1, ORG2], 5400n);
  await c.markComplete(pid2, ORG1, MSG3);
  let reverted = false;
  try {
    await (await c.markComplete(pid2, ORG2, MSG4)).wait();
  } catch { reverted = true; }
  console.log(`  markComplete (violation lag=9000 > maxWait=5400): HARD reverted=${reverted}`);

  rec('Def10_CCSD', {
    deploy_gas: deployGas, initGate_gas: initGs,
    markComplete_first_gas: m1Gs, markComplete_fires_gas: m2Gs,
    happy_lag_s: 3600, maxwait_s: 5400, violation_lag_s: 9000,
    gate_fired: fired, violation_reverted: reverted, enforcement: 'HARD'
  });
}

async function evalCECW(mock) {
  console.log('\n── Def 11: CECW ──────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('CECW', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);


  const CID1   = b32('cecw-c1');
  const OFFER1 = b32('cecw-o1');
  const ACPT1  = b32('cecw-a1');
  await mock.register(OFFER1, 1_000_000n, true);
  await mock.register(ACPT1,  1_000_000n + 1800n, true);
  const regOfferGs = await gasOf(c.registerOffer(CID1, OFFER1, 3600n));
  const tx1        = await c.accept(CID1, ACPT1);
  const r1         = await tx1.wait();
  const acceptGs   = Number(r1.gasUsed);
  const accepted   = hasEvent(r1, 'Accepted');
  console.log(`  registerOffer: ${regOfferGs} gas`);
  console.log(`  accept (happy lag=1800s < window=3600): ${acceptGs} gas, accepted=${accepted}`);


  const CID2   = b32('cecw-c2');
  const OFFER2 = b32('cecw-o2');
  const ACPT2  = b32('cecw-a2');
  await mock.register(OFFER2, 1_000_000n, true);
  await mock.register(ACPT2,  1_000_000n + 5000n, true);
  await c.registerOffer(CID2, OFFER2, 3600n);
  const tx2    = await c.accept(CID2, ACPT2);
  const r2     = await tx2.wait();
  const lateGs = Number(r2.gasUsed);
  const expired = hasEvent(r2, 'Expired');
  const state2  = await c.getState(CID2);
  console.log(`  accept (violation lag=5000 > window=3600, SOFT): ${lateGs} gas, state=${state2}(EXPIRED=3), expired=${expired}`);

  rec('Def11_CECW', {
    deploy_gas: deployGas, registerOffer_gas: regOfferGs,
    accept_happy_gas: acceptGs, accept_violation_gas: lateGs,
    window_s: 3600, happy_lag_s: 1800, violation_lag_s: 5000,
    state_machine: true, violation_reverted: false, enforcement: 'SOFT',
    expired_state: Number(state2)
  });
}

async function evalCCGD(mock) {
  console.log('\n── Def 12: CCGD ──────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('CCGD', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);

  const pid1   = b32('ccgd-happy');
  const START1 = b32('ccgd-s1');
  const END1   = b32('ccgd-e1');
  await mock.register(START1, 1_000_000n, true);
  await mock.register(END1,   1_000_000n + 86400n, true);
  const recStartGs = await gasOf(c.recordStart(pid1, START1));
  const recEndGs   = await gasOf(c.recordEnd(pid1, END1, 172800n));
  console.log(`  recordStart: ${recStartGs} gas`);
  console.log(`  recordEnd (happy 24h < 48h): ${recEndGs} gas`);


  const pid2   = b32('ccgd-vio');
  const START2 = b32('ccgd-s2');
  const END2   = b32('ccgd-e2');
  await mock.register(START2, 1_000_000n, true);
  await mock.register(END2,   1_000_000n + 198000n, true);
  await c.recordStart(pid2, START2);
  let reverted = false;
  try {
    await (await c.recordEnd(pid2, END2, 172800n)).wait();
  } catch { reverted = true; }
  console.log(`  recordEnd (violation ~55h > 48h): HARD reverted=${reverted}`);

  rec('Def12_CCGD', {
    deploy_gas: deployGas, recordStart_gas: recStartGs,
    recordEnd_happy_gas: recEndGs,
    limit_h: 48, happy_elapsed_h: 24, violation_elapsed_h: 55,
    violation_reverted: reverted, enforcement: 'HARD'
  });
}

async function evalCCCW(mock) {
  console.log('\n── Def 13: CCCW ──────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('CCCW', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);

  const pid1  = b32('cccw-happy');
  const FAIL1 = b32('cccw-f1');
  const COMP1 = b32('cccw-c1');
  const DONE1 = b32('cccw-d1');
  await mock.register(FAIL1, 1_000_000n, true);
  await mock.register(COMP1, 1_000_000n + 3000n, true);
  await mock.register(DONE1, 1_000_000n + 5000n, true);
  const recFailGs  = await gasOf(c.recordFailure(pid1, FAIL1, 7200n));
  const startCompGs = await gasOf(c.startCompensation(pid1, COMP1));
  const tx3        = await c.completeCompensation(pid1, DONE1);
  const r3         = await tx3.wait();
  const doneGs     = Number(r3.gasUsed);
  const completed  = hasEvent(r3, 'CompensationCompleted');
  const state1     = await c.getState(pid1);
  console.log(`  recordFailure: ${recFailGs} gas`);
  console.log(`  startCompensation (happy lag=3000s < max=7200): ${startCompGs} gas`);
  console.log(`  completeCompensation: ${doneGs} gas, state=${state1}(COMPLETED=2), completed=${completed}`);


  const pid2  = b32('cccw-vio');
  const FAIL2 = b32('cccw-f2');
  const COMP2 = b32('cccw-c2');
  await mock.register(FAIL2, 1_000_000n, true);
  await mock.register(COMP2, 1_000_000n + 9000n, true);
  await c.recordFailure(pid2, FAIL2, 7200n);
  const tx4    = await c.startCompensation(pid2, COMP2);
  const r4     = await tx4.wait();
  const lateGs = Number(r4.gasUsed);
  const irrecov = hasEvent(r4, 'Irrecoverable');
  const state2  = await c.getState(pid2);
  console.log(`  startCompensation (violation lag=9000 > max=7200, SOFT): ${lateGs} gas, state=${state2}(IRRECOVERABLE=3), irrecov=${irrecov}`);

  rec('Def13_CCCW', {
    deploy_gas: deployGas, recordFailure_gas: recFailGs,
    startCompensation_happy_gas: startCompGs, completeCompensation_gas: doneGs,
    startCompensation_violation_gas: lateGs,
    max_comp_time_s: 7200, happy_lag_s: 3000, violation_lag_s: 9000,
    state_machine: true, violation_reverted: false, enforcement: 'SOFT',
    completed_state: Number(state1), irrecoverable_state: Number(state2)
  });
}

async function evalNRD(mock) {
  console.log('\n── Def 14: NRD ───────────────────────────────────────────────────');
  const { contract: c, deployGas } = await deployContract('NRD', [await mock.getAddress()]);
  console.log(`  deploy: ${deployGas} gas`);

  const MSG1  = b32('nrd-msg1');
  const SEND1 = b32('nrd-s1');
  const ACK1  = b32('nrd-a1');
  await mock.register(SEND1, 1_000_000n, true);
  await mock.register(ACK1,  1_000_000n + 1800n, true);
  const regSendGs = await gasOf(c.registerSend(MSG1, SEND1, 3600n));
  const tx1       = await c.registerAck(MSG1, ACK1);
  const r1        = await tx1.wait();
  const ackGs     = Number(r1.gasUsed);
  const acked     = hasEvent(r1, 'AckRecorded');
  console.log(`  registerSend: ${regSendGs} gas`);
  console.log(`  registerAck (happy lag=1800s < maxAck=3600): ${ackGs} gas, acked=${acked}`);


  const MSG2  = b32('nrd-msg2');
  const SEND2 = b32('nrd-s2');
  const ACK2  = b32('nrd-a2');
  await mock.register(SEND2, 1_000_000n, true);
  await mock.register(ACK2,  1_000_000n + 5000n, true);
  await c.registerSend(MSG2, SEND2, 3600n);
  const tx2    = await c.registerAck(MSG2, ACK2);
  const r2     = await tx2.wait();
  const lateGs = Number(r2.gasUsed);
  const evidence = hasEvent(r2, 'NonReceiptEvidence');
  const state2   = await c.getState(MSG2);
  console.log(`  registerAck (violation lag=5000 > maxAck=3600, SOFT non-repudiation): ${lateGs} gas, evidence=${evidence}, state=${state2}`);


  const MSG3  = b32('nrd-msg3');
  const SEND3 = b32('nrd-s3');
  await mock.register(SEND3, 1_000_000n, true);
  await c.registerSend(MSG3, SEND3, 3600n);
  const tx3    = await c.claimNonReceipt(MSG3, 1_000_000n + 5000n);
  const r3     = await tx3.wait();
  const claimGs = Number(r3.gasUsed);
  const claimEv = hasEvent(r3, 'NonReceiptEvidence');
  console.log(`  claimNonReceipt (pull, after window): ${claimGs} gas, evidence=${claimEv}`);

  rec('Def14_NRD', {
    deploy_gas: deployGas, registerSend_gas: regSendGs,
    registerAck_happy_gas: ackGs, registerAck_violation_gas: lateGs,
    claimNonReceipt_gas: claimGs,
    max_ack_time_s: 3600, happy_lag_s: 1800, violation_lag_s: 5000,
    state_machine: true, violation_reverted: false, enforcement: 'SOFT',
    evidence_emitted: evidence
  });
}

async function evalPharmaScenario(mock) {
  console.log('\n══ PHARMA SUPPLY CHAIN SCENARIO ══════════════════════════════════════');
  console.log('  Manufacturer (Fabric) + Distributor (Fabric) + Regulatory (Ethereum)');
  console.log('  All cross-chain interactions use τ_CPR timestamps from MockCPRRegistry');

  const mockAddr = await mock.getAddress();









  const T0              = 1_750_000_000n;
  const tBatchRelease   = T0;
  const tFilingSent     = T0 +   2_700n;
  const tFilingAck      = T0 +   5_400n;
  const tDispatchLog    = T0 +   7_200n;
  const tDispatchReg    = T0 +   7_500n;
  const tDelivery       = T0 + 169_200n;


  const BATCH_MSG   = b32('ph-batch');
  const FILING_MSG  = b32('ph-filing');
  const ACK_MSG     = b32('ph-ack');
  const DISP_LOG    = b32('ph-disp-log');
  const DISP_REG    = b32('ph-disp-reg');
  const DELIV_MSG   = b32('ph-delivery');

  await mock.register(BATCH_MSG,  tBatchRelease, true);
  await mock.register(FILING_MSG, tFilingSent,   true);
  await mock.register(ACK_MSG,    tFilingAck,    true);
  await mock.register(DISP_LOG,   tDispatchLog,  true);
  await mock.register(DISP_REG,   tDispatchReg,  true);
  await mock.register(DELIV_MSG,  tDelivery,     true);

  const SC = {};


  {
    const { contract: cbtd, deployGas } = await deployContract('CBTD', [mockAddr]);
    const pid = b32('ph-cbtd');
    await cbtd.recordOrgARef(pid, 'FS', BATCH_MSG);
    const tx  = await cbtd.recordOrgBRef(pid, 'FS', DISP_LOG, 1800n, 14400n);
    const r   = await tx.wait();
    const gap = Number(tDispatchLog - tBatchRelease);
    SC.cbtd = {
      constraint: 'CBTD-9 (FS): batch_release → logistics_dispatch in [30min, 4h]',
      gap_s: gap, gap_min: +(gap/60).toFixed(1), window: [1800, 14400],
      satisfied: !hasEvent(r, 'CBTDViolation'),
      deploy_gas: deployGas, execute_gas: Number(r.gasUsed)
    };
    console.log(`  CBTD-9 FS: gap=${gap}s (${(gap/60).toFixed(0)}min) in [30min,4h] → satisfied=${SC.cbtd.satisfied}`);
  }


  {
    const { contract: cid, deployGas } = await deployContract('CID', [mockAddr]);
    const pid = b32('ph-cid');
    await cid.registerSend(pid, FILING_MSG);
    const tx  = await cid.registerReceive(pid, ACK_MSG, 3600n);
    const r   = await tx.wait();
    const lag = Number(tFilingAck - tFilingSent);
    SC.cid = {
      constraint: 'CID-8: filing_sent → filing_ack lag ≤ 1h',
      lag_s: lag, lag_min: +(lag/60).toFixed(1), max_d_s: 3600,
      satisfied: true,
      deploy_gas: deployGas, execute_gas: Number(r.gasUsed)
    };
    console.log(`  CID-8: lag=${lag}s (${(lag/60).toFixed(0)}min) ≤ 3600s → satisfied=true`);
  }


  {
    const { contract: nrd, deployGas } = await deployContract('NRD', [mockAddr]);
    const msgId = b32('ph-nrd-msg');
    await nrd.registerSend(msgId, FILING_MSG, 3600n);
    const tx    = await nrd.registerAck(msgId, ACK_MSG);
    const r     = await tx.wait();
    const lag   = Number(tFilingAck - tFilingSent);
    const state = await nrd.getState(msgId);
    SC.nrd = {
      constraint: 'NRD-14: ack within 1h of filing send',
      lag_s: lag, lag_min: +(lag/60).toFixed(1), max_ack_s: 3600,
      satisfied: Number(state) === 1, state_label: 'ACKNOWLEDGED',
      deploy_gas: deployGas, execute_gas: Number(r.gasUsed)
    };
    console.log(`  NRD-14: lag=${lag}s state=${state}(ACKNOWLEDGED=1) → satisfied=${SC.nrd.satisfied}`);
  }


  {
    const { contract: ccsd, deployGas } = await deployContract('CCSD', [mockAddr]);
    const pid  = b32('ph-ccsd');
    const ORG_L = b32('logistics');
    const ORG_R = b32('regulatory');
    await ccsd.initGate(pid, [ORG_L, ORG_R], 5400n);
    await ccsd.markComplete(pid, ORG_L, DISP_LOG);
    const tx   = await ccsd.markComplete(pid, ORG_R, DISP_REG);
    const r    = await tx.wait();
    const lag  = Number(tDispatchReg - tDispatchLog);
    SC.ccsd = {
      constraint: 'CCSD-10: all orgs dispatch-sync within 90min',
      lag_s: lag, lag_min: +(lag/60).toFixed(1), max_wait_s: 5400,
      satisfied: hasEvent(r, 'SyncFired'), gate_fired: hasEvent(r, 'SyncFired'),
      deploy_gas: deployGas, execute_gas: Number(r.gasUsed)
    };
    console.log(`  CCSD-10: lag=${lag}s (${(lag/60).toFixed(0)}min) ≤ 5400s → fired=${SC.ccsd.gate_fired}`);
  }


  {
    const { contract: ccgd, deployGas } = await deployContract('CCGD', [mockAddr]);
    const pid     = b32('ph-ccgd');
    await ccgd.recordStart(pid, BATCH_MSG);
    const tx      = await ccgd.recordEnd(pid, DELIV_MSG, 172800n);
    const r       = await tx.wait();
    const elapsed = Number(tDelivery - tBatchRelease);
    SC.ccgd = {
      constraint: 'CCGD-12: batch_release → delivery ≤ 48h',
      elapsed_s: elapsed, elapsed_h: +(elapsed/3600).toFixed(2), limit_h: 48,
      satisfied: elapsed <= 172800,
      deploy_gas: deployGas, execute_gas: Number(r.gasUsed)
    };
    console.log(`  CCGD-12: elapsed=${(elapsed/3600).toFixed(1)}h ≤ 48h → satisfied=${SC.ccgd.satisfied}`);
  }


  {
    const { contract: nrd2 } = await deployContract('NRD', [mockAddr]);
    const LATE_SEND = b32('ph-late-send');
    const LATE_ACK  = b32('ph-late-ack');
    await mock.register(LATE_SEND, T0 + 3000n, true);
    await mock.register(LATE_ACK,  T0 + 3000n + 7500n, true);
    await nrd2.registerSend(b32('ph-late-msg'), LATE_SEND, 3600n);
    const tx   = await nrd2.registerAck(b32('ph-late-msg'), LATE_ACK);
    const r    = await tx.wait();
    const evidence = hasEvent(r, 'NonReceiptEvidence');
    SC.late_ack_violation = {
      description: 'Regulatory ack arrives 2.5h late — NRD emits NonReceiptEvidence (SOFT, no revert)',
      lag_s: 7500, max_ack_s: 3600,
      enforcement: 'SOFT — state=EVIDENCE_ISSUED, tx commits',
      evidence_emitted: evidence,
      execute_gas: Number(r.gasUsed)
    };
    console.log(`  NRD violation (late ack 7500s > 3600s): evidence=${evidence} [SOFT, no revert]`);
  }

  results.pharma_scenario = {
    participants: {
      Manufacturer: 'Hyperledger Fabric (ManufacturerMSP)',
      Distributor:  'Hyperledger Fabric (LogisticsMSP)',
      Regulatory:   'Ethereum (smart contracts)'
    },
    tau_cpr_timestamps: {
      batch_release:    Number(tBatchRelease),
      filing_sent:      Number(tFilingSent),
      filing_ack:       Number(tFilingAck),
      logistics_dispatch: Number(tDispatchLog),
      regulatory_dispatch: Number(tDispatchReg),
      delivery:         Number(tDelivery)
    },
    constraints: SC,
    all_mandatory_satisfied:
      SC.cbtd.satisfied && SC.cid.satisfied && SC.nrd.satisfied &&
      SC.ccsd.satisfied && SC.ccgd.satisfied
  };

  console.log(`\n  All mandatory pharma constraints satisfied: ${results.pharma_scenario.all_mandatory_satisfied}`);
}

function buildSummary() {
  const defKeys    = Object.keys(results.contracts).filter(k => /^Def\d/.test(k));
  const deployGas  = defKeys.map(k => results.contracts[k].deploy_gas);


  const execFields = [
    'startTask_gas','endTask_happy_gas','initTask_gas','executeTask_first_gas',
    'finishTaskA_FS_gas','startTaskB_FS_happy_gas',
    'startTask_SNLT_happy_gas','startTask_MSO_happy_gas','finishTask_FNLT_happy_gas',
    'orgA_finish_FS_gas','orgB_start_FS_happy_gas',
    'initSyncGate_gas','markComplete_first_gas','markComplete_fires_gas',
    'startProcess_gas','endProcess_happy_gas',
    'registerSend_gas','registerReceive_happy_gas',
    'recordOrgARef_gas','recordOrgBRef_happy_gas',
    'initGate_gas','markComplete_first_gas',
    'registerOffer_gas','accept_happy_gas',
    'recordStart_gas','recordEnd_happy_gas',
    'recordFailure_gas','startCompensation_happy_gas','completeCompensation_gas',
    'registerAck_happy_gas','claimNonReceipt_gas'
  ];
  const execGas = [];
  defKeys.forEach(k => {
    execFields.forEach(f => {
      if (results.contracts[k][f]) execGas.push(results.contracts[k][f]);
    });
  });

  results.summary = {
    total_constraint_definitions: 14,
    deployment_gas: {
      min:  Math.min(...deployGas),
      max:  Math.max(...deployGas),
      avg:  Math.round(deployGas.reduce((a, b) => a + b) / deployGas.length),
      values: Object.fromEntries(defKeys.map(k => [k, results.contracts[k].deploy_gas]))
    },
    execution_gas: {
      min: Math.min(...execGas),
      max: Math.max(...execGas),
      avg: Math.round(execGas.reduce((a, b) => a + b) / execGas.length)
    },
    enforcement_modes: {
      HARD: ['CID','CBTD','CCSD','CCGD'],
      SOFT: ['CECW','CCCW','NRD'],
      ADVISORY_FABRIC_ONLY: 'All 14 definitions on Hyperledger Fabric'
    },
    levels: {
      L1: ['Duration','Cardinality','TemporalDependency','AbsoluteConstraints'],
      L2: ['CrossOrgTD','SyncDeadline','GlobalDeadline'],
      L3: ['CID','CBTD','CCSD','CECW','CCGD','CCCW','NRD']
    },
    pharma_all_satisfied: results.pharma_scenario.all_mandatory_satisfied
  };
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('  Temporal Constraint PoC Evaluation — Ethereum (Hardhat)');
  console.log('  14 Definitions · 3 Levels · Pharma Supply Chain Scenario');
  console.log('══════════════════════════════════════════════════════════════════════');

  console.log('\n◆ LEVEL 1 — Single Chain');
  await evalDuration();
  await evalCardinality();
  await evalTemporalDependency();
  await evalAbsoluteConstraints();

  console.log('\n◆ LEVEL 2 — Multi-Organisation');
  await evalCrossOrgTD();
  await evalSyncDeadline();
  await evalGlobalDeadline();

  console.log('\n◆ LEVEL 3 — Cross-Blockchain (τ_CPR)');
  const mock = await deployMock();
  await evalCID(mock);
  await evalCBTD(mock);
  await evalCCSD(mock);
  await evalCECW(mock);
  await evalCCGD(mock);
  await evalCCCW(mock);
  await evalNRD(mock);

  console.log('\n◆ PHARMA SCENARIO');
  await evalPharmaScenario(mock);

  buildSummary();

  const outDir  = path.join(__dirname, '../../results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'eth_evaluation.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const S = results.summary;
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(`  Deploy gas  — min=${S.deployment_gas.min.toLocaleString()}  max=${S.deployment_gas.max.toLocaleString()}  avg=${S.deployment_gas.avg.toLocaleString()}`);
  console.log(`  Execute gas — min=${S.execution_gas.min.toLocaleString()}  max=${S.execution_gas.max.toLocaleString()}  avg=${S.execution_gas.avg.toLocaleString()}`);
  console.log(`  Pharma all satisfied: ${S.pharma_all_satisfied}`);
  console.log(`  Results → ${outPath}`);
  console.log('══════════════════════════════════════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
