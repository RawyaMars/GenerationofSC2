package main

import (
	"crypto/x509"
	"encoding/json"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-chaincode-go/shimtest"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type fakeClientIdentity struct {
	mspID string
}

func (f *fakeClientIdentity) GetID() (string, error)    { return "user@" + f.mspID, nil }
func (f *fakeClientIdentity) GetMSPID() (string, error) { return f.mspID, nil }
func (f *fakeClientIdentity) GetAttributeValue(string) (string, bool, error) {
	return "", false, nil
}
func (f *fakeClientIdentity) AssertAttributeValue(_, _ string) error { return nil }
func (f *fakeClientIdentity) GetX509Certificate() (*x509.Certificate, error) {
	return nil, nil
}

type l2Ctx struct {
	stub  *shimtest.MockStub
	mspID string
}

func (c *l2Ctx) GetStub() shim.ChaincodeStubInterface {
	return c.stub
}

func (c *l2Ctx) GetClientIdentity() cid.ClientIdentity {
	return &fakeClientIdentity{mspID: c.mspID}
}

func newL2Ctx(ts time.Time, mspID string) *l2Ctx {
	s := shimtest.NewMockStub("l2-test", nil)
	s.MockTransactionStart(nextTxID())
	s.TxTimestamp = timestamppb.New(ts)
	return &l2Ctx{stub: s, mspID: mspID}
}

func advL2Ctx(src *l2Ctx, ts time.Time, mspID string) *l2Ctx {
	s := shimtest.NewMockStub("l2-test", nil)
	s.State = src.stub.State
	s.MockTransactionStart(nextTxID())
	s.TxTimestamp = timestamppb.New(ts)
	return &l2Ctx{stub: s, mspID: mspID}
}

func drainL2Events(s *shimtest.MockStub) map[string][]byte {
	events := make(map[string][]byte)
	for {
		select {
		case ev := <-s.ChaincodeEventsChannel:
			events[ev.EventName] = ev.Payload
		default:
			return events
		}
	}
}

func TestCrossOrgTD_FS_Valid(t *testing.T) {
	tc := &TemporalContract{}

	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	if err := tc.CrossOrgTD_Store(ctx1, "proc1", "endA", "ManufacturerMSP"); err != nil {
		t.Fatalf("CrossOrgTD_Store: %v", err)
	}

	ctx2 := advL2Ctx(ctx1, time.Unix(1120, 0), "LogisticsMSP")
	if err := tc.CrossOrgTD_Check(ctx2, "proc1", "endA", "LogisticsMSP", 60, 300, "FS"); err != nil {
		t.Fatalf("CrossOrgTD_Check: %v", err)
	}

	evs := drainL2Events(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected cross-org FS violation")
	}
}

func TestCrossOrgTD_FS_TooShort(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.CrossOrgTD_Store(ctx1, "proc2", "endA", "ManufacturerMSP")

	ctx2 := advL2Ctx(ctx1, time.Unix(1010, 0), "LogisticsMSP")
	_ = tc.CrossOrgTD_Check(ctx2, "proc2", "endA", "LogisticsMSP", 60, 300, "FS")

	evs := drainL2Events(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected DesignerNotified for short cross-org FS gap")
	}
}

func TestCrossOrgTD_AccessDenied_Store(t *testing.T) {
	tc := &TemporalContract{}

	ctx := newL2Ctx(time.Unix(1000, 0), "LogisticsMSP")
	err := tc.CrossOrgTD_Store(ctx, "proc3", "endA", "ManufacturerMSP")
	if err == nil {
		t.Error("expected access denied error")
	}
}

func TestCrossOrgTD_AccessDenied_Check(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.CrossOrgTD_Store(ctx1, "proc4", "endA", "ManufacturerMSP")

	ctx2 := advL2Ctx(ctx1, time.Unix(1120, 0), "ManufacturerMSP")
	err := tc.CrossOrgTD_Check(ctx2, "proc4", "endA", "LogisticsMSP", 60, 300, "FS")
	if err == nil {
		t.Error("expected access denied error")
	}
}

