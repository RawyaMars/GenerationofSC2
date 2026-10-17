'use strict';

function goIdent(s) {
  return s.replace(/[^A-Za-z0-9]/g, '_');
}

function taskFnName(task) {
  return 'Execute_' + task.id.replace(/^Task_/, '').replace(/[^A-Za-z0-9]/g, '_');
}

function ccStructName(model) {
  return goIdent(model.id) + 'Chaincode';
}

function collectDefs(model) {
  const defs = new Set();
  model.tasks.forEach(t => t.constraints.forEach(c => defs.add(c.def)));
  if (model.compensation) {
    model.compensation.constraints.forEach(c => defs.add(c.def));
  }
  return defs;
}

const STATE_TYPE_DEFS = {
  DUR: `// DUR: Timer Variable for duration constraint
type DURState struct {
\tStartTime int64 \`json:"startTime"\`
\tStarted   bool  \`json:"started"\`
}`,

  CARD: `// CARD: Timer Variable for cardinality constraint
type CARDState struct {
\tWindowStart int64 \`json:"windowStart"\`
\tWindowEnd   int64 \`json:"windowEnd"\`
\tCount       int64 \`json:"count"\`
\tMaxCount    int64 \`json:"maxCount"\`
\tMaxWindow   int64 \`json:"maxWindow"\`
\tInitialised bool  \`json:"initialised"\`
}`,

  GD: `// GD: Timer Variable for global deadline (L2)
type GDState struct {
\tStartTime int64 \`json:"startTime"\`
\tStarted   bool  \`json:"started"\`
\tEnded     bool  \`json:"ended"\`
}`,

  COTD: `// COTD: Timer Variable for cross-org temporal dependency (L2)
type COTDState struct {
\tRefTime int64  \`json:"refTime"\`
\tOrgMSP  string \`json:"orgMsp"\`
\tStored  bool   \`json:"stored"\`
}`,

  SYNC: `// SYNC: Timer Variable for synchronised deadline gate (L2)
type SYNCGateState struct {
\tRequired  []string         \`json:"required"\`
\tCompleted map[string]int64 \`json:"completed"\`
\tFirstTime int64            \`json:"firstTime"\`
\tMaxWait   int64            \`json:"maxWait"\`
\tFired     bool             \`json:"fired"\`
}`,

  CCGD: `// CCGD: Timer Variable for cross-chain global deadline (L3, Def 12)
type CCGDState struct {
\tStartMsgID string \`json:"startMsgId"\`
\tStartTau   int64  \`json:"startTau"\`
\tStarted    bool   \`json:"started"\`
\tEnded      bool   \`json:"ended"\`
}`,

  CID: `// CID: Timer Variable for cross-chain interaction deadline (L3, Def 8)
type CIDState struct {
\tSendMsgID  string \`json:"sendMsgId"\`
\tSendTau    int64  \`json:"sendTau"\`
\tRegistered bool   \`json:"registered"\`
}`,

  CBTD: `// CBTD: Timer Variable for cross-blockchain temporal dependency (L3, Def 9)
type CBTDState struct {
\tMsgID    string \`json:"msgId"\`
\tTau      int64  \`json:"tau"\`
\tRecorded bool   \`json:"recorded"\`
}`,

  CCSD: `// CCSD: Timer Variable for cross-chain synchronised deadline gate (L3, Def 10)
type CCSDGateState struct {
\tRequired  []string         \`json:"required"\`
\tCompleted map[string]int64 \`json:"completed"\`
\tFirstTau  int64            \`json:"firstTau"\`
\tMaxWait   int64            \`json:"maxWait"\`
\tFired     bool             \`json:"fired"\`
\tAborted   bool             \`json:"aborted"\`
}`,

  CECW: `// CECW: Timer Variable for commitment expiry with cross-chain witness (L3, Def 11)
type CommitmentState int

const (
\tCommitmentVoid     CommitmentState = 0
\tCommitmentActive   CommitmentState = 1
\tCommitmentAccepted CommitmentState = 2
\tCommitmentExpired  CommitmentState = 3
)

type CECWState struct {
\tOfferMsgID   string          \`json:"offerMsgId"\`
\tOfferTau     int64           \`json:"offerTau"\`
\tExpiryWindow int64           \`json:"expiryWindow"\`
\tState        CommitmentState \`json:"state"\`
}`,

  CCCW: `// CCCW: Timer Variable for cross-chain compensation window (L3, Def 13)
type CompState int

const (
\tCompActive       CompState = 0
\tCompCompensating CompState = 1
\tCompCompleted    CompState = 2
)

type CCCWState struct {
\tFailureMsgID string    \`json:"failureMsgId"\`
\tFailureTau   int64     \`json:"failureTau"\`
\tMaxCompTime  int64     \`json:"maxCompTime"\`
\tState        CompState \`json:"state"\`
\tViolated     bool      \`json:"violated"\`
}`,

  NRD: `// NRD: Timer Variable for non-repudiation deadline (L3, Def 14)
type AckState int

const (
\tAckPending        AckState = 0
\tAckAcknowledged   AckState = 1
\tAckEvidenceIssued AckState = 2
)

type NRDState struct {
\tSendMsgID  string   \`json:"sendMsgId"\`
\tSendTau    int64    \`json:"sendTau"\`
\tMaxAckTime int64    \`json:"maxAckTime"\`
\tState      AckState \`json:"state"\`
}`,
};

function genStateTypes(defs) {
  return [...defs]
    .filter(d => STATE_TYPE_DEFS[d])
    .map(d => STATE_TYPE_DEFS[d])
    .join('\n\n');
}

const FLOW_STATE_TYPE = `// FLOW: Timer Variable for structural flow/gateway precedence tracking (blocking)
type FlowState struct {
\tExecuted bool  \`json:"executed"\`
\tTime     int64 \`json:"time"\`
}`;

const HELPERS = `func txTimestamp(ctx contractapi.TransactionContextInterface) (int64, error) {
\tts, err := ctx.GetStub().GetTxTimestamp()
\tif err != nil {
\t\treturn 0, fmt.Errorf("GetTxTimestamp: %w", err)
\t}
\treturn ts.AsTime().Unix(), nil
}

func emitAdvisory(ctx contractapi.TransactionContextInterface, def, detail string) {
\tpayload := []byte(fmt.Sprintf(\`{"def":%q,"violation":%q}\`, def, detail))
\t_ = ctx.GetStub().SetEvent("TemporalViolation", payload)
}

// emitCrossChainTrigger announces a Level-3 (cross-blockchain) constraint
// touchpoint, regardless of whether this call is the send or the receive
// side of the interaction -- generic, unlike a hand-written trigger such as
// pharma_manufacturer.go's ad hoc SetEvent("BatchReleaseAnchored", ...).
func emitCrossChainTrigger(ctx contractapi.TransactionContextInterface, def, processID, msgID string, tau int64) {
\tpayload := []byte(fmt.Sprintf(\`{"def":%q,"processId":%q,"msgId":%q,"tau":%d}\`, def, processID, msgID, tau))
\t_ = ctx.GetStub().SetEvent("CrossBlockchainInteractionTriggered", payload)
}`;

