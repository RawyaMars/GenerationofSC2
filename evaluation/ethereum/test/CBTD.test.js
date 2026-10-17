const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function deploy() {
  const CBTD = await ethers.getContractFactory("CBTD");
  const cbtd = await CBTD.deploy();
  return { cbtd };
}

const PID   = ethers.encodeBytes32String("cbtd-proc-001");
const A_MSG = ethers.encodeBytes32String("orgA-event-001");
const B_MSG = ethers.encodeBytes32String("orgB-event-001");
const minD  = 1800n;
const maxD  = 14400n;

describe("CBTD (Definition 9) — Cross-Chain Temporal Dependency", function () {
  for (const variant of ["FS", "SS", "FF", "SF"]) {
    describe(`${variant} variant`, function () {
      it(`passes when gap is within [minD, maxD]`, async function () {
        const { cbtd } = await deploy();
        const tauA = await time.latest();
        await cbtd.recordOrgARef(PID, variant, A_MSG, tauA);
        await time.increase(3600);
        await expect(cbtd.recordOrgBRef(PID, variant, B_MSG, minD, maxD))
          .not.to.be.reverted;
      });

      it(`reverts when gap < minD`, async function () {
        const { cbtd } = await deploy();
        const tauA = await time.latest();
        await cbtd.recordOrgARef(PID, variant, A_MSG, tauA);
        await time.increase(600);
        await expect(cbtd.recordOrgBRef(PID, variant, B_MSG, minD, maxD))
          .to.be.revertedWith("CBTD: cross-blockchain temporal dependency violated");
      });

      it(`reverts when gap > maxD`, async function () {
        const { cbtd } = await deploy();
        const tauA = await time.latest();
        await cbtd.recordOrgARef(PID, variant, A_MSG, tauA);
        await time.increase(18000);
        await expect(cbtd.recordOrgBRef(PID, variant, B_MSG, minD, maxD))
          .to.be.revertedWith("CBTD: cross-blockchain temporal dependency violated");
      });

      it(`reverts with correct message on violation (hard enforcement)`, async function () {
        const { cbtd } = await deploy();
        const tauA = await time.latest();
        await cbtd.recordOrgARef(PID, variant, A_MSG, tauA);
        await time.increase(600);
        await expect(cbtd.recordOrgBRef(PID, variant, B_MSG, minD, maxD))
          .to.be.revertedWith("CBTD: cross-blockchain temporal dependency violated");
      });

      it(`emits OrgBRefRecorded with gap on success`, async function () {
        const { cbtd } = await deploy();
        const tauA = await time.latest();
        await cbtd.recordOrgARef(PID, variant, A_MSG, tauA);
        await time.increase(3600);
        const tx = await cbtd.recordOrgBRef(PID, variant, B_MSG, minD, maxD);
        const receipt = await tx.wait();
        const tauB = (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
        await expect(tx)
          .to.emit(cbtd, "OrgBRefRecorded")
          .withArgs(PID, variant, B_MSG, tauB, tauB - tauA);
      });

      it(`measures gas for recordOrgBRef`, async function () {
        const { cbtd } = await deploy();
        const tauA = await time.latest();
        await cbtd.recordOrgARef(PID, variant, A_MSG, tauA);
        await time.increase(3600);
        const tx = await cbtd.recordOrgBRef(PID, variant, B_MSG, minD, maxD);
        const r = await tx.wait();
        console.log(`    [gas] CBTD(${variant}).recordOrgBRef:`, r.gasUsed.toString());
      });
    });
  }

  it("rejects double OrgA registration", async function () {
    const { cbtd } = await deploy();
    const tauA = await time.latest();
    await cbtd.recordOrgARef(PID, "FS", A_MSG, tauA);
    await expect(cbtd.recordOrgARef(PID, "FS", A_MSG, tauA))
      .to.be.revertedWith("OrgA ref already recorded");
  });

  it("rejects OrgB before OrgA", async function () {
    const { cbtd } = await deploy();
    await expect(cbtd.recordOrgBRef(PID, "FS", B_MSG, minD, maxD))
      .to.be.revertedWith("OrgA ref not yet recorded");
  });
});
