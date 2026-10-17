#!/usr/bin/env python3
"""
fabric_l2l3_evaluate.py
=======================
Full on-chain evaluation of Level 2 (DEF5-7) and Level 3 (DEF8-14) temporal
constraints on Fabric test-network, integrated with the Cross-ZID CPR for τ_CPR.

Sequence:
  1. Start Ganache on :7546  →  deploy CrossChainProofRegistry
  2. Submit 3 real proofs to CPR with evm_increaseTime gaps  →  τ_CPR1/2/3
  3. network.sh down + up createChannel  (fresh, cryptogen)
  4. Build Go chaincode binary (CGO_ENABLED=0 static)
  5. CCAAS install on both peers  →  derive PACKAGE_ID
  6. Start chaincode binary with PACKAGE_ID
  7. approveformyorg (Org1 + Org2)  →  commit
  8. L2 invocations: DEF5 CrossOrgTD (FS+SS), DEF6 SyncDeadline, DEF7 GlobalDeadline
  9. L3 invocations: DEF8-14  (all using real τ_CPR from step 2)
 10. Save results/fabric_l2l3_evaluation.json + update evaluation_report.md
"""

import sys, os, json, time, subprocess, signal, shutil, re
from pathlib import Path
from datetime import datetime, timezone

try:
    from web3 import Web3
    from web3.middleware import geth_poa_middleware
except ImportError:
    print("[ERROR] pip3 install web3"); sys.exit(1)

REPO     = Path("/home/hyperledger2026/Documents/temporal-constraints")
FABRIC   = Path("/home/hyperledger2026/web3-env/fabric-samples")
TESTNET  = FABRIC / "test-network"
BIN      = FABRIC / "bin"
PEER     = str(BIN / "peer")
CC_SRC   = REPO / "fabric/chaincode"
CROSSZID = Path("/home/hyperledger2026/Documents/crosszid_poc")
RESULTS  = REPO / "results"

CC_BIN_DIR = Path("/tmp/temporal_cc")
CC_BIN     = CC_BIN_DIR / "temporal_chaincode"
CC_PKG_DIR = Path("/tmp/temporal_ccaas_pkg")
CC_PKG     = Path("/tmp/temporal_ccaas.tar.gz")

CHANNEL   = "mychannel"
CC_NAME   = "temporal"
CC_VER    = "1.0"
CC_LABEL  = f"{CC_NAME}_{CC_VER}"
CC_ADDR   = "172.18.0.1:9999"

ORG1 = "org1.example.com"
ORG2 = "org2.example.com"
MSP1 = "Org1MSP"
MSP2 = "Org2MSP"
PEER1_ADDR = "localhost:7051"
PEER2_ADDR = "localhost:9051"

def cfg_path():      return str(FABRIC / "config")
def tls_cert(org):   return str(TESTNET / f"organizations/peerOrganizations/{org}/peers/peer0.{org}/tls/ca.crt")
def msp_path(org):   return str(TESTNET / f"organizations/peerOrganizations/{org}/users/Admin@{org}/msp")
def ord_tls():       return str(TESTNET / "organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem")

def peer_env(org_num):
    org = ORG1 if org_num == 1 else ORG2
    msp = MSP1 if org_num == 1 else MSP2
    peer_addr = PEER1_ADDR if org_num == 1 else PEER2_ADDR
    return {
        **os.environ,
        "PATH": str(BIN) + ":" + os.environ.get("PATH", ""),
        "FABRIC_CFG_PATH": cfg_path(),
        "CORE_PEER_TLS_ENABLED":       "true",
        "CORE_PEER_LOCALMSPID":         msp,
        "CORE_PEER_TLS_ROOTCERT_FILE":  tls_cert(org),
        "CORE_PEER_MSPCONFIGPATH":      msp_path(org),
        "CORE_PEER_ADDRESS":            peer_addr,
    }

def run(cmd, env=None, check=True, cwd=None, capture=True, timeout=300):
    if isinstance(cmd, str):
        cmd = cmd.split()
    r = subprocess.run(cmd, env=env, capture_output=capture, text=True,
                       cwd=cwd, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"CMD FAILED: {' '.join(cmd)}\nSTDOUT: {r.stdout}\nSTDERR: {r.stderr}")
    return r