const FLOW_HELPERS = `func flowKey(processID, taskID string) string {
\treturn fmt.Sprintf("flow_%s_%s", processID, taskID)
}

func hasTaskExecuted(ctx contractapi.TransactionContextInterface, processID, taskID string) (bool, error) {
\tdata, err := ctx.GetStub().GetState(flowKey(processID, taskID))
\tif err != nil || data == nil {
\t\treturn false, err
\t}
\tvar fs FlowState
\tif err := json.Unmarshal(data, &fs); err != nil {
\t\treturn false, err
\t}
\treturn fs.Executed, nil
}

func recordTaskExecuted(ctx contractapi.TransactionContextInterface, processID, taskID string, now int64) error {
\tdata, err := json.Marshal(FlowState{Executed: true, Time: now})
\tif err != nil {
\t\treturn err
\t}
\treturn ctx.GetStub().PutState(flowKey(processID, taskID), data)
}`;

const XOR_CLAIM_HELPERS = `func xorChoiceKey(processID, gatewayID string) string {
\treturn fmt.Sprintf("xorchoice_%s_%s", processID, gatewayID)
}

func claimXorChoice(ctx contractapi.TransactionContextInterface, processID, gatewayID, taskID string) error {
\tkey := xorChoiceKey(processID, gatewayID)
\texisting, err := ctx.GetStub().GetState(key)
\tif err != nil {
\t\treturn err
\t}
\tif existing != nil {
\t\treturn fmt.Errorf("GATEWAY-XOR-CLAIM: XOR split %s already claimed by %s, task %s cannot execute process=%s",
\t\t\tgatewayID, string(existing), taskID, processID)
\t}
\treturn ctx.GetStub().PutState(key, []byte(taskID))
}

func checkXorChoice(ctx contractapi.TransactionContextInterface, processID, gatewayID, taskID string) error {
\tkey := xorChoiceKey(processID, gatewayID)
\texisting, err := ctx.GetStub().GetState(key)
\tif err != nil {
\t\treturn err
\t}
\tif existing == nil {
\t\treturn fmt.Errorf("GATEWAY-XOR-NOT-RESOLVED: XOR split %s not yet resolved, task %s cannot execute process=%s",
\t\t\tgatewayID, taskID, processID)
\t}
\tif string(existing) != taskID {
\t\treturn fmt.Errorf("GATEWAY-XOR-REJECTED: XOR split %s resolved to %s, task %s cannot execute process=%s",
\t\t\tgatewayID, string(existing), taskID, processID)
\t}
\treturn nil
}

// resolveXorChoice is called exactly once, by the resolver task's own
// invocation — its self-firing guard (hasTaskExecuted, first statement in
// every Execute_*) already guarantees at most one call per process instance,
// so this writes unconditionally: there is no concurrent writer to arbitrate,
// unlike claimXorChoice's race between independently-invoked sibling branches.
func resolveXorChoice(ctx contractapi.TransactionContextInterface, processID, gatewayID, taskID string) error {
\treturn ctx.GetStub().PutState(xorChoiceKey(processID, gatewayID), []byte(taskID))
}`;

function goTypeFor(rawType) {
  const t = (rawType || '').trim().toLowerCase();
  if (t === 'string') return 'string';
  if (t === 'bool' || t === 'boolean') return 'bool';
  return 'int64';
}

const EMITTER_ONLY_ROLE = { CID: 'send', CBTD: 'orgA', CCGD: 'start', NRD: 'send', CECW: 'offer' };

function getTaskGoParams(task) {
  const params = [];
  const seenMsg = new Set();
  const seenTau = new Set();
  const seen = new Set();

  for (const c of task.constraints) {



    if (c.cprMsgParam) {
      if (!seenMsg.has(c.cprMsgParam)) {
        params.push({ name: c.cprMsgParam, goType: 'string' });
        seenMsg.add(c.cprMsgParam);
      }
      const emitterRole = EMITTER_ONLY_ROLE[c.def];
      const needsTau = emitterRole === undefined || c.role === emitterRole;
      if (needsTau && !seenTau.has(c.cprMsgParam)) {
        params.push({ name: 'tau_' + c.cprMsgParam, goType: 'int64' });
        seenTau.add(c.cprMsgParam);
      }
    }

    if (c.functionParam) {
      const pname = c.functionParam.split(':')[0].trim();
      const ptype = c.functionParam.split(':')[1];
      if (!seen.has(pname)) {
        params.push({ name: pname, goType: goTypeFor(ptype) });
        seen.add(pname);
      }
    }
  }



  for (const r of (task.xorResolves || [])) {
    const { name, type } = r.decisionParam;
    if (!seen.has(name)) {
      params.push({ name, goType: goTypeFor(type) });
      seen.add(name);
    }
  }

  return params;
}

// The five thesis constraints are verification-only even when a caller
// builds the model by hand with enforcement="hard" (the parser already maps
// them to "verify").
const VERIFICATION_ONLY = new Set(['CID', 'CBTD', 'NRD', 'CCSD', 'CCGD', 'CCCW', 'COTD', 'GD']);

function isHard(c) {
  return c.enforcement === 'hard' && !VERIFICATION_ONLY.has(c.def);
}

