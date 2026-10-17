#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const { parseBPMN, serializeModel }     = require('./parser');
const { genProcessContract, genFactory } = require('./generator');
const { genFabricChaincode }            = require('./fabric-generator');

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: node cli.js <bpmn-file> [--out <dir>] [--fabric] [--org <participantId>]');
  console.log('');
  console.log('  --fabric    Generate Go/Hyperledger Fabric chaincode (default: Solidity)');
  console.log('  --out <dir> Output directory (default: generated)');
  console.log('  --json      Also write the intermediate model (M2M target) as JSON');
  console.log('  --org <id>  Organisation to generate (required for a multi-participant');
  console.log('              collaboration; its own platform then picks Solidity vs Go)');
  process.exit(0);
}

const bpmnPath  = args[0];
const outIdx    = args.indexOf('--out');
const outDir    = outIdx !== -1 ? args[outIdx + 1] : 'generated';
const orgIdx    = args.indexOf('--org');
const orgArg    = orgIdx !== -1 ? args[orgIdx + 1] : null;
let   isFabric  = args.includes('--fabric');
const wantJson  = args.includes('--json');

if (!fs.existsSync(bpmnPath)) {
  console.error(`Error: BPMN file not found: ${bpmnPath}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const xml   = fs.readFileSync(bpmnPath, 'utf8');
const model = parseBPMN(xml);

if (model.organizations.length > 0) {
  if (!orgArg) {
    console.error(`Error: ${path.basename(bpmnPath)} is a multi-participant collaboration.`);
    console.error(`Pass --org <participantId>, one of: ${model.organizations.map(o => o.id).join(', ')}`);
    process.exit(1);
  }
  const org = model.organizations.find(o => o.id === orgArg || o.name === orgArg);
  if (!org) {
    console.error(`Error: unknown participant "${orgArg}". Available: ${model.organizations.map(o => o.id).join(', ')}`);
    process.exit(1);
  }
  if (!org.platform) {
    console.error(`Error: participant "${org.id}" has no caterpillar:platform attribute.`);
    process.exit(1);
  }

  isFabric = org.platform === 'Hyperledger Fabric';

  model.id           = `${model.id}_${org.id}`;
  model.baseContract = org.baseContract;
  model.markingBits  = org.markingBits;
  model.ctorParams   = org.ctorParams;
  model.subContracts = org.subContracts;
  model.compensation = org.compensation;
  model.tasks         = model.tasks.filter(t => t.ownerOrg === org.id || t.ownerOrg == null);
  model.flows          = model.flows.filter(f => f.ownerOrg === org.id || f.ownerOrg == null);
  model.gateways       = model.gateways.filter(g => g.ownerOrg === org.id || g.ownerOrg == null);
}

const platform = isFabric ? 'Hyperledger Fabric (Go)' : 'Ethereum (Solidity)';

console.log(`\nCaterpillar Temporal Code Generator`);
console.log(`====================================`);
console.log(`Input    : ${path.resolve(bpmnPath)}`);
console.log(`Process  : ${model.id} — "${model.name}"`);
console.log(`Platform : ${platform}`);
console.log(`Tasks    : ${model.tasks.length}`);

if (!isFabric) {
  console.log(`L3 sub-contracts : ${model.subContracts.map(s => s.contractName).join(', ') || 'none'}`);
}

console.log(`Output   : ${path.resolve(outDir)}/\n`);

model.tasks.forEach(t => {
  const cnames = t.constraints.map(c =>
    `${c.def}${c.variant ? '/' + c.variant : ''}(${c.role || '-'})`).join(', ');
  console.log(`  Task "${t.name}"`);
  if (!isFabric) console.log(`    executedBy=${t.executedBy}  inFlow=E${t.inFlow}  outFlow=E${t.outFlow}`);
  if (cnames) console.log(`    constraints: ${cnames}`);
});

if (model.compensation) {
  const cnames = model.compensation.constraints.map(c => c.def).join(', ');
  console.log(`\n  Compensation subprocess: ${model.compensation.name} [${cnames}]`);
}

if (wantJson) {
  const irFile = path.join(outDir, `${model.id}.ir.json`);
  fs.writeFileSync(irFile, serializeModel(model), 'utf8');
  console.log(`Wrote intermediate model → ${irFile}`);
}

if (isFabric) {

  const goCode = genFabricChaincode(model);
  const goFile = path.join(outDir, `${model.id}_chaincode.go`);
  fs.writeFileSync(goFile, goCode, 'utf8');
  console.log(`\nWrote Fabric chaincode  → ${goFile}`);
  console.log(`\nDone. To build: cd ${outDir} && go build .`);
} else {

  const processSol = genProcessContract(model);
  const processFile = path.join(outDir, `${model.id}.sol`);
  fs.writeFileSync(processFile, processSol, 'utf8');
  console.log(`\nWrote process contract  → ${processFile}`);

  const factorySol = genFactory(model);
  const factoryFile = path.join(outDir, `${model.id}_Factory.sol`);
  fs.writeFileSync(factoryFile, factorySol, 'utf8');
  console.log(`Wrote factory contract  → ${factoryFile}`);

  console.log(`\nDone. Run: cd ../../ethereum && npx hardhat compile`);
}
