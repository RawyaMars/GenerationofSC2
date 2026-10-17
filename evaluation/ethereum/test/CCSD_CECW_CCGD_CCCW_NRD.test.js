const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function deployContract(name) {
  const C = await ethers.getContractFactory(name);
  const c = await C.deploy();
  return c;
}

describe("CCSD (Definition 10) — Cross-Chain Synchronised Deadline", function () {
  const PID   = ethers.encodeBytes32String("ccsd-proc-001");
  const ORG1  = ethers.encodeBytes32String("logistics-org");
  const ORG2  = ethers.encodeBytes32String("regulatory-org");
  const MSG1  = ethers.encodeBytes32String("ccsd-msg-001");
  const MSG2  = ethers.encodeBytes32String("ccsd-msg-002");

  it("fires when all orgs complete within maxWait", async function () {
    const ccsd = await deployContract("CCSD");

    await ccsd.initGate(PID, [ORG1, ORG2], 5400n);
    await ccsd.markComplete(PID, ORG1, MSG1, 1000n);

    await expect(ccsd.markComplete(PID, ORG2, MSG2, 1000n + 3600n))
      .to.emit(ccsd, "SyncFired");

    expect(await ccsd.isFired(PID)).to.be.true;
  });

  it("reverts when org completes outside maxWait", async function () {
    const ccsd = await deployContract("CCSD");

    await ccsd.initGate(PID, [ORG1, ORG2], 5400n);
    await ccsd.markComplete(PID, ORG1, MSG1, 1000n);

    await expect(ccsd.markComplete(PID, ORG2, MSG2, 1000n + 9000n))
      .to.be.revertedWith("CCSD: org completion outside sync window");
  });

  it("checkExpiry aborts gate when maxWait passed", async function () {
    const ccsd = await deployContract("CCSD");

    await ccsd.initGate(PID, [ORG1, ORG2], 5400n);
    await ccsd.markComplete(PID, ORG1, MSG1, 1000n);

    await expect(ccsd.checkExpiry(PID, 1000n + 6000n))
      .to.emit(ccsd, "SyncAborted");
    expect(await ccsd.isAborted(PID)).to.be.true;
  });

  it("rejects unknown org", async function () {
    const ccsd = await deployContract("CCSD");
    await ccsd.initGate(PID, [ORG1], 5400n);
    await expect(ccsd.markComplete(PID, ORG2, MSG1, 1000n))
      .to.be.revertedWith("org is not a required participant");
  });

  it("measures gas for markComplete", async function () {
    const ccsd = await deployContract("CCSD");
    await ccsd.initGate(PID, [ORG1, ORG2], 5400n);
    const tx = await ccsd.markComplete(PID, ORG1, MSG1, 1000n);
    const r  = await tx.wait();
    console.log("    [gas] CCSD.markComplete:", r.gasUsed.toString());
  });
});

describe("CECW (Definition 11) — Commitment Expiry with Cross-Chain Witness", function () {
  const CID     = ethers.encodeBytes32String("commitment-001");
  const OFFER   = ethers.encodeBytes32String("offer-msg-001");
  const ACCEPT  = ethers.encodeBytes32String("accept-msg-001");

  it("accepts commitment within expiry window", async function () {
    const cecw = await deployContract("CECW");
    const tauOffer = await time.latest();
    await cecw.registerOffer(CID, OFFER, tauOffer, 3600n);
    await time.increase(1800);
    await expect(cecw.accept(CID, ACCEPT))
      .to.emit(cecw, "Accepted");

    expect(await cecw.getState(CID)).to.equal(2n);
  });

  it("transitions to EXPIRED on late acceptance (no revert, state persists)", async function () {
    const cecw = await deployContract("CECW");
    const tauOffer = await time.latest();
    await cecw.registerOffer(CID, OFFER, tauOffer, 3600n);
    await time.increase(5000);
    await expect(cecw.accept(CID, ACCEPT))
      .to.emit(cecw, "Expired");

    expect(await cecw.getState(CID)).to.equal(3n);
  });

  it("checkExpiry marks EXPIRED when time passed", async function () {
    const cecw = await deployContract("CECW");
    const tauOffer = await time.latest();
    await cecw.registerOffer(CID, OFFER, tauOffer, 3600n);

    await cecw.checkExpiry(CID, tauOffer + 5000);
    expect(await cecw.getState(CID)).to.equal(3n);
  });

  it("measures gas for accept (happy path)", async function () {
    const cecw = await deployContract("CECW");
    const tauOffer = await time.latest();
    await cecw.registerOffer(CID, OFFER, tauOffer, 3600n);
    await time.increase(1800);
    const tx = await cecw.accept(CID, ACCEPT);
    const r  = await tx.wait();
    console.log("    [gas] CECW.accept:", r.gasUsed.toString());
  });
});