function constraintBody(c) {
  const { def, role, variant, cprMsgParam, minD, maxD, globalDeadline, maxCompTime } = c;



  const emitterRole   = EMITTER_ONLY_ROLE[def];
  const useLocalTau   = emitterRole !== undefined && role !== emitterRole;
  const tau = (cprMsgParam && !useLocalTau) ? `tau_${cprMsgParam}` : 'now';
  const msg  = cprMsgParam || '"processID"';
  const v    = variant || 'FS';
  const hard = isHard(c);
  const label = hard ? 'blocking' : 'advisory';

  switch (def) {



    case 'DUR': {
      if (!role || role === 'start') return `\t// DUR-1 Timer Variable: record start timestamp
\tdurKey := fmt.Sprintf("dur_%s", processID)
\tdurS := DURState{StartTime: now, Started: true}
\tif durBytes, _ := json.Marshal(durS); durBytes != nil {
\t\tctx.GetStub().PutState(durKey, durBytes)
\t}
\tctx.GetStub().SetEvent("TaskStarted", []byte(processID))`;

      const min = minD || 0, max = maxD || 86400;
      if (hard) return `\t// DUR-1 Timer Guard: check duration (blocking)
\tdurKey := fmt.Sprintf("dur_%s", processID)
\tif durBytes, err := ctx.GetStub().GetState(durKey); err == nil && durBytes != nil {
\t\tvar durS DURState
\t\tjson.Unmarshal(durBytes, &durS)
\t\tduration := now - durS.StartTime
\t\tif duration < ${min} || duration > ${max} {
\t\t\treturn fmt.Errorf("DUR-1: duration=%d [${min},${max}] process=%s", duration, processID)
\t\t}
\t\tctx.GetStub().DelState(durKey)
\t}
\tctx.GetStub().SetEvent("TaskEnded", []byte(processID))`;

      return `\t// DUR-1 Timer Guard: check duration (advisory)
\tdurKey := fmt.Sprintf("dur_%s", processID)
\tif durBytes, err := ctx.GetStub().GetState(durKey); err == nil && durBytes != nil {
\t\tvar durS DURState
\t\tjson.Unmarshal(durBytes, &durS)
\t\tduration := now - durS.StartTime
\t\tctx.GetStub().DelState(durKey)
\t\tif duration < ${min} || duration > ${max} {
\t\t\temitAdvisory(ctx, "DUR-1", fmt.Sprintf("duration=%d [${min},${max}] process=%s", duration, processID))
\t\t}
\t}
\tctx.GetStub().SetEvent("TaskEnded", []byte(processID))`;
    }

    case 'CARD': {
      if (!role || role === 'init') return `\t// CARD-2 Timer Variable: initialise cardinality window
\tcardKey := fmt.Sprintf("card_%s", processID)
\tcardS := CARDState{
\t\tWindowStart: now, WindowEnd: now + maxWindow,
\t\tCount: 0, MaxCount: maxCount, MaxWindow: maxWindow, Initialised: true,
\t}
\tif cardBytes, _ := json.Marshal(cardS); cardBytes != nil {
\t\tctx.GetStub().PutState(cardKey, cardBytes)
\t}`;

      if (hard) return `\t// CARD-2 Timer Guard: enforce cardinality (blocking)
\tcardKey := fmt.Sprintf("card_%s", processID)
\tif cardBytes, err := ctx.GetStub().GetState(cardKey); err == nil && cardBytes != nil {
\t\tvar cardS CARDState
\t\tjson.Unmarshal(cardBytes, &cardS)
\t\tif now > cardS.WindowEnd {
\t\t\tcardS.WindowStart = now; cardS.WindowEnd = now + cardS.MaxWindow; cardS.Count = 0
\t\t\tctx.GetStub().SetEvent("WindowReset", []byte(processID))
\t\t}
\t\tnewCount := cardS.Count + 1
\t\tif newCount > cardS.MaxCount {
\t\t\treturn fmt.Errorf("CARD-2: count=%d maxCount=%d process=%s", newCount, cardS.MaxCount, processID)
\t\t}
\t\tcardS.Count = newCount
\t\tctx.GetStub().SetEvent("TaskExecuted", []byte(fmt.Sprintf("%s:count=%d", processID, cardS.Count)))
\t\tif updated, _ := json.Marshal(cardS); updated != nil {
\t\t\tctx.GetStub().PutState(cardKey, updated)
\t\t}
\t}`;

      return `\t// CARD-2 Timer Guard: enforce cardinality (advisory)
\tcardKey := fmt.Sprintf("card_%s", processID)
\tif cardBytes, err := ctx.GetStub().GetState(cardKey); err == nil && cardBytes != nil {
\t\tvar cardS CARDState
\t\tjson.Unmarshal(cardBytes, &cardS)
\t\tif now > cardS.WindowEnd {
\t\t\tcardS.WindowStart = now; cardS.WindowEnd = now + cardS.MaxWindow; cardS.Count = 0
\t\t\tctx.GetStub().SetEvent("WindowReset", []byte(processID))
\t\t}
\t\tcardS.Count++
\t\tctx.GetStub().SetEvent("TaskExecuted", []byte(fmt.Sprintf("%s:count=%d", processID, cardS.Count)))
\t\tif cardS.Count > cardS.MaxCount {
\t\t\temitAdvisory(ctx, "CARD-2", fmt.Sprintf("count=%d maxCount=%d process=%s", cardS.Count, cardS.MaxCount, processID))
\t\t}
\t\tif updated, _ := json.Marshal(cardS); updated != nil {
\t\t\tctx.GetStub().PutState(cardKey, updated)
\t\t}
\t}`;
    }

    case 'TD': {
      const vl = v.toLowerCase();
      if (!role || role === 'refA' || role === 'start') return `\t// TD-3 (${v}) Timer Variable: record reference timestamp
\tctx.GetStub().PutState(fmt.Sprintf("td_a_${vl}_%s", processID), []byte(fmt.Sprintf("%d", now)))`;

      const min = minD || 0, max = maxD || 86400;
      const violation = hard
        ? `\t\t\treturn fmt.Errorf("TD-3: ${v} gap=%d [${min},${max}] process=%s", gap, processID)`
        : `\t\t\temitAdvisory(ctx, "TD-3", fmt.Sprintf("${v} gap=%d [${min},${max}] process=%s", gap, processID))`;
      return `\t// TD-3 (${v}) Timer Guard: check temporal dependency (${label})
\tif tdBytes, err := ctx.GetStub().GetState(fmt.Sprintf("td_a_${vl}_%s", processID)); err == nil && tdBytes != nil {
\t\tvar refA int64
\t\tfmt.Sscanf(string(tdBytes), "%d", &refA)
\t\tgap := now - refA
\t\tif gap < ${min} || gap > ${max} {
${violation}
\t\t}
\t}`;
    }

    case 'ABS': {
      const absType = variant || 'SNLT';
      if (absType === 'MSO') {
        const violation = hard
          ? `\t\treturn fmt.Errorf("ABS-4: MSO: |now-T|=%d > 30 process=%s", diff, processID)`
          : `\t\temitAdvisory(ctx, "ABS-4", fmt.Sprintf("MSO: |now-T|=%d > 30 process=%s", diff, processID))`;
        return `\t// ABS-4 (MSO) Timer Guard: |s(t)−T| ≤ 30 s (${label})
\tif targetTime < 0 { targetTime = -targetTime }
\tdiff := now - targetTime
\tif diff < 0 { diff = -diff }
\tif diff > 30 {
${violation}
\t}`;
      }
      if (absType === 'FNLT') {
        const violation = hard
          ? `\t\treturn fmt.Errorf("ABS-4: FNLT: now=%d > deadline=%d process=%s", now, deadline, processID)`
          : `\t\temitAdvisory(ctx, "ABS-4", fmt.Sprintf("FNLT: now=%d > deadline=%d process=%s", now, deadline, processID))`;
        return `\t// ABS-4 (FNLT) Timer Guard: e(t) ≤ T (${label})
\tif now > deadline {
${violation}
\t}`;
      }
      const violation = hard
        ? `\t\treturn fmt.Errorf("ABS-4: SNLT: now=%d > deadline=%d process=%s", now, deadline, processID)`
        : `\t\temitAdvisory(ctx, "ABS-4", fmt.Sprintf("SNLT: now=%d > deadline=%d process=%s", now, deadline, processID))`;
      return `\t// ABS-4 (SNLT) Timer Guard: s(t) ≤ T (${label})
\tif now > deadline {
${violation}
\t}`;
    }



    case 'COTD': {
      if (!role || role === 'storeA') return `\t// COTD-5 Timer Variable: record OrgA timestamp (MSP-authenticated)
\tmspID, _ := ctx.GetClientIdentity().GetMSPID()
\tcotdKey := fmt.Sprintf("cotd_%s", processID)
\tcotdS := COTDState{RefTime: now, OrgMSP: mspID, Stored: true}
\tif cotdBytes, _ := json.Marshal(cotdS); cotdBytes != nil {
\t\tctx.GetStub().PutState(cotdKey, cotdBytes)
\t}`;

      const min = minD || 0, max = maxD || 86400;





      if (hard) return `\t// COTD-5 Timer Guard: check cross-org temporal dependency (blocking)
\tcotdKey := fmt.Sprintf("cotd_%s", processID)
\tcotdBytes, err := ctx.GetStub().GetState(cotdKey)
\tif err != nil {
\t\treturn err
\t}
\tif cotdBytes == nil {
\t\treturn fmt.Errorf("COTD-5: OrgA reference not yet recorded for process %s", processID)
\t}
\tvar cotdS COTDState
\tjson.Unmarshal(cotdBytes, &cotdS)
\tgap := now - cotdS.RefTime
\tif gap < ${min} || gap > ${max} {
\t\treturn fmt.Errorf("COTD-5: gap=%d [${min},${max}] process=%s", gap, processID)
\t}`;

      return `\t// COTD-5 Timer Guard: check cross-org temporal dependency (advisory)
\tcotdKey := fmt.Sprintf("cotd_%s", processID)
\tif cotdBytes, err := ctx.GetStub().GetState(cotdKey); err == nil && cotdBytes != nil {
\t\tvar cotdS COTDState
\t\tjson.Unmarshal(cotdBytes, &cotdS)
\t\tgap := now - cotdS.RefTime
\t\tif gap < ${min} || gap > ${max} {
\t\t\temitAdvisory(ctx, "COTD-5", fmt.Sprintf("gap=%d [${min},${max}] process=%s", gap, processID))
\t\t}
\t}`;
    }

    case 'SYNC':





      return `\t// SYNC-6 Timer Guard: mark org complete, check sync window (always advisory — see genConstraintCalls carve-out)
\tsyncKey := fmt.Sprintf("sync_%s", processID)
\tmspID, _ := ctx.GetClientIdentity().GetMSPID()
\tif syncBytes, err := ctx.GetStub().GetState(syncKey); err == nil && syncBytes != nil {
\t\tvar syncS SYNCGateState
\t\tjson.Unmarshal(syncBytes, &syncS)
\t\tif !syncS.Fired {
\t\t\tif syncS.Completed == nil {
\t\t\t\tsyncS.Completed = make(map[string]int64)
\t\t\t}
\t\t\tif syncS.FirstTime == 0 {
\t\t\t\tsyncS.FirstTime = now
\t\t\t} else if now-syncS.FirstTime > syncS.MaxWait {
\t\t\t\temitAdvisory(ctx, "SYNC-6", fmt.Sprintf("sync deadline exceeded: lag=%d process=%s org=%s", now-syncS.FirstTime, processID, mspID))
\t\t\t}
\t\t\tsyncS.Completed[mspID] = now
\t\t\tif len(syncS.Completed) >= len(syncS.Required) {
\t\t\t\tsyncS.Fired = true
\t\t\t\tctx.GetStub().SetEvent("SYNCFired", []byte(processID))
\t\t\t}
\t\t\tif updated, _ := json.Marshal(syncS); updated != nil {
\t\t\t\tctx.GetStub().PutState(syncKey, updated)
\t\t\t}
\t\t}
\t}`;

    case 'GD': {
      if (!role || role === 'record' || role === 'start') return `\t// GD-7 Timer Variable: record process start time
\tgdKey := fmt.Sprintf("gd_%s", processID)
\tctx.GetStub().PutState(gdKey, []byte(fmt.Sprintf("%d", now)))`;

      const deadline = maxD || globalDeadline || 86400;

      if (hard) return `\t// GD-7 Timer Guard: check global deadline (blocking)
\tgdKey := fmt.Sprintf("gd_%s", processID)
\tgdBytes, err := ctx.GetStub().GetState(gdKey)
\tif err != nil {
\t\treturn err
\t}
\tif gdBytes == nil {
\t\treturn fmt.Errorf("GD-7: process start not yet recorded for process %s", processID)
\t}
\tvar gdStart int64
\tfmt.Sscanf(string(gdBytes), "%d", &gdStart)
\tif now-gdStart > ${deadline} {
\t\treturn fmt.Errorf("GD-7: global deadline exceeded: elapsed=%d deadline=${deadline} process=%s", now-gdStart, processID)
\t}`;

      return `\t// GD-7 Timer Guard: check global deadline (advisory)
\tgdKey := fmt.Sprintf("gd_%s", processID)
\tif gdBytes, err := ctx.GetStub().GetState(gdKey); err == nil && gdBytes != nil {
\t\tvar gdStart int64
\t\tfmt.Sscanf(string(gdBytes), "%d", &gdStart)
\t\tif now-gdStart > ${deadline} {
\t\t\temitAdvisory(ctx, "GD-7", fmt.Sprintf("global deadline exceeded: elapsed=%d deadline=${deadline} process=%s", now-gdStart, processID))
\t\t}
\t}`;
    }



    case 'CID': {
      if (role === 'send') return `\t// CID-8 Timer Variable: register CPR-witnessed send event
\tcidKey := fmt.Sprintf("cid_send_%s", processID)
\tcidS := CIDState{SendMsgID: ${msg}, SendTau: ${tau}, Registered: true}
\tif cidBytes, _ := json.Marshal(cidS); cidBytes != nil {
\t\tctx.GetStub().PutState(cidKey, cidBytes)
\t}`;




      if (hard) return `\t// CID-8 Timer Guard: check interaction deadline (blocking)
\tcidKey := fmt.Sprintf("cid_send_%s", processID)
\tcidBytes, err := ctx.GetStub().GetState(cidKey)
\tif err != nil {
\t\treturn err
\t}
\tif cidBytes == nil {
\t\treturn fmt.Errorf("CID-8: send event not yet registered for process %s", processID)
\t}
\tvar cidS CIDState
\tjson.Unmarshal(cidBytes, &cidS)
\tlag := ${tau} - cidS.SendTau
\tif lag > maxCIDSeconds {
\t\treturn fmt.Errorf("CID-8: interaction deadline exceeded: lag=%d process=%s", lag, processID)
\t}
\trecvData, _ := json.Marshal(map[string]interface{}{"recvMsgId": ${msg}, "recvTau": ${tau}, "lag": lag})
\tctx.GetStub().PutState(fmt.Sprintf("cid_recv_%s", processID), recvData)`;

      return `\t// CID-8 Timer Guard: check interaction deadline (advisory)
\tcidKey := fmt.Sprintf("cid_send_%s", processID)
\tif cidBytes, err := ctx.GetStub().GetState(cidKey); err == nil && cidBytes != nil {
\t\tvar cidS CIDState
\t\tjson.Unmarshal(cidBytes, &cidS)
\t\tlag := ${tau} - cidS.SendTau
\t\tif lag > maxCIDSeconds {
\t\t\temitAdvisory(ctx, "CID-8", fmt.Sprintf("interaction deadline exceeded: lag=%d process=%s", lag, processID))
\t\t}
\t\trecvData, _ := json.Marshal(map[string]interface{}{"recvMsgId": ${msg}, "recvTau": ${tau}, "lag": lag})
\t\tctx.GetStub().PutState(fmt.Sprintf("cid_recv_%s", processID), recvData)
\t}`;
    }

    case 'CBTD': {
      if (role === 'orgA') return `\t// CBTD-9 (${v}) Timer Variable: record OrgA CPR reference
\tcbtdAKey := fmt.Sprintf("cbtd_a_%s_${v}", processID)
\tcbtdA := CBTDState{MsgID: ${msg}, Tau: ${tau}, Recorded: true}
\tif cbtdBytes, _ := json.Marshal(cbtdA); cbtdBytes != nil {
\t\tctx.GetStub().PutState(cbtdAKey, cbtdBytes)
\t}`;

      const min = minD || 0, max = maxD || 86400;



      if (hard) return `\t// CBTD-9 (${v}) Timer Guard: check cross-blockchain temporal dependency (blocking)
\tcbtdAKey := fmt.Sprintf("cbtd_a_%s_${v}", processID)
\tcbtdBytes, err := ctx.GetStub().GetState(cbtdAKey)
\tif err != nil {
\t\treturn err
\t}
\tif cbtdBytes == nil {
\t\treturn fmt.Errorf("CBTD-9: OrgA reference not yet recorded for process %s", processID)
\t}
\tvar cbtdA CBTDState
\tjson.Unmarshal(cbtdBytes, &cbtdA)
\tgap := ${tau} - cbtdA.Tau
\tif gap < 0 { gap = -gap }
\tif gap < ${min} || gap > ${max} {
\t\treturn fmt.Errorf("CBTD-9: ${v} gap=%d [${min},${max}] process=%s", gap, processID)
\t}
\tcbtdBData, _ := json.Marshal(map[string]interface{}{"msgId": ${msg}, "tau": ${tau}, "gap": gap})
\tctx.GetStub().PutState(fmt.Sprintf("cbtd_b_%s_${v}", processID), cbtdBData)`;

      return `\t// CBTD-9 (${v}) Timer Guard: check cross-blockchain temporal dependency (advisory)
\tcbtdAKey := fmt.Sprintf("cbtd_a_%s_${v}", processID)
\tif cbtdBytes, err := ctx.GetStub().GetState(cbtdAKey); err == nil && cbtdBytes != nil {
\t\tvar cbtdA CBTDState
\t\tjson.Unmarshal(cbtdBytes, &cbtdA)
\t\tgap := ${tau} - cbtdA.Tau
\t\tif gap < 0 { gap = -gap }
\t\tif gap < ${min} || gap > ${max} {
\t\t\temitAdvisory(ctx, "CBTD-9", fmt.Sprintf("${v} gap=%d [${min},${max}] process=%s", gap, processID))
\t\t}
\t\tcbtdBData, _ := json.Marshal(map[string]interface{}{"msgId": ${msg}, "tau": ${tau}, "gap": gap})
\t\tctx.GetStub().PutState(fmt.Sprintf("cbtd_b_%s_${v}", processID), cbtdBData)
\t}`;
    }

    case 'CCSD':




      return `\t// CCSD-10 Timer Guard: mark org completion, always advisory on late arrival (see genConstraintCalls carve-out)
\tccsdKey := fmt.Sprintf("ccsd_%s", processID)
\tif ccsdBytes, err := ctx.GetStub().GetState(ccsdKey); err == nil && ccsdBytes != nil {
\t\tvar ccsdS CCSDGateState
\t\tjson.Unmarshal(ccsdBytes, &ccsdS)
\t\tmspID, _ := ctx.GetClientIdentity().GetMSPID()
\t\tif !ccsdS.Fired && !ccsdS.Aborted {
\t\t\tif ccsdS.Completed == nil {
\t\t\t\tccsdS.Completed = make(map[string]int64)
\t\t\t}
\t\t\tif ccsdS.FirstTau == 0 {
\t\t\t\tccsdS.FirstTau = ${tau}
\t\t\t} else if ${tau}-ccsdS.FirstTau > ccsdS.MaxWait {
\t\t\t\temitAdvisory(ctx, "CCSD-10", fmt.Sprintf("sync window exceeded: lag=%d process=%s org=%s", ${tau}-ccsdS.FirstTau, processID, mspID))
\t\t\t}
\t\t\tccsdS.Completed[mspID] = ${tau}
\t\t\tif len(ccsdS.Completed) >= len(ccsdS.Required) {
\t\t\t\tccsdS.Fired = true
\t\t\t\tctx.GetStub().SetEvent("CCSDFired", []byte(processID))
\t\t\t}
\t\t\tif updated, _ := json.Marshal(ccsdS); updated != nil {
\t\t\t\tctx.GetStub().PutState(ccsdKey, updated)
\t\t\t}
\t\t}
\t}`;

    case 'CECW':



      if (role === 'offer') return `\t// CECW-11 Timer Variable: register CPR-witnessed offer
\tcecwKey := fmt.Sprintf("cecw_%s", processID)
\tcecwS := CECWState{OfferMsgID: ${msg}, OfferTau: ${tau}, ExpiryWindow: expiryWindow, State: CommitmentActive}
\tif cecwBytes, _ := json.Marshal(cecwS); cecwBytes != nil {
\t\tctx.GetStub().PutState(cecwKey, cecwBytes)
\t}`;

      return `\t// CECW-11 Timer Guard: check expiry, state machine (always advisory, state persists)
\tcecwKey := fmt.Sprintf("cecw_%s", processID)
\tif cecwBytes, err := ctx.GetStub().GetState(cecwKey); err == nil && cecwBytes != nil {
\t\tvar cecwS CECWState
\t\tjson.Unmarshal(cecwBytes, &cecwS)
\t\tif cecwS.State == CommitmentActive {
\t\t\tif ${tau} > cecwS.OfferTau+cecwS.ExpiryWindow {
\t\t\t\tcecwS.State = CommitmentExpired
\t\t\t\temitAdvisory(ctx, "CECW-11", fmt.Sprintf("acceptance outside expiry: tau=%d deadline=%d process=%s",
\t\t\t\t\t${tau}, cecwS.OfferTau+cecwS.ExpiryWindow, processID))
\t\t\t} else {
\t\t\t\tcecwS.State = CommitmentAccepted
\t\t\t\tctx.GetStub().SetEvent("CommitmentAccepted", []byte(processID))
\t\t\t}
\t\t\tif updated, _ := json.Marshal(cecwS); updated != nil {
\t\t\t\tctx.GetStub().PutState(cecwKey, updated)
\t\t\t}
\t\t}
\t}`;

    case 'CCGD': {
      if (role === 'start') return `\t// CCGD-12 Timer Variable: record CPR-witnessed process start
\tccgdKey := fmt.Sprintf("ccgd_%s", processID)
\tccgdS := CCGDState{StartMsgID: ${msg}, StartTau: ${tau}, Started: true}
\tif ccgdBytes, _ := json.Marshal(ccgdS); ccgdBytes != nil {
\t\tctx.GetStub().PutState(ccgdKey, ccgdBytes)
\t}`;

      const deadline = globalDeadline || 172800;








      if (hard) return `\t// CCGD-12 Timer Guard: check global deadline (blocking)
\tccgdKey := fmt.Sprintf("ccgd_%s", processID)
\tccgdBytes, err := ctx.GetStub().GetState(ccgdKey)
\tif err != nil {
\t\treturn err
\t}
\tif ccgdBytes == nil {
\t\treturn fmt.Errorf("CCGD-12: process start not yet recorded for process %s", processID)
\t}
\tvar ccgdS CCGDState
\tjson.Unmarshal(ccgdBytes, &ccgdS)
\tduration := ${tau} - ccgdS.StartTau
\tif duration > ${deadline} {
\t\treturn fmt.Errorf("CCGD-12: global deadline exceeded: duration=%d deadline=${deadline} process=%s", duration, processID)
\t}
\tccgdS.Ended = true
\tif updated, _ := json.Marshal(ccgdS); updated != nil {
\t\tctx.GetStub().PutState(ccgdKey, updated)
\t}`;

      return `\t// CCGD-12 Timer Guard: check global deadline (advisory)
\tccgdKey := fmt.Sprintf("ccgd_%s", processID)
\tif ccgdBytes, err := ctx.GetStub().GetState(ccgdKey); err == nil && ccgdBytes != nil {
\t\tvar ccgdS CCGDState
\t\tjson.Unmarshal(ccgdBytes, &ccgdS)
\t\tduration := ${tau} - ccgdS.StartTau
\t\tif duration > ${deadline} {
\t\t\temitAdvisory(ctx, "CCGD-12", fmt.Sprintf("global deadline exceeded: duration=%d deadline=${deadline} process=%s",
\t\t\t\tduration, processID))
\t\t}
\t\tccgdS.Ended = true
\t\tif updated, _ := json.Marshal(ccgdS); updated != nil {
\t\t\tctx.GetStub().PutState(ccgdKey, updated)
\t\t}
\t}`;
    }

    case 'CCCW':




      return `\t// CCCW-13: use Report_Failure / Start_Compensation / Complete_Compensation`;

    case 'NRD': {
      if (role === 'send') return `\t// NRD-14 Timer Variable: register CPR-witnessed send
\tnrdKey := fmt.Sprintf("nrd_%s", processID)
\tnrdS := NRDState{SendMsgID: ${msg}, SendTau: ${tau}, MaxAckTime: maxAckTime, State: AckPending}
\tif nrdBytes, _ := json.Marshal(nrdS); nrdBytes != nil {
\t\tctx.GetStub().PutState(nrdKey, nrdBytes)
\t}`;






      return `\t// NRD-14 Timer Guard: check ack deadline, state machine (always advisory, state persists)
\tnrdKey := fmt.Sprintf("nrd_%s", processID)
\tif nrdBytes, err := ctx.GetStub().GetState(nrdKey); err == nil && nrdBytes != nil {
\t\tvar nrdS NRDState
\t\tjson.Unmarshal(nrdBytes, &nrdS)
\t\tif nrdS.State == AckPending {
\t\t\tlag := ${tau} - nrdS.SendTau
\t\t\tif lag > nrdS.MaxAckTime {
\t\t\t\tnrdS.State = AckEvidenceIssued
\t\t\t\tevidence, _ := json.Marshal(map[string]interface{}{
\t\t\t\t\t"def": "NRD-14", "processId": processID,
\t\t\t\t\t"sendTau": nrdS.SendTau, "ackTau": ${tau}, "maxAckTime": nrdS.MaxAckTime,
\t\t\t\t})
\t\t\t\tctx.GetStub().SetEvent("NonReceiptEvidence", evidence)
\t\t\t} else {
\t\t\t\tnrdS.State = AckAcknowledged
\t\t\t\tctx.GetStub().SetEvent("AckRecorded", []byte(processID))
\t\t\t}
\t\t\tif updated, _ := json.Marshal(nrdS); updated != nil {
\t\t\t\tctx.GetStub().PutState(nrdKey, updated)
\t\t\t}
\t\t}
\t}`;
    }

    default:
      return `\t// ${def} (role=${role}): not handled`;
  }
}

