package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-chaincode-go/shimtest"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type testCtx struct {
	stub *shimtest.MockStub
}

func (c *testCtx) GetStub() shim.ChaincodeStubInterface {
	return c.stub
}

func (c *testCtx) GetClientIdentity() cid.ClientIdentity {
	return nil
}

var txCounter int

func nextTxID() string {
	txCounter++
	return fmt.Sprintf("tx%d", txCounter)
}

func newTestCtx(ts time.Time) *testCtx {
	s := shimtest.NewMockStub("temporal-test", nil)
	s.MockTransactionStart(nextTxID())
	s.TxTimestamp = timestamppb.New(ts)
	return &testCtx{stub: s}
}

func advanceCtx(base *testCtx, ts time.Time) *testCtx {
	s := shimtest.NewMockStub("temporal-test", nil)
	s.State = base.stub.State
	s.MockTransactionStart(nextTxID())
	s.TxTimestamp = timestamppb.New(ts)
	return &testCtx{stub: s}
}

func drainEvents(s *shimtest.MockStub) map[string][]byte {
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

func TestDuration_Valid(t *testing.T) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(1180, 0)

	ctx1 := newTestCtx(t0)
	if err := tc.StartTask_Duration(ctx1, "p1"); err != nil {
		t.Fatalf("StartTask_Duration: %v", err)
	}

	ctx2 := advanceCtx(ctx1, t1)
	if err := tc.EndTask_Duration(ctx2, "p1", 60, 300); err != nil {
		t.Fatalf("EndTask_Duration: %v", err)
	}

	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("expected no violation, but DesignerNotified was emitted")
	}
}

func TestDuration_TooShort(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTask_Duration(ctx1, "p2")

	ctx2 := advanceCtx(ctx1, time.Unix(1010, 0))
	_ = tc.EndTask_Duration(ctx2, "p2", 60, 300)

	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected DesignerNotified for short duration")
	}
}

func TestDuration_TooLong(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTask_Duration(ctx1, "p3")

	ctx2 := advanceCtx(ctx1, time.Unix(2000, 0))
	_ = tc.EndTask_Duration(ctx2, "p3", 60, 300)

	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected DesignerNotified for long duration")
	}
}

func TestDuration_DoubleStart(t *testing.T) {
	tc := &TemporalContract{}
	ctx := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTask_Duration(ctx, "p4")
	if err := tc.StartTask_Duration(ctx, "p4"); err == nil {
		t.Error("expected error on double-start")
	}
}

func TestDuration_EndWithoutStart(t *testing.T) {
	tc := &TemporalContract{}
	ctx := newTestCtx(time.Unix(1000, 0))
	if err := tc.EndTask_Duration(ctx, "unknown", 60, 300); err == nil {
		t.Error("expected error on end without start")
	}
}

func TestCardinality_Valid(t *testing.T) {
	tc := &TemporalContract{}
	ctx := newTestCtx(time.Unix(1000, 0))
	if err := tc.InitTask_Cardinality(ctx, "task1", 3, 3600); err != nil {
		t.Fatalf("InitTask_Cardinality: %v", err)
	}
	if err := tc.ExecuteTask_Cardinality(ctx, "task1"); err != nil {
		t.Fatalf("ExecuteTask: %v", err)
	}
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected violation on first execution")
	}
}

func TestCardinality_ExceedsNmax(t *testing.T) {
	tc := &TemporalContract{}
	ctx := newTestCtx(time.Unix(1000, 0))
	_ = tc.InitTask_Cardinality(ctx, "task2", 2, 3600)
	_ = tc.ExecuteTask_Cardinality(ctx, "task2")
	_ = tc.ExecuteTask_Cardinality(ctx, "task2")
	_ = tc.ExecuteTask_Cardinality(ctx, "task2")
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected DesignerNotified when count exceeds Nmax")
	}
}

func TestCardinality_WindowReset(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.InitTask_Cardinality(ctx1, "task3", 2, 60)
	_ = tc.ExecuteTask_Cardinality(ctx1, "task3")
	_ = tc.ExecuteTask_Cardinality(ctx1, "task3")

	ctx2 := advanceCtx(ctx1, time.Unix(1100, 0))
	if err := tc.ExecuteTask_Cardinality(ctx2, "task3"); err != nil {
		t.Fatalf("ExecuteTask after reset: %v", err)
	}
	evs := drainEvents(ctx2.stub)
	if _, reset := evs["WindowReset"]; !reset {
		t.Error("expected WindowReset event after window expired")
	}
}

func TestCardinality_NotInitialised(t *testing.T) {
	tc := &TemporalContract{}
	ctx := newTestCtx(time.Unix(1000, 0))
	if err := tc.ExecuteTask_Cardinality(ctx, "noTask"); err == nil {
		t.Error("expected error for uninitialised task")
	}
}