describe("CCGD (Definition 12) — Cross-Chain Global Deadline", function () {
  const PID   = ethers.encodeBytes32String("ccgd-proc-001");
  const START = ethers.encodeBytes32String("ccgd-start-msg");
  const END   = ethers.encodeBytes32String("ccgd-end-msg");

  it("passes when τ_CPR duration ≤ D_global", async function () {
    const ccgd = await deployContract("CCGD");
    const tauStart = await time.latest();
    await ccgd.recordStart(PID, START, tauStart);
    await time.increase(86400);
    await expect(ccgd.recordEnd(PID, END, 172800n)).not.to.be.reverted;
  });

  it("reverts when τ_CPR duration > D_global", async function () {
    const ccgd = await deployContract("CCGD");
    const tauStart = await time.latest();
    await ccgd.recordStart(PID, START, tauStart);
    await time.increase(200000);
    await expect(ccgd.recordEnd(PID, END, 172800n))
      .to.be.revertedWith("CCGD: global deadline exceeded");
  });

  it("reverts with correct CCGD violation message", async function () {
    const ccgd = await deployContract("CCGD");
    const tauStart = await time.latest();
    await ccgd.recordStart(PID, START, tauStart);
    await time.increase(200000);
    await expect(ccgd.recordEnd(PID, END, 172800n))
      .to.be.revertedWith("CCGD: global deadline exceeded");
  });

  it("rejects end before start recorded", async function () {
    const ccgd = await deployContract("CCGD");
    await expect(ccgd.recordEnd(PID, END, 172800n))
      .to.be.revertedWith("process not started");
  });

  it("measures gas for recordEnd", async function () {
    const ccgd = await deployContract("CCGD");
    const tauStart = await time.latest();
    await ccgd.recordStart(PID, START, tauStart);
    await time.increase(86400);
    const tx = await ccgd.recordEnd(PID, END, 172800n);
    const r  = await tx.wait();
    console.log("    [gas] CCGD.recordEnd:", r.gasUsed.toString());
  });
});

describe("CCCW (Definition 13) — Cross-Chain Compensation Window", function () {
  const PID    = ethers.encodeBytes32String("cccw-proc-001");
  const FAIL   = ethers.encodeBytes32String("cccw-fail-msg");
  const COMP   = ethers.encodeBytes32String("cccw-comp-msg");
  const DONE   = ethers.encodeBytes32String("cccw-done-msg");

  it("completes compensation within window: ACTIVE → COMPENSATING → COMPLETED", async function () {
    const cccw = await deployContract("CCCW");

    await cccw.recordFailure(PID, FAIL, 1000n, 7200n);
    await cccw.startCompensation(PID, COMP, 1000n + 3000n);
    await expect(cccw.completeCompensation(PID, DONE, 1000n + 5000n))
      .to.emit(cccw, "CompensationCompleted");

    expect(await cccw.getState(PID)).to.equal(2n);
  });

  it("transitions to IRRECOVERABLE when window expired (no revert, state persists)", async function () {
    const cccw = await deployContract("CCCW");

    await cccw.recordFailure(PID, FAIL, 1000n, 7200n);
    await expect(cccw.startCompensation(PID, COMP, 1000n + 9000n))
      .to.emit(cccw, "Irrecoverable");

    expect(await cccw.getState(PID)).to.equal(3n);
  });

  it("checkWindow marks IRRECOVERABLE when time passed", async function () {
    const cccw = await deployContract("CCCW");

    await cccw.recordFailure(PID, FAIL, 1000n, 7200n);
    await cccw.checkWindow(PID, 1000n + 9000n);

    expect(await cccw.getState(PID)).to.equal(3n);
  });

  it("measures gas for startCompensation", async function () {
    const cccw = await deployContract("CCCW");
    await cccw.recordFailure(PID, FAIL, 1000n, 7200n);
    const tx = await cccw.startCompensation(PID, COMP, 1000n + 3000n);
    const r  = await tx.wait();
    console.log("    [gas] CCCW.startCompensation:", r.gasUsed.toString());
  });
});

describe("NRD (Definition 14) — Non-Repudiation Deadline", function () {
  const MSG_ID = ethers.encodeBytes32String("nrd-msg-001");
  const SEND   = ethers.encodeBytes32String("nrd-send-msg");
  const ACK    = ethers.encodeBytes32String("nrd-ack-msg");

  it("acknowledges within window — no evidence", async function () {
    const nrd  = await deployContract("NRD");
    const tauSend = await time.latest();
    await nrd.registerSend(MSG_ID, SEND, tauSend, 3600n);
    await time.increase(1800);
    await expect(nrd.registerAck(MSG_ID, ACK))
      .to.emit(nrd, "AckRecorded");

    expect(await nrd.getState(MSG_ID)).to.equal(1n);
  });

  it("emits NonReceiptEvidence and transitions to EVIDENCE_ISSUED on late ack", async function () {
    const nrd  = await deployContract("NRD");
    const tauSend = await time.latest();
    await nrd.registerSend(MSG_ID, SEND, tauSend, 3600n);
    await time.increase(5000);
    await expect(nrd.registerAck(MSG_ID, ACK))
      .to.emit(nrd, "NonReceiptEvidence");

    expect(await nrd.getState(MSG_ID)).to.equal(2n);
  });

  it("claimNonReceipt issues evidence when window expired", async function () {
    const nrd  = await deployContract("NRD");
    const tauSend = await time.latest();
    await nrd.registerSend(MSG_ID, SEND, tauSend, 3600n);

    await expect(nrd.claimNonReceipt(MSG_ID, tauSend + 5000))
      .to.emit(nrd, "NonReceiptEvidence");

    expect(await nrd.getState(MSG_ID)).to.equal(2n);
  });

  it("claimNonReceipt reverts if window not yet expired", async function () {
    const nrd  = await deployContract("NRD");
    const tauSend = await time.latest();
    await nrd.registerSend(MSG_ID, SEND, tauSend, 3600n);

    await expect(nrd.claimNonReceipt(MSG_ID, tauSend + 1000))
      .to.be.revertedWith("window not yet expired");
  });

  it("measures gas for registerAck (happy path)", async function () {
    const nrd  = await deployContract("NRD");
    const tauSend = await time.latest();
    await nrd.registerSend(MSG_ID, SEND, tauSend, 3600n);
    await time.increase(1800);
    const tx = await nrd.registerAck(MSG_ID, ACK);
    const r  = await tx.wait();
    console.log("    [gas] NRD.registerAck:", r.gasUsed.toString());
  });
});