function genSelfFiringGuard(task) {
  const id = JSON.stringify(task.id);
  return `\t// GATEWAY-REFIRE Timer Guard (blocking): a task instance may execute
\t// at most once per processID — Caterpillar's marking bit is single-use
\t// (Table 4.1 "All patterns": deactivates itself on execution).
\tif already, err := hasTaskExecuted(ctx, processID, ${id}); err != nil {
\t\treturn err
\t} else if already {
\t\treturn fmt.Errorf("GATEWAY-REFIRE: task %s already executed for process %s", ${id}, processID)
\t}`;
}

function genPredecessorCheck(task) {
  const id = JSON.stringify(task.id);

  if (task.joinType === 'none' || !task.predecessors || task.predecessors.length === 0) {
    return '';
  }

  if (task.joinType === 'single') {
    const pred = JSON.stringify(task.predecessors[0]);
    return `\t// GATEWAY-SEQ Timer Guard: check structural predecessor (blocking)
\tif ok, err := hasTaskExecuted(ctx, processID, ${pred}); err != nil {
\t\treturn err
\t} else if !ok {
\t\treturn fmt.Errorf("GATEWAY-SEQ: task %s executed before predecessor %s process=%s", ${id}, ${pred}, processID)
\t}`;
  }

  if (task.joinType === 'parallel') {
    const predsLiteral = task.predecessors.map(p => `\t\t${JSON.stringify(p)},`).join('\n');
    return `\t// GATEWAY-PJOIN Timer Guard: check all predecessors joined (blocking)
\t{
\t\tpreds := []string{
${predsLiteral}
\t\t}
\t\tvar missing []string
\t\tfor _, p := range preds {
\t\t\tok, err := hasTaskExecuted(ctx, processID, p)
\t\t\tif err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tif !ok {
\t\t\t\tmissing = append(missing, p)
\t\t\t}
\t\t}
\t\tif len(missing) > 0 {
\t\t\treturn fmt.Errorf("GATEWAY-PJOIN: task %s: missing predecessors %v process=%s", ${id}, missing, processID)
\t\t}
\t}`;
  }


  const predsLiteral = task.predecessors.map(p => `\t\t${JSON.stringify(p)},`).join('\n');
  return `\t// GATEWAY-XOR Timer Guard: check at least one XOR branch fired (blocking)
\t{
\t\tpreds := []string{
${predsLiteral}
\t\t}
\t\tfired := false
\t\tfor _, p := range preds {
\t\t\tok, err := hasTaskExecuted(ctx, processID, p)
\t\t\tif err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tif ok {
\t\t\t\tfired = true
\t\t\t\tbreak
\t\t\t}
\t\t}
\t\tif !fired {
\t\t\treturn fmt.Errorf("GATEWAY-XOR: task %s: no XOR predecessor fired process=%s", ${id}, processID)
\t\t}
\t}`;
}

