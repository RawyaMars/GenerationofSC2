package main

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type TaskDurationState struct {
	StartTime int64  `json:"startTime"`
	Started   bool   `json:"started"`
	ProcessID string `json:"processId"`
}

type CardinalityState struct {
	WindowStart int64  `json:"windowStart"`
	WindowEnd   int64  `json:"windowEnd"`
	Count       int64  `json:"count"`
	MaxCount    int64  `json:"maxCount"`
	MaxWindow   int64  `json:"maxWindow"`
	Initialised bool   `json:"initialised"`
	TaskID      string `json:"taskId"`
}

type TemporalContract struct {
	contractapi.Contract
}

func txTimestamp(ctx contractapi.TransactionContextInterface) (int64, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return 0, fmt.Errorf("GetTxTimestamp failed: %w", err)
	}
	return ts.AsTime().Unix(), nil
}

func (tc *TemporalContract) StartTask_Duration(ctx contractapi.TransactionContextInterface, processID string) error {
	key := "dur_" + processID
	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if existing != nil {
		var s TaskDurationState
		if err := json.Unmarshal(existing, &s); err == nil && s.Started {
			return fmt.Errorf("task already started for process %s", processID)
		}
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	state := TaskDurationState{StartTime: now, Started: true, ProcessID: processID}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}

	if err := ctx.GetStub().PutState(key, data); err != nil {
		return fmt.Errorf("PutState failed: %w", err)
	}
	ctx.GetStub().SetEvent("TaskStarted", []byte(processID))
	return nil
}

func (tc *TemporalContract) EndTask_Duration(
	ctx contractapi.TransactionContextInterface,
	processID string,
	minD int64,
	maxD int64,
) error {
	key := "dur_" + processID
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if data == nil {
		return fmt.Errorf("task not started for process %s", processID)
	}

	var state TaskDurationState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	if !state.Started {
		return fmt.Errorf("task not started for process %s", processID)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	duration := now - state.StartTime

	if err := ctx.GetStub().DelState(key); err != nil {
		return fmt.Errorf("DelState failed: %w", err)
	}
	ctx.GetStub().SetEvent("TaskEnded", []byte(fmt.Sprintf("%s:%d", processID, duration)))

	if duration < minD || duration > maxD {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("Duration constraint violated for %s: duration=%d minD=%d maxD=%d",
				processID, duration, minD, maxD)))
	}
	return nil
}

func (tc *TemporalContract) InitTask_Cardinality(
	ctx contractapi.TransactionContextInterface,
	taskID string,
	maxCount int64,
	maxWindow int64,
) error {
	key := "card_" + taskID
	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if existing != nil {
		var s CardinalityState
		if err := json.Unmarshal(existing, &s); err == nil && s.Initialised {
			return fmt.Errorf("task %s already initialised", taskID)
		}
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	state := CardinalityState{
		WindowStart: now,
		WindowEnd:   now + maxWindow,
		Count:       0,
		MaxCount:    maxCount,
		MaxWindow:   maxWindow,
		Initialised: true,
		TaskID:      taskID,
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, data)
}

func (tc *TemporalContract) ExecuteTask_Cardinality(
	ctx contractapi.TransactionContextInterface,
	taskID string,
) error {
	key := "card_" + taskID
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("GetState failed: %w", err)
	}
	if data == nil {
		return fmt.Errorf("task %s not initialised", taskID)
	}

	var state CardinalityState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	if !state.Initialised {
		return fmt.Errorf("task %s not initialised", taskID)
	}

	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	if now > state.WindowEnd {
		state.WindowStart = now
		state.WindowEnd = now + state.MaxWindow
		state.Count = 0
		ctx.GetStub().SetEvent("WindowReset", []byte(taskID))
	}

	state.Count++
	ctx.GetStub().SetEvent("TaskExecuted",
		[]byte(fmt.Sprintf("%s:count=%d", taskID, state.Count)))

	if state.Count > state.MaxCount {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("Cardinality violated for %s: count=%d maxCount=%d",
				taskID, state.Count, state.MaxCount)))
	}

	elapsed := now - state.WindowStart
	if elapsed > state.MaxWindow {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("Cardinality Dmax violated for %s", taskID)))
	}

	updData, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, updData)
}

func storeTimestamp(ctx contractapi.TransactionContextInterface, key string) error {
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, []byte(fmt.Sprintf("%d", now)))
}

func loadTimestamp(ctx contractapi.TransactionContextInterface, key string) (int64, error) {
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return 0, fmt.Errorf("GetState %s failed: %w", key, err)
	}
	if data == nil {
		return 0, fmt.Errorf("timestamp not found for key %s", key)
	}
	var ts int64
	if _, err := fmt.Sscanf(string(data), "%d", &ts); err != nil {
		return 0, fmt.Errorf("parse timestamp failed: %w", err)
	}
	return ts, nil
}

func checkGap(refI, refJ, minD, maxD int64) bool {
	if refJ < refI {
		return false
	}
	gap := refJ - refI
	return gap >= minD && gap <= maxD
}

