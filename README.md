# GenerationofSC — temporal-constraint smart contract generation

BPMN models enriched with temporal constraints are transformed into smart
contracts for Ethereum (Solidity) and Hyperledger Fabric (Go chaincode).
The five inter-organisational constraints (CID, CBTD, NRD, CCGD, CCCW) are
generated as **verification only**: a violation is recorded (event + stored
verdict) and never blocks the process.

## Prerequisites

| Tool | Version used | Needed for |
|---|---|---|
| Node.js | 20.x (≥ 18) | code generator, Hardhat |
| npm | 10.x | dependencies |
| Go | ≥ 1.18 | Fabric chaincode build and tests |
| Docker + Fabric samples | Fabric v3.1.x test-network | only for deployment on a real Fabric network |

The first `npm install` / `go test` downloads dependencies, so the machine needs
internet access once.

## 1. Generate smart contracts from BPMN

```bash
cd implementation/codegen
npm install
npm test        # generates Solidity + Go for the pharma scenario and runs the 43 generator tests
```

Generate for a single-process model:

```bash
node cli.js ../bpmn-models/PharmaInterOrgScenario.bpmn --out generated            # Solidity
node cli.js ../bpmn-models/PharmaInterOrgScenario.bpmn --out generated --fabric   # Go chaincode
```

Generate per organisation for a multi-participant collaboration (the platform
comes from `caterpillar:platform` on each participant):

```bash
node cli.js ../bpmn-models/PharmaInterOrgCollaborationInverted.bpmn --org Fabricant  --json --out out/fabricant
node cli.js ../bpmn-models/PharmaInterOrgCollaborationInverted.bpmn --org Regulateur --json --out out/regulateur
```

`--json` also writes the intermediate model (`*.ir.json`).
`implementation/generated-example/` contains the output of the two commands above.

## 2. Ethereum: compile and test the constraint contracts

```bash
cd evaluation/ethereum
npm install
npx hardhat test   # 69 tests
```

The verification-only contracts of the five constraints are also kept in
`implementation/` (`CID.sol`, `CBTD.sol`, `NRD.sol`, `CCGD.sol`, `CCCW.sol`).

## 3. Hyperledger Fabric: build and test the chaincode

```bash
cd evaluation/fabric
go test ./...      # Level 1, 2 and 3 constraints against a mock ledger
```

Build a generated chaincode (reusing the module definition of `evaluation/fabric`):

```bash
cd implementation/codegen
node cli.js ../bpmn-models/PharmaInterOrgScenario.bpmn --fabric --out generated-go
cp ../../evaluation/fabric/go.mod ../../evaluation/fabric/go.sum generated-go/
cd generated-go && go build .
```

## 4. Optional: deploy on a real Fabric network

`evaluation/fabric/fabric_l2l3_evaluate.py` deploys the chaincode as a
service (CCAAS) on the Fabric samples `test-network` (2 organisations) and
replays the scenarios. Before running it, edit the `FABRIC` path at the top of
the script to point to your local `fabric-samples` checkout, and install
`web3` for Python (`pip install web3`).

## Repository layout

```
implementation/
  bpmn-models/        BPMN models with temporal annotations
  codegen/            parser, Solidity generator, Fabric generator, CLI, tests
  generated-example/  generated Solidity (Fabricant) and Go (Regulateur)
  *.sol, level2.go    constraint contracts / chaincode (verification only)
evaluation/
  ethereum/           Hardhat project: contracts, tests, evaluation scripts
  fabric/             Go chaincode for Levels 1–3 with unit tests
  results/            evaluation results and report
```
# GenerationofSC2