function genXorClaim(task) {
  if (!task.xorGatewayId) return '';
  const gw = JSON.stringify(task.xorGatewayId);
  const id = JSON.stringify(task.id);

  if (task.xorGatewayConditionsDeclared) {
    return `\t// GATEWAY-XOR-CHECK Timer Guard (blocking): this XOR split is resolved
\t// deterministically by its resolver task's own condition evaluation;
\t// verify this branch was the one chosen. Read-only — no MVCC race, since
\t// the resolver writes the choice exactly once (see resolveXorChoice).
\tif err := checkXorChoice(ctx, processID, ${gw}, ${id}); err != nil {
\t\treturn err
\t}`;
  }

  return `\t// GATEWAY-XOR-CLAIM Timer Guard (blocking): claim this XOR split so only
\t// the first sibling branch to execute proceeds.
\tif err := claimXorChoice(ctx, processID, ${gw}, ${id}); err != nil {
\t\treturn err
\t}`;
}

function genXorResolve(task) {
  if (!task.xorResolves || task.xorResolves.length === 0) return '';

  return task.xorResolves.map(r => {
    const gw = JSON.stringify(r.gatewayId);
    const cases = r.branches
      .map(b => `\t\tcase ${b.condition}:\n\t\t\t_xorTarget = ${JSON.stringify(b.targetTaskId)}`)
      .join('\n');
    const defaultArm = r.defaultTargetTaskId
      ? `\t\tdefault:\n\t\t\t_xorTarget = ${JSON.stringify(r.defaultTargetTaskId)}`
      : `\t\tdefault:\n\t\t\t_xorTarget = ""`;

    return `\t// GATEWAY-XOR-RESOLVE Timer Guard (blocking): evaluate ${gw}'s branch
\t// conditions in declaration order and deterministically record the chosen
\t// downstream task. This is this transaction's only write to the shared
\t// gateway-instance key — the self-firing guard above guarantees this
\t// resolver runs at most once, so there is no concurrent writer to arbitrate.
\t{
\t\tvar _xorTarget string
\t\tswitch {
${cases}
${defaultArm}
\t\t}
\t\tif _xorTarget == "" {
\t\t\treturn fmt.Errorf("GATEWAY-XOR-RESOLVE: no branch condition matched and no default flow for gateway %s process=%s", ${gw}, processID)
\t\t}
\t\tif err := resolveXorChoice(ctx, processID, ${gw}, _xorTarget); err != nil {
\t\t\treturn err
\t\t}
\t}`;
  }).join('\n\n');
}