func TestFS_Valid(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.FinishTaskA_FS(ctx1, "proc1")

	ctx2 := advanceCtx(ctx1, time.Unix(1120, 0))
	_ = tc.StartTaskB_FS(ctx2, "proc1", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected FS violation")
	}
}

func TestFS_TooShort(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.FinishTaskA_FS(ctx1, "proc2")

	ctx2 := advanceCtx(ctx1, time.Unix(1010, 0))
	_ = tc.StartTaskB_FS(ctx2, "proc2", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected FS violation for short gap")
	}
}

func TestFS_TooLong(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.FinishTaskA_FS(ctx1, "proc2b")

	ctx2 := advanceCtx(ctx1, time.Unix(1400, 0))
	_ = tc.StartTaskB_FS(ctx2, "proc2b", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected FS violation for long gap")
	}
}

func TestSS_Valid(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTaskA_SS(ctx1, "proc3")

	ctx2 := advanceCtx(ctx1, time.Unix(1120, 0))
	_ = tc.StartTaskB_SS(ctx2, "proc3", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected SS violation")
	}
}

func TestSS_TooShort(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTaskA_SS(ctx1, "proc3b")

	ctx2 := advanceCtx(ctx1, time.Unix(1010, 0))
	_ = tc.StartTaskB_SS(ctx2, "proc3b", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected SS violation for short gap")
	}
}

func TestFF_Valid(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.FinishTaskA_FF(ctx1, "proc4")

	ctx2 := advanceCtx(ctx1, time.Unix(1120, 0))
	_ = tc.FinishTaskB_FF(ctx2, "proc4", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected FF violation")
	}
}

func TestFF_TooLong(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.FinishTaskA_FF(ctx1, "proc5")

	ctx2 := advanceCtx(ctx1, time.Unix(1400, 0))
	_ = tc.FinishTaskB_FF(ctx2, "proc5", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected FF violation for long gap")
	}
}

func TestSF_Valid(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTaskA_SF(ctx1, "proc6")

	ctx2 := advanceCtx(ctx1, time.Unix(1120, 0))
	_ = tc.FinishTaskB_SF(ctx2, "proc6", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected SF violation")
	}
}

func TestSF_TooShort(t *testing.T) {
	tc := &TemporalContract{}
	ctx1 := newTestCtx(time.Unix(1000, 0))
	_ = tc.StartTaskA_SF(ctx1, "proc6b")

	ctx2 := advanceCtx(ctx1, time.Unix(1010, 0))
	_ = tc.FinishTaskB_SF(ctx2, "proc6b", 60, 300)
	evs := drainEvents(ctx2.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected SF violation for short gap")
	}
}

func TestMSO_WithinTolerance(t *testing.T) {
	tc := &TemporalContract{}
	now := int64(1000)
	ctx := newTestCtx(time.Unix(now, 0))

	if err := tc.StartTask_MSO(ctx, "p10", now+10); err != nil {
		t.Fatalf("StartTask_MSO: %v", err)
	}
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected MSO violation within tolerance")
	}
}

func TestMSO_OutsideTolerance(t *testing.T) {
	tc := &TemporalContract{}
	now := int64(1000)
	ctx := newTestCtx(time.Unix(now, 0))

	_ = tc.StartTask_MSO(ctx, "p11", now+200)
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected MSO violation outside tolerance")
	}
}

func TestSNLT_BeforeDeadline(t *testing.T) {
	tc := &TemporalContract{}
	now := int64(1000)
	ctx := newTestCtx(time.Unix(now, 0))

	_ = tc.StartTask_SNLT(ctx, "p12", now+300)
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected SNLT violation")
	}
}

func TestSNLT_AfterDeadline(t *testing.T) {
	tc := &TemporalContract{}
	now := int64(1000)
	ctx := newTestCtx(time.Unix(now, 0))

	_ = tc.StartTask_SNLT(ctx, "p13", now-1)
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected SNLT violation after deadline")
	}
}

func TestFNLT_BeforeDeadline(t *testing.T) {
	tc := &TemporalContract{}
	now := int64(1000)
	ctx := newTestCtx(time.Unix(now, 0))

	_ = tc.FinishTask_FNLT(ctx, "p14", now+300)
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; v {
		t.Error("unexpected FNLT violation")
	}
}

func TestFNLT_AfterDeadline(t *testing.T) {
	tc := &TemporalContract{}
	now := int64(1000)
	ctx := newTestCtx(time.Unix(now, 0))

	_ = tc.FinishTask_FNLT(ctx, "p15", now-1)
	evs := drainEvents(ctx.stub)
	if _, v := evs["DesignerNotified"]; !v {
		t.Error("expected FNLT violation after deadline")
	}
}
