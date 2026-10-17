const { ethers } = require("hardhat");

async function main() {
  const contracts = [
    {name: "Duration", factory: "Duration", args: []},
    {name: "Cardinality", factory: "Cardinality", args: []},
    {name: "TemporalDependency", factory: "TemporalDependency", args: []},
    {name: "AbsoluteConstraints", factory: "AbsoluteConstraints", args: []},
    {name: "CrossOrgTemporalDependency", factory: "CrossOrgTemporalDependency", args: []},
    {name: "SyncDeadline", factory: "SyncDeadline", args: []},
    {name: "GlobalDeadline", factory: "GlobalDeadline", args: []},
  ];


  const MockCPR = await ethers.getContractFactory("MockCPRRegistry");
  const mock = await MockCPR.deploy();
  const mockTx = mock.deploymentTransaction();
  const mockReceipt = await mockTx.wait();
  const mockAddr = await mock.getAddress();
  console.log(`MockCPRRegistry deploy: ${mockReceipt.gasUsed.toString()} gas`);

  const l3contracts = ["CID","CBTD","CCSD","CECW","CCGD","CCCW","NRD"];

  for (const c of contracts) {
    const F = await ethers.getContractFactory(c.factory);
    const inst = await F.deploy(...c.args);
    const tx = inst.deploymentTransaction();
    const receipt = await tx.wait();
    console.log(`${c.name}: ${receipt.gasUsed.toString()} gas`);
  }

  for (const name of l3contracts) {
    const F = await ethers.getContractFactory(name);
    const inst = await F.deploy(mockAddr);
    const tx = inst.deploymentTransaction();
    const receipt = await tx.wait();
    console.log(`${name}: ${receipt.gasUsed.toString()} gas`);
  }
}

main().catch(console.error);