function genCompletionRecording(task) {
  const id = JSON.stringify(task.id);
  return `\t// GATEWAY: record this task's own completion for downstream precedence checks
\tif err := recordTaskExecuted(ctx, processID, ${id}, now); err != nil {
\t\treturn err
\t}`;
}

function genCrossChainTriggers(task) {
  const seen = new Set();
  const lines = [];
  task.constraints.forEach(c => {
    if (!c.cprMsgParam) return;
    const key = `${c.def}:${c.cprMsgParam}`;
    if (seen.has(key)) return;
    seen.add(key);




    const emitterRole = EMITTER_ONLY_ROLE[c.def];
    const useLocalTau = emitterRole !== undefined && c.role !== emitterRole;
    const tau = useLocalTau ? 'now' : `tau_${c.cprMsgParam}`;
    lines.push(`\temitCrossChainTrigger(ctx, "${c.def}", processID, ${c.cprMsgParam}, ${tau})`);
  });
  return lines.join('\n');
}

function genTaskFunction(task, cc) {
  const fnName  = taskFnName(task);
  const goParams = getTaskGoParams(task);

  const paramStr = [
    'ctx contractapi.TransactionContextInterface',
    'processID string',
    ...goParams.map(p => `${p.name} ${p.goType}`),
  ].join(', ');

  const lines = [];


  lines.push(genSelfFiringGuard(task));



  lines.push('');
  lines.push(`\tnow, err := txTimestamp(ctx)
\tif err != nil {
\t\treturn err
\t}`);

  const predecessorCheck = genPredecessorCheck(task);
  if (predecessorCheck) {
    lines.push('');
    lines.push(predecessorCheck);
  }

  const xorClaim = genXorClaim(task);
  if (xorClaim) {
    lines.push('');
    lines.push(xorClaim);
  }

  const crossChainTriggers = genCrossChainTriggers(task);
  if (crossChainTriggers) {
    lines.push('');
    lines.push(crossChainTriggers);
  }

  for (const c of task.constraints) {
    lines.push('');
    lines.push(constraintBody(c));
  }

  const xorResolve = genXorResolve(task);
  if (xorResolve) {
    lines.push('');
    lines.push(xorResolve);
  }

  lines.push('');
  lines.push(genCompletionRecording(task));

  lines.push('\n\treturn nil');

  return `// ── ${task.name}
func (cc *${cc}) ${fnName}(${paramStr}) error {
${lines.join('\n')}
}`;
}

