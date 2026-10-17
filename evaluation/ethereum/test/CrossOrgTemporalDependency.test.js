const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CrossOrgTemporalDependency (Definition 5)", function () {
  let cotd, orgA, orgB, stranger;
  const PID = ethers.encodeBytes32String("co-proc-001");
  const minD = 60n, maxD = 300n;

  beforeEach(async function () {
    [, orgA, orgB, stranger] = await ethers.getSigners();
    const COTD = await ethers.getContractFactory("CrossOrgTemporalDependency");
    cotd = await COTD.deploy();
    await cotd.waitForDeployment();


    await cotd.connect(orgA).registerOrgA(PID);
    await cotd.connect(orgB).registerOrgB(PID);
  });


  it("rejects double-registration of OrgA", async function () {
    await expect(cotd.connect(stranger).registerOrgA(PID))
      .to.be.revertedWith("OrgA already registered");
  });

  it("rejects non-OrgA calling orgA_finish_FS", async function () {
    await expect(cotd.connect(orgB).orgA_finish_FS(PID))
      .to.be.revertedWith("caller is not OrgA");
  });

  it("rejects non-OrgB calling orgB_start_FS", async function () {
    await cotd.connect(orgA).orgA_finish_FS(PID);
    await time.increase(120);
    await expect(cotd.connect(orgA).orgB_start_FS(PID, minD, maxD))
      .to.be.revertedWith("caller is not OrgB");
  });


  describe("FS (Finish-to-Start)", function () {
    it("passes when gap is within [minD, maxD]", async function () {
      await cotd.connect(orgA).orgA_finish_FS(PID);
      await time.increase(120);

      const tx = await cotd.connect(orgB).orgB_start_FS(PID, minD, maxD);
      const receipt = await tx.wait();

      const notified = receipt.logs.find(l => l.fragment?.name === "DesignerNotified");
      expect(notified).to.be.undefined;
    });

    it("emits DesignerNotified when gap too short", async function () {
      await cotd.connect(orgA).orgA_finish_FS(PID);
      await time.increase(10);

      const tx = await cotd.connect(orgB).orgB_start_FS(PID, minD, maxD);
      const receipt = await tx.wait();

      const notified = receipt.logs.find(l => l.fragment?.name === "DesignerNotified");
      expect(notified).to.not.be.undefined;
      expect(notified.args.variant).to.equal("FS");
    });

    it("emits DesignerNotified when gap too long", async function () {
      await cotd.connect(orgA).orgA_finish_FS(PID);
      await time.increase(400);

      const tx = await cotd.connect(orgB).orgB_start_FS(PID, minD, maxD);
      const receipt = await tx.wait();

      const notified = receipt.logs.find(l => l.fragment?.name === "DesignerNotified");
      expect(notified).to.not.be.undefined;
    });

    it("measures gas for orgB_start_FS", async function () {
      await cotd.connect(orgA).orgA_finish_FS(PID);
      await time.increase(120);
      const tx = await cotd.connect(orgB).orgB_start_FS(PID, minD, maxD);
      const receipt = await tx.wait();
      console.log("    [gas] orgB_start_FS:", receipt.gasUsed.toString());
    });
  });


  describe("SS (Start-to-Start)", function () {
    it("passes when gap is within range", async function () {
      await cotd.connect(orgA).orgA_start_SS(PID);
      await time.increase(120);

      const tx = await cotd.connect(orgB).orgB_start_SS(PID, minD, maxD);
      const receipt = await tx.wait();

      expect(receipt.logs.find(l => l.fragment?.name === "DesignerNotified")).to.be.undefined;
    });

    it("emits DesignerNotified when gap too short", async function () {
      await cotd.connect(orgA).orgA_start_SS(PID);
      await time.increase(10);

      const tx = await cotd.connect(orgB).orgB_start_SS(PID, minD, maxD);
      const receipt = await tx.wait();

      expect(receipt.logs.find(l => l.fragment?.name === "DesignerNotified")).to.not.be.undefined;
    });

    it("measures gas for orgB_start_SS", async function () {
      await cotd.connect(orgA).orgA_start_SS(PID);
      await time.increase(120);
      const tx = await cotd.connect(orgB).orgB_start_SS(PID, minD, maxD);
      const receipt = await tx.wait();
      console.log("    [gas] orgB_start_SS:", receipt.gasUsed.toString());
    });
  });


  describe("FF (Finish-to-Finish)", function () {
    it("passes when gap is within range", async function () {
      await cotd.connect(orgA).orgA_finish_FF(PID);
      await time.increase(120);

      const tx = await cotd.connect(orgB).orgB_finish_FF(PID, minD, maxD);
      const receipt = await tx.wait();

      expect(receipt.logs.find(l => l.fragment?.name === "DesignerNotified")).to.be.undefined;
    });

    it("emits DesignerNotified when gap too long", async function () {
      await cotd.connect(orgA).orgA_finish_FF(PID);
      await time.increase(400);

      const tx = await cotd.connect(orgB).orgB_finish_FF(PID, minD, maxD);
      const receipt = await tx.wait();

      expect(receipt.logs.find(l => l.fragment?.name === "DesignerNotified")).to.not.be.undefined;
    });

    it("measures gas for orgB_finish_FF", async function () {
      await cotd.connect(orgA).orgA_finish_FF(PID);
      await time.increase(120);
      const tx = await cotd.connect(orgB).orgB_finish_FF(PID, minD, maxD);
      const receipt = await tx.wait();
      console.log("    [gas] orgB_finish_FF:", receipt.gasUsed.toString());
    });
  });


  describe("SF (Start-to-Finish)", function () {
    it("passes when gap is within range", async function () {
      await cotd.connect(orgA).orgA_start_SF(PID);
      await time.increase(120);

      const tx = await cotd.connect(orgB).orgB_finish_SF(PID, minD, maxD);
      const receipt = await tx.wait();

      expect(receipt.logs.find(l => l.fragment?.name === "DesignerNotified")).to.be.undefined;
    });

    it("emits DesignerNotified when gap too short", async function () {
      await cotd.connect(orgA).orgA_start_SF(PID);
      await time.increase(10);

      const tx = await cotd.connect(orgB).orgB_finish_SF(PID, minD, maxD);
      const receipt = await tx.wait();

      expect(receipt.logs.find(l => l.fragment?.name === "DesignerNotified")).to.not.be.undefined;
    });

    it("measures gas for orgB_finish_SF", async function () {
      await cotd.connect(orgA).orgA_start_SF(PID);
      await time.increase(120);
      const tx = await cotd.connect(orgB).orgB_finish_SF(PID, minD, maxD);
      const receipt = await tx.wait();
      console.log("    [gas] orgB_finish_SF:", receipt.gasUsed.toString());
    });
  });
});