func TestSyncGate_AllComplete_InTime(t *testing.T) {
	tc := &TemporalContract{}
	ctx0 := newL2Ctx(time.Unix(1000, 0), "AdminMSP")

	orgs := `["ManufacturerMSP","LogisticsMSP","RegulatoryMSP"]`
	if err := tc.InitSyncGate(ctx0, "sync1", orgs, 300); err != nil {
		t.Fatalf("InitSyncGate: %v", err)
	}

	ctx1 := advL2Ctx(ctx0, time.Unix(1000, 0), "ManufacturerMSP")
	if err := tc.MarkComplete_Sync(ctx1, "sync1"); err != nil {
		t.Fatalf("MarkComplete Org1: %v", err)
	}

	ctx2 := advL2Ctx(ctx1, time.Unix(1100, 0), "LogisticsMSP")
	if err := tc.MarkComplete_Sync(ctx2, "sync1"); err != nil {
		t.Fatalf("MarkComplete Org2: %v", err)
	}

	ctx3 := advL2Ctx(ctx2, time.Unix(1200, 0), "RegulatoryMSP")
	if err := tc.MarkComplete_Sync(ctx3, "sync1"); err != nil {
		t.Fatalf("MarkComplete Org3: %v", err)
	}

	evs := drainL2Events(ctx3.stub)
	if _, fired := evs["SyncFired"]; !fired {
		t.Error("expected SyncFired event")
	}
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected DesignerNotified on valid sync")
	}

	raw, _ := tc.GetSyncGate(ctx3, "sync1")
	var gate SyncGateState
	json.Unmarshal([]byte(raw), &gate)
	if !gate.Fired {
		t.Error("sync gate should be Fired")
	}
}

func TestSyncGate_LateOrg_Aborts(t *testing.T) {
	tc := &TemporalContract{}
	ctx0 := newL2Ctx(time.Unix(1000, 0), "AdminMSP")
	_ = tc.InitSyncGate(ctx0, "sync2", `["ManufacturerMSP","LogisticsMSP"]`, 60)

	ctx1 := advL2Ctx(ctx0, time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.MarkComplete_Sync(ctx1, "sync2")

	ctx2 := advL2Ctx(ctx1, time.Unix(1070, 0), "LogisticsMSP")
	_ = tc.MarkComplete_Sync(ctx2, "sync2")

	evs := drainL2Events(ctx2.stub)
	if _, aborted := evs["SyncAborted"]; !aborted {
		t.Error("expected SyncAborted for late org")
	}
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected DesignerNotified for late org")
	}
}