function genInitProcess(model, cc) {
  const hasCCSD = model.subContracts.some(s => s.contractName === 'CCSD') ||
    model.tasks.some(t => t.constraints.some(c => c.def === 'CCSD'));
  if (!hasCCSD) return '';

  const ccsdSub = model.subContracts.find(s => s.contractName === 'CCSD');
  const gate    = ccsdSub && ccsdSub.initGate;
  const orgs    = gate ? gate.orgs : [];
  const maxWait = gate ? gate.maxWait : '86400';

  const orgsLiteral = orgs.map((_, i) => `\t\torgsJSON[${i}] = "${orgs[i]}"`).join('\n');

  return `// InitProcess initialises the CCSD synchronisation gate for the process instance.
// Call this once after process creation, before any task execution.
func (cc *${cc}) InitProcess(ctx contractapi.TransactionContextInterface, processID string) error {
\tccsdKey := fmt.Sprintf("ccsd_%s", processID)
\texisting, _ := ctx.GetStub().GetState(ccsdKey)
\tif existing != nil {
\t\treturn fmt.Errorf("CCSD gate already initialised for process %s", processID)
\t}
\torgsJSON := make([]string, ${orgs.length})
${orgsLiteral}
\tg := CCSDGateState{
\t\tRequired:  orgsJSON,
\t\tCompleted: make(map[string]int64),
\t\tMaxWait:   ${maxWait},
\t}
\tif data, _ := json.Marshal(g); data != nil {
\t\treturn ctx.GetStub().PutState(ccsdKey, data)
\t}
\treturn nil
}`;
}