func (tc *TemporalContract) FinishTaskA_FS(ctx contractapi.TransactionContextInterface, processID string) error {
	return storeTimestamp(ctx, "fs_endA_"+processID)
}

func (tc *TemporalContract) StartTaskB_FS(
	ctx contractapi.TransactionContextInterface,
	processID string,
	minD int64,
	maxD int64,
) error {
	refI, err := loadTimestamp(ctx, "fs_endA_"+processID)
	if err != nil {
		return err
	}
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := storeTimestamp(ctx, "fs_startB_"+processID); err != nil {
		return err
	}

	if !checkGap(refI, now, minD, maxD) {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("FS constraint violated for %s: gap=%d minD=%d maxD=%d",
				processID, now-refI, minD, maxD)))
	}
	return nil
}

func (tc *TemporalContract) StartTaskA_SS(ctx contractapi.TransactionContextInterface, processID string) error {
	return storeTimestamp(ctx, "ss_startA_"+processID)
}

func (tc *TemporalContract) StartTaskB_SS(
	ctx contractapi.TransactionContextInterface,
	processID string,
	minD int64,
	maxD int64,
) error {
	refI, err := loadTimestamp(ctx, "ss_startA_"+processID)
	if err != nil {
		return err
	}
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := storeTimestamp(ctx, "ss_startB_"+processID); err != nil {
		return err
	}

	if !checkGap(refI, now, minD, maxD) {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("SS constraint violated for %s: gap=%d minD=%d maxD=%d",
				processID, now-refI, minD, maxD)))
	}
	return nil
}

func (tc *TemporalContract) FinishTaskA_FF(ctx contractapi.TransactionContextInterface, processID string) error {
	return storeTimestamp(ctx, "ff_endA_"+processID)
}

func (tc *TemporalContract) FinishTaskB_FF(
	ctx contractapi.TransactionContextInterface,
	processID string,
	minD int64,
	maxD int64,
) error {
	refI, err := loadTimestamp(ctx, "ff_endA_"+processID)
	if err != nil {
		return err
	}
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := storeTimestamp(ctx, "ff_endB_"+processID); err != nil {
		return err
	}

	if !checkGap(refI, now, minD, maxD) {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("FF constraint violated for %s: gap=%d minD=%d maxD=%d",
				processID, now-refI, minD, maxD)))
	}
	return nil
}

func (tc *TemporalContract) StartTaskA_SF(ctx contractapi.TransactionContextInterface, processID string) error {
	return storeTimestamp(ctx, "sf_startA_"+processID)
}

func (tc *TemporalContract) FinishTaskB_SF(
	ctx contractapi.TransactionContextInterface,
	processID string,
	minD int64,
	maxD int64,
) error {
	refI, err := loadTimestamp(ctx, "sf_startA_"+processID)
	if err != nil {
		return err
	}
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := storeTimestamp(ctx, "sf_endB_"+processID); err != nil {
		return err
	}

	if !checkGap(refI, now, minD, maxD) {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("SF constraint violated for %s: gap=%d minD=%d maxD=%d",
				processID, now-refI, minD, maxD)))
	}
	return nil
}

const MSOTolerance int64 = 30

func abs64(a, b int64) int64 {
	if a >= b {
		return a - b
	}
	return b - a
}

func (tc *TemporalContract) StartTask_MSO(
	ctx contractapi.TransactionContextInterface,
	processID string,
	targetTime int64,
) error {
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState("mso_start_"+processID, []byte(fmt.Sprintf("%d", now))); err != nil {
		return err
	}
	ctx.GetStub().SetEvent("TaskStarted", []byte(processID))

	if abs64(now, targetTime) > MSOTolerance {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("MSO constraint violated for %s: actual=%d target=%d",
				processID, now, targetTime)))
	}
	return nil
}

func (tc *TemporalContract) StartTask_SNLT(
	ctx contractapi.TransactionContextInterface,
	processID string,
	deadline int64,
) error {
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState("snlt_start_"+processID, []byte(fmt.Sprintf("%d", now))); err != nil {
		return err
	}
	ctx.GetStub().SetEvent("TaskStarted", []byte(processID))

	if now > deadline {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("SNLT constraint violated for %s: actual=%d deadline=%d",
				processID, now, deadline)))
	}
	return nil
}

func (tc *TemporalContract) FinishTask_FNLT(
	ctx contractapi.TransactionContextInterface,
	processID string,
	deadline int64,
) error {
	now, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState("fnlt_end_"+processID, []byte(fmt.Sprintf("%d", now))); err != nil {
		return err
	}
	ctx.GetStub().SetEvent("TaskFinished", []byte(processID))

	if now > deadline {
		ctx.GetStub().SetEvent("DesignerNotified",
			[]byte(fmt.Sprintf("FNLT constraint violated for %s: actual=%d deadline=%d",
				processID, now, deadline)))
	}
	return nil
}

func main() {
	cc, err := contractapi.NewChaincode(&TemporalContract{})
	if err != nil {
		panic(fmt.Sprintf("Error creating temporal chaincode: %s", err))
	}
	if err := cc.Start(); err != nil {
		panic(fmt.Sprintf("Error starting temporal chaincode: %s", err))
	}
}