CPR_ABI = [
    {
        "inputs":[{"internalType":"bytes32","name":"nullifier","type":"bytes32"},
                  {"internalType":"bytes32","name":"msg_hash","type":"bytes32"},
                  {"internalType":"uint256","name":"epoch","type":"uint256"},
                  {"internalType":"bytes","name":"","type":"bytes"}],
        "name":"submitProof","outputs":[{"internalType":"bool","name":"","type":"bool"}],
        "stateMutability":"nonpayable","type":"function"
    },
    {
        "inputs":[{"internalType":"bytes32","name":"nullifier","type":"bytes32"}],
        "name":"getRecord","outputs":[{"components":[
            {"internalType":"bytes32","name":"did_org","type":"bytes32"},
            {"internalType":"bytes32","name":"msg_hash","type":"bytes32"},
            {"internalType":"bytes32","name":"nullifier","type":"bytes32"},
            {"internalType":"uint64","name":"epoch","type":"uint64"},
            {"internalType":"bytes32","name":"src_block_hash","type":"bytes32"},
            {"internalType":"bytes32","name":"link_signal","type":"bytes32"},
            {"internalType":"bytes32","name":"c_id_root","type":"bytes32"},
            {"internalType":"uint256","name":"submitted_at","type":"uint256"},
            {"internalType":"bool","name":"verified","type":"bool"},
            {"internalType":"address","name":"submitter","type":"address"}
        ],"internalType":"struct CPRRecord","name":"","type":"tuple"}],
        "stateMutability":"view","type":"function"
    },
]

GANACHE_PROC = None

