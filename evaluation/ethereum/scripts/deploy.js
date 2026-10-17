

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance: ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");



  let cprAddress;
  let cprLabel;

  if (process.env.CPR_REGISTRY_ADDRESS) {
    cprAddress = process.env.CPR_REGISTRY_ADDRESS;
    cprLabel   = "CrossChainProofRegistry (existing)";
    console.log(`Using existing CPR registry at ${cprAddress}`);
  } else if (process.env.MOCK_CPR === "true") {
    const MockCPR = await ethers.getContractFactory("MockCPRRegistry");
    const mock = await MockCPR.deploy();
    await mock.waitForDeployment();
    cprAddress = await mock.getAddress();
    cprLabel   = "MockCPRRegistry";
    console.log(`[1] MockCPRRegistry deployed at ${cprAddress}`);
  } else {



    try {
      const Registry = await ethers.getContractFactory("CrossChainProofRegistry");
      const registry = await Registry.deploy();
      await registry.waitForDeployment();
      cprAddress = await registry.getAddress();
      cprLabel   = "CrossChainProofRegistry";
      console.log(`[1] CrossChainProofRegistry deployed at ${cprAddress}`);
    } catch (e) {
      console.error("CrossChainProofRegistry not available — rerun with MOCK_CPR=true for local dev");
      process.exit(1);
    }
  }
















  let cprForProcess;

  if (process.env.MOCK_CPR === "true") {

    cprForProcess = cprAddress;
    console.log(`[2] Skipping CPRAdapter — MockCPRRegistry implements ICPRRegistry directly`);
  } else {

    const usedSimple = process.env.CPR_ADAPTER_SIMPLE !== "false";
    const adapterName = usedSimple ? "CPRAdapterSimple" : "CPRAdapter";
    const Adapter = await ethers.getContractFactory(adapterName);
    const adapter = await Adapter.deploy(cprAddress);
    await adapter.waitForDeployment();
    cprForProcess = await adapter.getAddress();
    console.log(`[2] ${adapterName} deployed at ${cprForProcess}`);
    console.log(`    → wraps ${cprLabel} at ${cprAddress}`);
  }



  const logisticsAddr  = process.env.LOGISTICS_ADDRESS  || deployer.address;
  const regulatoryAddr = process.env.REGULATORY_ADDRESS || deployer.address;








  const PharmaFactory = await ethers.getContractFactory("pharma_batch");
  const pharma = await PharmaFactory.deploy(
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    cprForProcess,
    logisticsAddr,
    regulatoryAddr
  );
  await pharma.waitForDeployment();
  const pharmaAddr = await pharma.getAddress();
  console.log(`[3] pharma_batch deployed at ${pharmaAddr}`);
  console.log(`    → _cpr:        ${cprForProcess}`);
  console.log(`    → _logistics:  ${logisticsAddr}`);
  console.log(`    → _regulatory: ${regulatoryAddr}`);



  const tx = await pharma.startExecution();
  await tx.wait();
  const marking = await pharma.marking();
  console.log(`\n[4] startExecution() called — marking = ${marking} (expected 1 = E0)`);



  console.log("\n════════════════════════════════════════");
  console.log("DEPLOYMENT SUMMARY");
  console.log("════════════════════════════════════════");
  console.log(`CPR Registry  : ${cprAddress}  (${cprLabel})`);
  console.log(`CPR Adapter   : ${cprForProcess}`);
  console.log(`pharma_batch  : ${pharmaAddr}`);
  console.log(`Logistics     : ${logisticsAddr}`);
  console.log(`Regulatory    : ${regulatoryAddr}`);
  console.log("════════════════════════════════════════");




  try {
    const cidAddr  = await pharma.cid();
    const cbtdAddr = await pharma.cbtd();
    const ccsdAddr = await pharma.ccsd();
    const cecwAddr = await pharma.cecw();
    const ccgdAddr = await pharma.ccgd();
    const cccwAddr = await pharma.cccw();
    const nrdAddr  = await pharma.nrd();
    console.log("\nLevel-3 sub-contracts:");
    console.log(`  CID  : ${cidAddr}`);
    console.log(`  CBTD : ${cbtdAddr}`);
    console.log(`  CCSD : ${ccsdAddr}`);
    console.log(`  CECW : ${cecwAddr}`);
    console.log(`  CCGD : ${ccgdAddr}`);
    console.log(`  CCCW : ${cccwAddr}`);
    console.log(`  NRD  : ${nrdAddr}`);
  } catch (e) {

  }

  return {
    cprRegistry: cprAddress,
    cprAdapter:  cprForProcess,
    pharma:      pharmaAddr,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