function genCompensationFunctions(comp, cc) {
  if (!comp) return '';
  const c = comp.constraints.find(x => x.def === 'CCCW');
  if (!c) return '';

  const fmp  = c.failureMsgParam       || 'failureMsgId';
  const cmp  = c.compensationMsgParam  || 'compMsgId';
  const dmp  = c.doneMsgParam          || 'doneMsgId';
  const mct  = c.maxCompTime           || '7200';

  return `// ── Compensation subprocess (CCCW-13) ───────────────────────────────────────────

// Report_Failure records the CPR-witnessed failure event.
// Timer Variable: CCCWState
func (cc *${cc}) Report_Failure(
\tctx contractapi.TransactionContextInterface,
\tprocessID string,
\t${fmp} string,
\ttau_${fmp} int64,
) error {
\tkey := fmt.Sprintf("cccw_%s", processID)
\texisting, _ := ctx.GetStub().GetState(key)
\tif existing != nil {
\t\treturn fmt.Errorf("failure already recorded for process %s", processID)
\t}
\ts := CCCWState{FailureMsgID: ${fmp}, FailureTau: tau_${fmp}, MaxCompTime: ${mct}, State: CompActive}
\tif data, _ := json.Marshal(s); data != nil {
\t\treturn ctx.GetStub().PutState(key, data)
\t}
\treturn nil
}

// Start_Compensation checks the compensation window (VERIFICATION ONLY).
// Timer Guard: a late start is recorded (Violated + event) but still proceeds.
func (cc *${cc}) Start_Compensation(
\tctx contractapi.TransactionContextInterface,
\tprocessID string,
\t${cmp} string,
\ttau_${cmp} int64,
) error {
\tkey := fmt.Sprintf("cccw_%s", processID)
\tdata, err := ctx.GetStub().GetState(key)
\tif err != nil || data == nil {
\t\treturn fmt.Errorf("no failure recorded for process %s", processID)
\t}
\tvar s CCCWState
\tjson.Unmarshal(data, &s)
\tif s.State != CompActive {
\t\treturn fmt.Errorf("process %s is not in ACTIVE state", processID)
\t}
\tlag := tau_${cmp} - s.FailureTau
\tif lag < 0 { lag = -lag }
\tif lag > s.MaxCompTime {
\t\ts.Violated = true
\t\temitAdvisory(ctx, "CCCW-13", fmt.Sprintf(
\t\t\t"compensation window expired: lag=%d maxCompTime=%d process=%s", lag, s.MaxCompTime, processID))
\t} else {
\t\tctx.GetStub().SetEvent("CompensationStarted", []byte(processID))
\t}
\ts.State = CompCompensating
\tif updated, _ := json.Marshal(s); updated != nil {
\t\tctx.GetStub().PutState(key, updated)
\t}
\treturn nil
}

// Complete_Compensation transitions COMPENSATING → COMPLETED.
func (cc *${cc}) Complete_Compensation(
\tctx contractapi.TransactionContextInterface,
\tprocessID string,
\t${dmp} string,
\ttau_${dmp} int64,
) error {
\tkey := fmt.Sprintf("cccw_%s", processID)
\tdata, err := ctx.GetStub().GetState(key)
\tif err != nil || data == nil {
\t\treturn fmt.Errorf("no compensation record for process %s", processID)
\t}
\tvar s CCCWState
\tjson.Unmarshal(data, &s)
\tif s.State != CompCompensating {
\t\treturn fmt.Errorf("process %s is not in COMPENSATING state", processID)
\t}
\ts.State = CompCompleted
\tctx.GetStub().SetEvent("CompensationCompleted", []byte(processID))
\tif updated, _ := json.Marshal(s); updated != nil {
\t\tctx.GetStub().PutState(key, updated)
\t}
\treturn nil
}`
  .replace(/\$\{fmp\}/g, fmp).replace(/\$\{cmp\}/g, cmp).replace(/\$\{dmp\}/g, dmp)
  .replace(/\$\{mct\}/g, mct)
  .replace(/tau_\$\{fmp\}/g, `tau_${fmp}`)
  .replace(/tau_\$\{cmp\}/g, `tau_${cmp}`)
  .replace(/tau_\$\{dmp\}/g, `tau_${dmp}`);
}

function genMain(cc) {
  return `func main() {
\tcc, err := contractapi.NewChaincode(&${cc}{})
\tif err != nil {
\t\tpanic(fmt.Sprintf("Error creating chaincode: %s", err))
\t}
\tif err := cc.Start(); err != nil {
\t\tpanic(fmt.Sprintf("Error starting chaincode: %s", err))
\t}
}`;
}

function genFabricChaincode(model) {
  const cc   = ccStructName(model);
  const defs = collectDefs(model);

  const sections = [
    `// SPDX-License-Identifier: MIT`,
    `// AUTO-GENERATED by caterpillar-temporal-codegen --fabric`,
    `// Source process : ${model.name || model.id}`,
    `// Temporal model : Abid & Cheikhrouhou 2019 (Defs 1-14)`,
    `// Enforcement    : per-constraint HARD (return error) / SOFT (SetEvent) via`,
    `//                  enforcement attr; CID/CBTD/NRD/CCSD/CCGD/CCCW/COTD/GD verification only`,
    `//                  (SetEvent, never blocks); SYNC/CECW always advisory;`,
    `//                  gateway/flow tracker always hard`,
    `// L3 τ_CPR       : passed as verified int64 parameters (Cross-ZID)`,
    `package main`,
    ``,
    `import (`,
    `\t"encoding/json"`,
    `\t"fmt"`,
    ``,
    `\t"github.com/hyperledger/fabric-contract-api-go/contractapi"`,
    `)`,
    ``,
    `// ── State types ──────────────────────────────────────────────────────────────`,
    ``,
    [genStateTypes(defs), FLOW_STATE_TYPE].filter(Boolean).join('\n\n'),
    ``,
    `// ── Chaincode struct ─────────────────────────────────────────────────────────`,
    ``,
    `type ${cc} struct {`,
    `\tcontractapi.Contract`,
    `}`,
    ``,
    `// ── Helpers ──────────────────────────────────────────────────────────────────`,
    ``,
    HELPERS,
    ``,
    FLOW_HELPERS,
    ``,
    XOR_CLAIM_HELPERS,
    ``,
    `// ── Task functions ────────────────────────────────────────────────────────────`,
    ``,
    ...model.tasks.map(t => genTaskFunction(t, cc)),
    ``,
    `// ── Process initialisation ────────────────────────────────────────────────────`,
    ``,
    genInitProcess(model, cc),
    ``,
    `// ── Compensation ─────────────────────────────────────────────────────────────`,
    ``,
    genCompensationFunctions(model.compensation, cc),
    ``,
    `// ── Entry point ──────────────────────────────────────────────────────────────`,
    ``,
    genMain(cc),
  ];

  return sections.join('\n');
}

module.exports = { genFabricChaincode };
