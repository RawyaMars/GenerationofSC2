package main

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func (tc *TemporalContract) CrossOrgTD_Store(
	ctx contractapi.TransactionContextInterface,
	processID string,
	role string,
	authorisedMSP string,
) error {
	callerMSP, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("GetMSPID failed: %w", err)
	}
	if callerMSP != authorisedMSP {
		return fmt.Errorf("access denied: caller MSP=%s expected MSP=%s", callerMSP, authorisedMSP)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("cotd_%s_%s", processID, role)
	if err := ctx.GetStub().PutState(key, []byte(fmt.Sprintf("%d", now))); err != nil {
		return fmt.Errorf("PutState failed: %w", err)
	}
	ctx.GetStub().SetEvent("RefPointStored",
		[]byte(fmt.Sprintf("%s:%s:%d", processID, role, now)))
	return nil
}

func (tc *TemporalContract) CrossOrgTD_Check(
	ctx contractapi.TransactionContextInterface,
	processID string,
	refIRole string,
	orgBMSP string,
	minD int64,
	maxD int64,
	variant string,
) error {
	callerMSP, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("GetMSPID failed: %w", err)
	}
	if callerMSP != orgBMSP {
		return fmt.Errorf("access denied: caller MSP=%s expected MSP=%s", callerMSP, orgBMSP)
	}

	refI, err := loadTimestamp(ctx, fmt.Sprintf("cotd_%s_%s", processID, refIRole))
	if err != nil {
		return err
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	refBRole := "startB"
	if variant == "FF" || variant == "SF" {
		refBRole = "endB"
	}
	if err := storeTimestamp(ctx, fmt.Sprintf("cotd_%s_%s", processID, refBRole)); err != nil {
		return err
	}

	if !checkGap(refI, now, minD, maxD) {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("Cross-org %s constraint violated for %s: gap=%d minD=%d maxD=%d",
				variant, processID, now-refI, minD, maxD)))
	}
	return nil
}

type SyncGateState struct {
	ProcessID           string          `json:"processId"`
	FirstCompletionTime int64           `json:"firstCompletionTime"`
	MaxWait             int64           `json:"maxWait"`
	RequiredOrgs        []string        `json:"requiredOrgs"`
	Completed           map[string]bool `json:"completed"`
	CompletedCount      int             `json:"completedCount"`
	Fired               bool            `json:"fired"`
	Aborted             bool            `json:"aborted"`
	Initialised         bool            `json:"initialised"`
}

func (tc *TemporalContract) InitSyncGate(
	ctx contractapi.TransactionContextInterface,
	processID string,
	requiredOrgsJSON string,
	maxWait int64,
) error {
	key := "sync_" + processID
	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if existing != nil {
		var s SyncGateState
		if json.Unmarshal(existing, &s) == nil && s.Initialised {
			return fmt.Errorf("sync gate already initialised for %s", processID)
		}
	}

	var orgs []string
	if err := json.Unmarshal([]byte(requiredOrgsJSON), &orgs); err != nil {
		return fmt.Errorf("invalid requiredOrgs JSON: %w", err)
	}
	if len(orgs) == 0 {
		return fmt.Errorf("at least one org required")
	}

	gate := SyncGateState{
		ProcessID:    processID,
		MaxWait:      maxWait,
		RequiredOrgs: orgs,
		Completed:    make(map[string]bool),
		Initialised:  true,
	}
	data, err := json.Marshal(gate)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, data)
}

func (tc *TemporalContract) MarkComplete_Sync(
	ctx contractapi.TransactionContextInterface,
	processID string,
) error {
	key := "sync_" + processID
	data, err := ctx.GetStub().GetState(key)
	if err != nil || data == nil {
		return fmt.Errorf("sync gate not found for %s", processID)
	}

	var gate SyncGateState
	if err := json.Unmarshal(data, &gate); err != nil {
		return err
	}
	if !gate.Initialised {
		return fmt.Errorf("sync gate not initialised for %s", processID)
	}
	if gate.Fired {
		return fmt.Errorf("sync already fired for %s", processID)
	}
	if gate.Aborted {
		return fmt.Errorf("sync aborted for %s", processID)
	}

	callerMSP, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("GetMSPID failed: %w", err)
	}

	isRequired := false
	for _, org := range gate.RequiredOrgs {
		if org == callerMSP {
			isRequired = true
			break
		}
	}
	if !isRequired {
		return fmt.Errorf("caller MSP %s is not a required participant", callerMSP)
	}
	if gate.Completed[callerMSP] {
		return fmt.Errorf("org %s has already completed", callerMSP)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	gate.Completed[callerMSP] = true
	gate.CompletedCount++

	if gate.FirstCompletionTime == 0 {
		gate.FirstCompletionTime = now
	}

	ctx.GetStub().SetEvent("OrgCompleted",
		[]byte(fmt.Sprintf("%s:%s:%d", processID, callerMSP, now)))

	if now > gate.FirstCompletionTime+gate.MaxWait {
		gate.Aborted = true
		ctx.GetStub().SetEvent("SyncAborted",
			[]byte(fmt.Sprintf("%s:late completion by %s", processID, callerMSP)))
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("SyncDeadline violated for %s: %s arrived late", processID, callerMSP)))
		updData, _ := json.Marshal(gate)
		return ctx.GetStub().PutState(key, updData)
	}

	if gate.CompletedCount == len(gate.RequiredOrgs) {
		gate.Fired = true
		ctx.GetStub().SetEvent("SyncFired",
			[]byte(fmt.Sprintf("%s:%d", processID, now)))
	}

	updData, err := json.Marshal(gate)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, updData)
}