func TestSyncGate_CheckExpiry(t *testing.T) {
	tc := &TemporalContract{}
	ctx0 := newL2Ctx(time.Unix(1000, 0), "AdminMSP")
	_ = tc.InitSyncGate(ctx0, "sync3", `["ManufacturerMSP","LogisticsMSP"]`, 60)

	ctx1 := advL2Ctx(ctx0, time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.MarkComplete_Sync(ctx1, "sync3")

	ctx2 := advL2Ctx(ctx1, time.Unix(1070, 0), "AnyMSP")
	if err := tc.CheckExpiry_Sync(ctx2, "sync3"); err != nil {
		t.Fatalf("CheckExpiry_Sync: %v", err)
	}

	evs := drainL2Events(ctx2.stub)
	if _, aborted := evs["SyncAborted"]; !aborted {
		t.Error("expected SyncAborted via checkExpiry")
	}
}

func TestSyncGate_CheckExpiry_NoOp_BeforeFirstCompletion(t *testing.T) {
	tc := &TemporalContract{}
	ctx0 := newL2Ctx(time.Unix(1000, 0), "AdminMSP")
	_ = tc.InitSyncGate(ctx0, "sync4", `["ManufacturerMSP"]`, 60)

	ctx1 := advL2Ctx(ctx0, time.Unix(1500, 0), "AnyMSP")
	_ = tc.CheckExpiry_Sync(ctx1, "sync4")

	evs := drainL2Events(ctx1.stub)
	if _, aborted := evs["SyncAborted"]; aborted {
		t.Error("checkExpiry should be no-op before first completion")
	}
}

func TestSyncGate_NonParticipant_Rejected(t *testing.T) {
	tc := &TemporalContract{}
	ctx0 := newL2Ctx(time.Unix(1000, 0), "AdminMSP")
	_ = tc.InitSyncGate(ctx0, "sync5", `["ManufacturerMSP"]`, 300)

	ctx1 := advL2Ctx(ctx0, time.Unix(1010, 0), "UnknownMSP")
	if err := tc.MarkComplete_Sync(ctx1, "sync5"); err == nil {
		t.Error("expected error for non-participant org")
	}
}

func TestSyncGate_DoubleCompletion_Rejected(t *testing.T) {
	tc := &TemporalContract{}
	ctx0 := newL2Ctx(time.Unix(1000, 0), "AdminMSP")
	_ = tc.InitSyncGate(ctx0, "sync6", `["ManufacturerMSP","LogisticsMSP"]`, 300)

	ctx1 := advL2Ctx(ctx0, time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.MarkComplete_Sync(ctx1, "sync6")
	ctx2 := advL2Ctx(ctx1, time.Unix(1010, 0), "ManufacturerMSP")
	if err := tc.MarkComplete_Sync(ctx2, "sync6"); err == nil {
		t.Error("expected error for double completion")
	}
}

func TestGlobalDeadline_Valid(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	if err := tc.StartProcess_Global(ctx1, "gp1"); err != nil {
		t.Fatalf("StartProcess_Global: %v", err)
	}

	ctx2 := advL2Ctx(ctx1, time.Unix(2800, 0), "LogisticsMSP")
	if err := tc.EndProcess_Global(ctx2, "gp1", 3600); err != nil {
		t.Fatalf("EndProcess_Global: %v", err)
	}

	evs := drainL2Events(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected GlobalDeadline violation")
	}
	if _, ended := evs["ProcessEnded"]; !ended {
		t.Error("expected ProcessEnded event")
	}
}

func TestGlobalDeadline_Exceeded(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.StartProcess_Global(ctx1, "gp2")

	ctx2 := advL2Ctx(ctx1, time.Unix(5000, 0), "LogisticsMSP")
	_ = tc.EndProcess_Global(ctx2, "gp2", 3600)

	evs := drainL2Events(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected DesignerNotified for exceeded global deadline")
	}
}

func TestGlobalDeadline_DoubleStart(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.StartProcess_Global(ctx1, "gp3")
	ctx2 := advL2Ctx(ctx1, time.Unix(1001, 0), "LogisticsMSP")
	if err := tc.StartProcess_Global(ctx2, "gp3"); err == nil {
		t.Error("expected error on double start")
	}
}

func TestGlobalDeadline_EndWithoutStart(t *testing.T) {
	tc := &TemporalContract{}
	ctx := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	if err := tc.EndProcess_Global(ctx, "gp-none", 3600); err == nil {
		t.Error("expected error when ending unstarted process")
	}
}

func TestGlobalDeadline_DoubleEnd(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newL2Ctx(time.Unix(1000, 0), "ManufacturerMSP")
	_ = tc.StartProcess_Global(ctx1, "gp4")
	ctx2 := advL2Ctx(ctx1, time.Unix(2000, 0), "LogisticsMSP")
	_ = tc.EndProcess_Global(ctx2, "gp4", 3600)
	ctx3 := advL2Ctx(ctx2, time.Unix(3000, 0), "RegulatoryMSP")
	if err := tc.EndProcess_Global(ctx3, "gp4", 3600); err == nil {
		t.Error("expected error on double end")
	}
}