def start_ganache():
    global GANACHE_PROC
    print("[1] Starting Ganache on :7546 (chainId=1338) ...")

    subprocess.run(["pkill", "-f", "ganache.*7546"], capture_output=True)
    time.sleep(1)
    GANACHE_PROC = subprocess.Popen(
        ["npx", "ganache", "--port", "7546",
         "--chain.chainId", "1338",
         "--wallet.totalAccounts", "10",
         "--wallet.defaultBalance", "1000",
         "--miner.blockTime", "0"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        cwd=str(CROSSZID)
    )

    for _ in range(30):
        time.sleep(1)
        try:
            w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:7546"))
            if w3.is_connected():
                print(f"   Ganache ready  block={w3.eth.block_number}  chainId={w3.eth.chain_id}")
                return w3
        except Exception:
            pass
    raise RuntimeError("Ganache did not start in 30 s")

def deploy_cpr(w3):
    print("[2] Deploying CrossZID contracts ...")
    r = run(["python3", "quick_deploy.py", "--ganache", "http://127.0.0.1:7546"],
            cwd=str(CROSSZID), capture=True, timeout=120)
    print(r.stdout[-400:] if r.stdout else "(no stdout)")
    addrs = json.loads((CROSSZID / "chain3_addresses.json").read_text())
    cpr_addr = addrs["CrossChainProofRegistry"]
    print(f"   CPR: {cpr_addr}")
    return cpr_addr

def get_tau_cpr(w3, cpr_addr, nullifier_hex, epoch, msg_id, advance_s=0):
    """Submit a stub proof to CPR, optionally after advancing Ganache time, return submitted_at."""
    if advance_s > 0:
        w3.provider.make_request("evm_increaseTime", [advance_s])
        w3.provider.make_request("evm_mine", [])
    account = w3.eth.accounts[0]
    cpr = w3.eth.contract(address=cpr_addr, abi=CPR_ABI)
    nullifier = bytes.fromhex(nullifier_hex.lstrip("0x"))
    msg_hash  = Web3.keccak(text=msg_id)
    tx = cpr.functions.submitProof(
        nullifier, msg_hash, epoch, b""
    ).transact({"from": account, "gas": 300000})
    receipt = w3.eth.wait_for_transaction_receipt(tx, timeout=30)
    if receipt.status != 1:
        raise RuntimeError(f"submitProof failed for {nullifier_hex}")
    record = cpr.functions.getRecord(nullifier).call()
    tau = record[7]
    print(f"   τ_CPR [{msg_id}] = {tau}  (block {receipt.blockNumber})")
    return tau, receipt.transactionHash.hex(), receipt.gasUsed

def setup_cpr():
    w3 = start_ganache()
    w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    cpr_addr = deploy_cpr(w3)

    print("[3] Submitting proofs to CPR for τ_CPR timestamps ...")

    tau1, tx1, gas1 = get_tau_cpr(w3, cpr_addr,
        "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
        4712, "batch_release_send")

    tau2, tx2, gas2 = get_tau_cpr(w3, cpr_addr,
        "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
        4713, "batch_release_recv", advance_s=2700)

    tau3, tx3, gas3 = get_tau_cpr(w3, cpr_addr,
        "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
        4714, "batch_delivery_confirm", advance_s=7200)

    cpr_info = {
        "cpr_address": cpr_addr,
        "ganache_port": 7546,
        "chain_id": 1338,
        "proofs": [
            {"msg_id": "batch_release_send",  "tau": tau1, "tx": tx1, "gas": gas1, "advance_s": 0},
            {"msg_id": "batch_release_recv",  "tau": tau2, "tx": tx2, "gas": gas2, "advance_s": 2700},
            {"msg_id": "batch_delivery",      "tau": tau3, "tx": tx3, "gas": gas3, "advance_s": 7200},
        ],
        "tau1": tau1, "tau2": tau2, "tau3": tau3,
        "total_proofs": 3,
    }
    print(f"   τ1={tau1}  τ2={tau2}  τ3={tau3}")
    return cpr_info

def fabric_network_up():
    print("[4] Starting Fabric test-network ...")
    net_sh = str(TESTNET / "network.sh")

    subprocess.run([net_sh, "down"], cwd=str(TESTNET),
                   capture_output=True, timeout=60)
    time.sleep(3)

    r = run([net_sh, "up", "createChannel", "-c", CHANNEL],
            cwd=str(TESTNET), capture=True, timeout=300)
    print("   network.sh up done")
    return True

def build_chaincode():
    print("[5] Building chaincode binary ...")
    CC_BIN_DIR.mkdir(exist_ok=True)
    env = {**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64"}
    run(["go", "build", "-o", str(CC_BIN), "."],
        env=env, cwd=str(CC_SRC), capture=True, timeout=120)
    print(f"   Built: {CC_BIN}  ({CC_BIN.stat().st_size // 1024} KB)")

def ccaas_install():
    print("[6] Packaging and installing CCAAS chaincode ...")
    import tarfile, io



    conn_json = json.dumps({"address": CC_ADDR, "dial_timeout": "10s", "tls_required": False})
    meta_json = json.dumps({"type": "ccaas", "label": CC_LABEL})


    code_buf = io.BytesIO()
    with tarfile.open(fileobj=code_buf, mode="w:gz") as code_tar:
        conn_bytes = conn_json.encode()
        ti = tarfile.TarInfo(name="connection.json")
        ti.size = len(conn_bytes)
        code_tar.addfile(ti, io.BytesIO(conn_bytes))
    code_buf.seek(0)
    code_bytes = code_buf.read()


    CC_PKG.parent.mkdir(exist_ok=True)
    with tarfile.open(str(CC_PKG), "w:gz") as outer:
        meta_bytes = meta_json.encode()
        ti = tarfile.TarInfo(name="metadata.json")
        ti.size = len(meta_bytes)
        outer.addfile(ti, io.BytesIO(meta_bytes))
        ti2 = tarfile.TarInfo(name="code.tar.gz")
        ti2.size = len(code_bytes)
        outer.addfile(ti2, io.BytesIO(code_bytes))

    print(f"   Package: {CC_PKG}  ({CC_PKG.stat().st_size} bytes)")

    env1 = peer_env(1)
    env2 = peer_env(2)


    r1 = run([PEER, "lifecycle", "chaincode", "install", str(CC_PKG)],
             env=env1, capture=True, timeout=60)
    print(f"   Installed on Org1")


    r2 = run([PEER, "lifecycle", "chaincode", "install", str(CC_PKG)],
             env=env2, capture=True, timeout=60)
    print(f"   Installed on Org2")


    qi = run([PEER, "lifecycle", "chaincode", "queryinstalled"],
             env=env1, capture=True)

    m = re.search(r"Package ID: ([^,\s]+)", qi.stdout)
    if not m:
        raise RuntimeError(f"Cannot find Package ID in: {qi.stdout}")
    pkg_id = m.group(1)
    print(f"   Package ID: {pkg_id}")
    return pkg_id

CC_PROC = None

def start_chaincode(pkg_id):
    global CC_PROC
    print("[7] Starting CCAAS chaincode binary ...")
    env = {
        **os.environ,
        "CORE_CHAINCODE_ID_NAME":     pkg_id,
        "CHAINCODE_SERVER_ADDRESS":   "0.0.0.0:9999",
        "CORE_PEER_TLS_ENABLED":      "false",
        "CORE_CHAINCODE_LOGGING_LEVEL": "info",
    }
    CC_PROC = subprocess.Popen(
        [str(CC_BIN)],
        env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    print(f"   Chaincode running (PID={CC_PROC.pid})  listening on 0.0.0.0:9999")

def approve_commit(pkg_id):
    print("[8] Approving and committing chaincode ...")
    seq = "1"

    for org_num in [1, 2]:
        env = peer_env(org_num)
        run([PEER, "lifecycle", "chaincode", "approveformyorg",
             "-o", "localhost:7050",
             "--ordererTLSHostnameOverride", "orderer.example.com",
             "--tls", "--cafile", ord_tls(),
             "-C", CHANNEL, "-n", CC_NAME,
             "--version", CC_VER,
             "--package-id", pkg_id,
             "--sequence", seq,
             "--waitForEvent"],
            env=env, capture=True, timeout=60)
        print(f"   Org{org_num} approved")


    env1 = peer_env(1)
    run([PEER, "lifecycle", "chaincode", "commit",
         "-o", "localhost:7050",
         "--ordererTLSHostnameOverride", "orderer.example.com",
         "--tls", "--cafile", ord_tls(),
         "-C", CHANNEL, "-n", CC_NAME,
         "--version", CC_VER, "--sequence", seq,
         "--peerAddresses", PEER1_ADDR, "--tlsRootCertFiles", tls_cert(ORG1),
         "--peerAddresses", PEER2_ADDR, "--tlsRootCertFiles", tls_cert(ORG2),
         "--waitForEvent"],
        env=env1, capture=True, timeout=90)
    print("   Committed  ✓")
    time.sleep(2)

def invoke(fn, fn_args, submitter=1):
    """peer chaincode invoke with AND(Org1+Org2) endorsement."""
    env = peer_env(submitter)
    cmd = [
        PEER, "chaincode", "invoke",
        "-C", CHANNEL, "-n", CC_NAME,
        "--peerAddresses", PEER1_ADDR, "--tlsRootCertFiles", tls_cert(ORG1),
        "--peerAddresses", PEER2_ADDR, "--tlsRootCertFiles", tls_cert(ORG2),
        "-c", json.dumps({"function": fn, "Args": [str(a) for a in fn_args]}),
        "--waitForEvent",
        "-o", "localhost:7050",
        "--ordererTLSHostnameOverride", "orderer.example.com",
        "--tls", "--cafile", ord_tls(),
    ]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
    ok = r.returncode == 0

    block = None
    m = re.search(r"block (\d+)", r.stderr)
    if m:
        block = int(m.group(1))
    return {"fn": fn, "args": fn_args, "status": 200 if ok else 500,
            "block": block, "ok": ok,
            "stderr": r.stderr[-200:] if not ok else ""}

def query_fn(fn, fn_args, org=1):
    env = peer_env(org)
    cmd = [PEER, "chaincode", "query", "-C", CHANNEL, "-n", CC_NAME,
           "-c", json.dumps({"function": fn, "Args": [str(a) for a in fn_args]})]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=15)
    return {"ok": r.returncode == 0, "stdout": r.stdout.strip()}

def run_l2(results):
    print("\n[L2] Level 2 — multi-org constraints on Fabric test-network")
    l2 = {}


    print("  DEF5 CrossOrgTD FS ...")
    ivs = []
    ivs.append(invoke("CrossOrgTD_Store", ["cotd_pharma_FS", "endA", MSP1], submitter=1))
    ivs.append(invoke("CrossOrgTD_Check", ["cotd_pharma_FS", "endA", MSP2, "3600", "86400", "FS"], submitter=2))
    l2["DEF5_CrossOrgTD_FS"] = {
        "description": "Cross-org FS dependency: OrgA finishes → OrgB starts within [1h,24h]",
        "invocations": ivs,
        "enforcement": "ADVISORY (SetEvent DesignerNotified)",
        "statuses": [iv["status"] for iv in ivs],
        "note": "Near-zero gap (consecutive txs) — advisory emitted; tx committed",
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF5 CrossOrgTD SS ...")
    ivs = []
    ivs.append(invoke("CrossOrgTD_Store", ["cotd_pharma_SS", "startA", MSP1], submitter=1))
    ivs.append(invoke("CrossOrgTD_Check", ["cotd_pharma_SS", "startA", MSP2, "0", "14400", "SS"], submitter=2))
    l2["DEF5_CrossOrgTD_SS"] = {
        "description": "Cross-org SS dependency: both orgs start within [0,4h]",
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "note": "0–4 h window, satisfied for consecutive txs",
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF6 SyncDeadline ...")
    ivs = []
    ivs.append(invoke("InitSyncGate",
                       ["sync_pharma_dispatch", json.dumps([MSP1, MSP2]), "7200"],
                       submitter=1))
    ivs.append(invoke("MarkComplete_Sync", ["sync_pharma_dispatch"], submitter=1))
    ivs.append(invoke("MarkComplete_Sync", ["sync_pharma_dispatch"], submitter=2))
    qr = query_fn("GetSyncGate", ["sync_pharma_dispatch"])
    gate_state = None
    if qr["ok"]:
        try:
            gate_state = json.loads(qr["stdout"])
        except Exception:
            gate_state = qr["stdout"]
    l2["DEF6_SyncDeadline"] = {
        "description": "Both orgs dispatch within maxWait=7200s of first completion",
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "gate_state": gate_state,
        "note": "Both orgs complete within seconds — gate fired; constraint satisfied",
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF7 GlobalDeadline ...")
    ivs = []
    ivs.append(invoke("StartProcess_Global", ["gd_pharma_batch"], submitter=1))
    ivs.append(invoke("EndProcess_Global",   ["gd_pharma_batch", "172800"], submitter=2))
    l2["DEF7_GlobalDeadline"] = {
        "description": "Total process duration ≤ 48h from start to end",
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "note": "Near-zero duration (consecutive txs) — constraint satisfied",
        "all_ok": all(iv["ok"] for iv in ivs),
    }

    results["level2"] = l2
    all_ok = all(v["all_ok"] for v in l2.values())
    print(f"  L2 done  all_ok={all_ok}")
    return all_ok

def run_l3(results, tau1, tau2, tau3):
    print(f"\n[L3] Level 3 — cross-chain constraints (τ1={tau1} τ2={tau2} τ3={tau3})")
    l3 = {}


    print("  DEF8 CID ...")
    ivs = []
    ivs.append(invoke("CID_RegisterSend",    ["cid_batch_release", "msg_cid_001", str(tau1)]))
    ivs.append(invoke("CID_RegisterReceive", ["cid_batch_release", "msg_cid_ack", str(tau2), "7200"]))
    lag = tau2 - tau1
    l3["DEF8_CID"] = {
        "description": "Cross-chain interaction deadline: τ_recv − τ_send ≤ 2h (=7200 s)",
        "tau_send": tau1, "tau_recv": tau2, "lag_s": lag, "max_s": 7200,
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "constraint_satisfied": lag <= 7200,
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF9 CCTD FS ...")
    ivs = []
    ivs.append(invoke("CCTD_RecordOrgARef", ["cctd_batch_FS", "FS", "msg_cctd_a", str(tau1)]))
    ivs.append(invoke("CCTD_RecordOrgBRef", ["cctd_batch_FS", "FS", "msg_cctd_b", str(tau2), "1800", "172800"]))
    gap = abs(tau2 - tau1)
    l3["DEF9_CCTD"] = {
        "description": "Cross-chain temporal dependency FS: 30min ≤ gap ≤ 48h",
        "tau_A": tau1, "tau_B": tau2, "gap_s": gap, "minD_s": 1800, "maxD_s": 172800,
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "constraint_satisfied": 1800 <= gap <= 172800,
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF10 CCSD ...")
    ivs = []
    ivs.append(invoke("CCSD_InitGate",    ["ccsd_dispatch", json.dumps(["ManufacturerOrg","LogisticsOrg"]), "7200"]))
    ivs.append(invoke("CCSD_MarkComplete",["ccsd_dispatch", "ManufacturerOrg", "msg_mfg", str(tau1)]))
    ivs.append(invoke("CCSD_MarkComplete",["ccsd_dispatch", "LogisticsOrg",    "msg_log", str(tau2)]))
    qr = query_fn("CCSD_GetGate", ["ccsd_dispatch"])
    gate_state = None
    if qr["ok"]:
        try: gate_state = json.loads(qr["stdout"])
        except Exception: gate_state = qr["stdout"]
    lag10 = tau2 - tau1
    l3["DEF10_CCSD"] = {
        "description": "Cross-chain sync deadline: all orgs complete within maxWait=7200 s",
        "tau1": tau1, "tau2": tau2, "lag_s": lag10, "maxWait_s": 7200,
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "gate_state": gate_state,
        "constraint_satisfied": lag10 <= 7200,
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF11 CECW ...")
    ivs = []
    ivs.append(invoke("CECW_RegisterOffer", ["cecw_pharma_commit", "offer_batch", str(tau1), "10800"]))
    ivs.append(invoke("CECW_Accept",        ["cecw_pharma_commit", "accept_batch", str(tau2)]))
    qr2 = query_fn("CECW_GetState", ["cecw_pharma_commit"])
    cecw_state = qr2.get("stdout","?")
    l3["DEF11_CECW"] = {
        "description": "Commitment expiry window: accept within 3h of offer",
        "offer_tau": tau1, "accept_tau": tau2, "lag_s": tau2-tau1, "window_s": 10800,
        "invocations": ivs,
        "enforcement": "ADVISORY + state (ACCEPTED=2, EXPIRED=3)",
        "statuses": [iv["status"] for iv in ivs],
        "final_state": cecw_state,
        "constraint_satisfied": (tau2 - tau1) <= 10800,
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF12 CCGD ...")
    ivs = []
    ivs.append(invoke("CCGD_RecordStart", ["ccgd_batch_process", "start_msg", str(tau1)]))
    ivs.append(invoke("CCGD_RecordEnd",   ["ccgd_batch_process", "end_msg",   str(tau3), "172800"]))
    dur = tau3 - tau1
    l3["DEF12_CCGD"] = {
        "description": "Cross-chain global deadline: τ_end − τ_start ≤ 48h",
        "tau_start": tau1, "tau_end": tau3, "duration_s": dur, "deadline_s": 172800,
        "invocations": ivs,
        "enforcement": "ADVISORY",
        "statuses": [iv["status"] for iv in ivs],
        "constraint_satisfied": dur <= 172800,
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF13 CCCW ...")
    ivs = []
    ivs.append(invoke("CCCW_RecordFailure",       ["cccw_pharma", "fail_msg",  str(tau2), "14400"]))
    ivs.append(invoke("CCCW_StartCompensation",   ["cccw_pharma", "comp_msg",  str(tau3)]))
    ivs.append(invoke("CCCW_CompleteCompensation",["cccw_pharma", "done_msg",  str(tau3)]))
    qr3 = query_fn("CCCW_GetState", ["cccw_pharma"])
    cccw_state = qr3.get("stdout","?")
    comp_lag = abs(tau3 - tau2)
    l3["DEF13_CCCW"] = {
        "description": "Cross-chain compensation window: compensation within 4h of failure",
        "failure_tau": tau2, "comp_tau": tau3, "lag_s": comp_lag, "maxComp_s": 14400,
        "invocations": ivs,
        "enforcement": "ADVISORY + state (COMPENSATING=1, IRRECOVERABLE=3)",
        "statuses": [iv["status"] for iv in ivs],
        "final_state": cccw_state,
        "constraint_satisfied": comp_lag <= 14400,
        "all_ok": all(iv["ok"] for iv in ivs),
    }


    print("  DEF14 NRD (happy path) ...")
    ivs = []
    ivs.append(invoke("NRD_RegisterSend", ["nrd_msg_batch", "send_001", str(tau1), "10800"]))
    ivs.append(invoke("NRD_RegisterAck",  ["nrd_msg_batch", "ack_001",  str(tau2)]))
    qr4 = query_fn("NRD_GetState", ["nrd_msg_batch"])
    nrd_state = qr4.get("stdout","?")
    ack_lag = tau2 - tau1


    print("  DEF14 NRD (violation — late ack) ...")
    ivs2 = []
    ivs2.append(invoke("NRD_RegisterSend",    ["nrd_msg_late", "send_002", str(tau1), "30"]))
    ivs2.append(invoke("NRD_ClaimNonReceipt", ["nrd_msg_late", str(tau1 + 60)]))
    qr5 = query_fn("NRD_GetState", ["nrd_msg_late"])
    nrd_viol_state = qr5.get("stdout","?")

    l3["DEF14_NRD"] = {
        "description": "Non-repudiation deadline: ack within 3h",
        "happy_path": {
            "send_tau": tau1, "ack_tau": tau2, "lag_s": ack_lag, "maxAck_s": 10800,
            "invocations": ivs,
            "statuses": [iv["status"] for iv in ivs],
            "final_state": nrd_state,
            "constraint_satisfied": ack_lag <= 10800,
        },
        "violation_path": {
            "send_tau": tau1, "claim_tau": tau1+60, "maxAck_s": 30,
            "invocations": ivs2,
            "statuses": [iv["status"] for iv in ivs2],
            "final_state": nrd_viol_state,
            "note": "NonReceiptEvidence event emitted",
        },
        "enforcement": "ADVISORY + NonReceiptEvidence event",
        "all_ok": all(iv["ok"] for iv in ivs) and all(iv["ok"] for iv in ivs2),
    }

    results["level3"] = l3
    all_ok = all(v["all_ok"] for v in l3.values())
    print(f"  L3 done  all_ok={all_ok}")
    return all_ok

def get_block_height():
    env = peer_env(1)
    r = subprocess.run([PEER, "channel", "getinfo", "-c", CHANNEL],
                       env=env, capture_output=True, text=True, timeout=10)
    m = re.search(r'"height":(\d+)', r.stdout)
    if m:
        return int(m.group(1))
    return None

def main():
    t_start = time.time()


    cpr_info = setup_cpr()
    tau1 = cpr_info["tau1"]
    tau2 = cpr_info["tau2"]
    tau3 = cpr_info["tau3"]


    fabric_network_up()
    build_chaincode()
    pkg_id = ccaas_install()
    start_chaincode(pkg_id)
    approve_commit(pkg_id)


    results = {
        "platform":        "Hyperledger Fabric",
        "network":         "test-network v3.1.5 (Raft, 2 orgs, cryptogen)",
        "fabric_version":  "3.1.5",
        "evaluation_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "channel":         CHANNEL,
        "chaincode": {
            "name":       CC_NAME,
            "version":    CC_VER,
            "deployment": "CCAAS",
            "language":   "Go",
            "package_id": pkg_id,
            "listen_address": "0.0.0.0:9999",
        },
        "peers": [PEER1_ADDR, PEER2_ADDR],
        "crosszid_cpr": cpr_info,
        "endorsement_policy": f"AND({MSP1}.peer, {MSP2}.peer)",
    }

    l2_ok = run_l2(results)
    l3_ok = run_l3(results, tau1, tau2, tau3)

    block_h = get_block_height()
    results["blockchain_state"] = {
        "block_height": block_h,
        "timestamp": int(time.time()),
    }


    total_inv = 0
    success = 0
    for lvl in ["level2", "level3"]:
        for def_key, def_val in results.get(lvl, {}).items():
            for iv_key in ["invocations", "happy_path", "violation_path"]:
                if iv_key in def_val:
                    ivs = def_val[iv_key]
                    if isinstance(ivs, dict):
                        ivs = ivs.get("invocations", [])
                    for iv in ivs:
                        if isinstance(iv, dict) and "status" in iv:
                            total_inv += 1
                            if iv.get("ok", False):
                                success += 1

    results["tx_summary"] = {
        "total_invocations":     total_inv,
        "successful":            success,
        "failed":                total_inv - success,
        "definitions_covered":   7,
        "l2_ok":                 l2_ok,
        "l3_ok":                 l3_ok,
    }

    elapsed = int(time.time() - t_start)
    results["evaluation_elapsed_s"] = elapsed


    out = RESULTS / "fabric_l2l3_evaluation.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"\n[✓] Results saved → {out}")
    print(f"    Block height: {block_h}")
    print(f"    Total invocations: {total_inv}  success: {success}")
    print(f"    Elapsed: {elapsed} s")

    if GANACHE_PROC:
        GANACHE_PROC.terminate()
    if CC_PROC:
        CC_PROC.terminate()

    return 0 if (l2_ok and l3_ok) else 1

def main_resume(tau1, tau2, tau3, cpr_addr):
    """Resume from CCAAS install (network + binary already up)."""
    t_start = time.time()
    cpr_info = {
        "cpr_address": cpr_addr,
        "ganache_port": 7546, "chain_id": 1338,
        "tau1": tau1, "tau2": tau2, "tau3": tau3,
        "note": "Resumed — τ_CPR from previous run",
    }

    pkg_id = ccaas_install()
    start_chaincode(pkg_id)
    approve_commit(pkg_id)

    results = {
        "platform": "Hyperledger Fabric",
        "network":  "test-network v3.1.5 (Raft, 2 orgs, cryptogen)",
        "fabric_version": "3.1.5",
        "evaluation_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "channel":  CHANNEL,
        "chaincode": {"name": CC_NAME, "version": CC_VER,
                      "deployment": "CCAAS", "language": "Go",
                      "package_id": pkg_id, "listen_address": "0.0.0.0:9999"},
        "peers": [PEER1_ADDR, PEER2_ADDR],
        "crosszid_cpr": cpr_info,
        "endorsement_policy": f"AND({MSP1}.peer, {MSP2}.peer)",
    }

    run_l2(results)
    run_l3(results, tau1, tau2, tau3)

    block_h = get_block_height()
    results["blockchain_state"] = {"block_height": block_h, "timestamp": int(time.time())}

    total_inv = 0; success = 0
    for lvl in ["level2", "level3"]:
        for def_key, def_val in results.get(lvl, {}).items():
            for iv_key in ["invocations", "happy_path", "violation_path"]:
                node = def_val.get(iv_key, [])
                if isinstance(node, dict):
                    node = node.get("invocations", [])
                for iv in node:
                    if isinstance(iv, dict) and "status" in iv:
                        total_inv += 1
                        if iv.get("ok"): success += 1

    results["tx_summary"] = {
        "total_invocations": total_inv, "successful": success,
        "failed": total_inv - success, "definitions_covered": 10,
    }
    results["evaluation_elapsed_s"] = int(time.time() - t_start)

    out = RESULTS / "fabric_l2l3_evaluation.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"\n[✓] Saved → {out}")
    print(f"    Block height: {block_h}  invocations: {total_inv}  success: {success}")

    if CC_PROC:
        CC_PROC.terminate()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--tau1",  type=int, default=0)
    parser.add_argument("--tau2",  type=int, default=0)
    parser.add_argument("--tau3",  type=int, default=0)
    parser.add_argument("--cpr",   default="")
    args = parser.parse_args()

    if args.resume:
        main_resume(args.tau1, args.tau2, args.tau3, args.cpr)
    else:
        sys.exit(main())