func (tc *TemporalContract) CheckExpiry_Sync(
	ctx contractapi.TransactionContextInterface,
	processID string,
) error {
	key := "sync_" + processID
	data, err := ctx.GetStub().GetState(key)
	if err != nil || data == nil {
		return fmt.Errorf("sync gate not found for %s", processID)
	}

	var gate SyncGateState
	if err := json.Unmarshal(data, &gate); err != nil {
		return err
	}

	if gate.Fired || gate.Aborted || gate.FirstCompletionTime == 0 {
		return nil
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	if now > gate.FirstCompletionTime+gate.MaxWait {
		gate.Aborted = true
		ctx.GetStub().SetEvent("SyncAborted",
			[]byte(fmt.Sprintf("%s:maxWait expired", processID)))
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("SyncDeadline maxWait exceeded for %s", processID)))
		updData, _ := json.Marshal(gate)
		return ctx.GetStub().PutState(key, updData)
	}
	return nil
}

func (tc *TemporalContract) GetSyncGate(
	ctx contractapi.TransactionContextInterface,
	processID string,
) (string, error) {
	data, err := ctx.GetStub().GetState("sync_" + processID)
	if err != nil {
		return "", err
	}
	if data == nil {
		return "", fmt.Errorf("sync gate not found")
	}
	return string(data), nil
}

type GlobalProcessState struct {
	ProcessID string `json:"processId"`
	Initiator string `json:"initiator"`
	StartTime int64  `json:"startTime"`
	Started   bool   `json:"started"`
	Ended     bool   `json:"ended"`
}

func (tc *TemporalContract) StartProcess_Global(
	ctx contractapi.TransactionContextInterface,
	processID string,
) error {
	key := "gd_" + processID
	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if existing != nil {
		var ps GlobalProcessState
		if json.Unmarshal(existing, &ps) == nil && ps.Started {
			return fmt.Errorf("process %s already started", processID)
		}
	}

	callerMSP, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("GetMSPID failed: %w", err)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	ps := GlobalProcessState{
		ProcessID: processID,
		Initiator: callerMSP,
		StartTime: now,
		Started:   true,
	}
	data, err := json.Marshal(ps)
	if err != nil {
		return err
	}

	if err := ctx.GetStub().PutState(key, data); err != nil {
		return fmt.Errorf("PutState failed: %w", err)
	}
	ctx.GetStub().SetEvent("ProcessStarted",
		[]byte(fmt.Sprintf("%s:%s:%d", processID, callerMSP, now)))
	return nil
}

func (tc *TemporalContract) EndProcess_Global(
	ctx contractapi.TransactionContextInterface,
	processID string,
	globalDeadline int64,
) error {
	key := "gd_" + processID
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if data == nil {
		return fmt.Errorf("process %s not started", processID)
	}

	var ps GlobalProcessState
	if err := json.Unmarshal(data, &ps); err != nil {
		return err
	}
	if !ps.Started {
		return fmt.Errorf("process %s not started", processID)
	}
	if ps.Ended {
		return fmt.Errorf("process %s already ended", processID)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	ps.Ended = true
	duration := now - ps.StartTime

	updData, err := json.Marshal(ps)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(key, updData); err != nil {
		return fmt.Errorf("PutState failed: %w", err)
	}

	ctx.GetStub().SetEvent("ProcessEnded",
		[]byte(fmt.Sprintf("%s:duration=%d", processID, duration)))

	if duration > globalDeadline {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("GlobalDeadline exceeded for %s: duration=%d limit=%d",
				processID, duration, globalDeadline)))
	}
	return nil
}
