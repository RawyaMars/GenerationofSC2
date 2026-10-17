package main

import (
	"fmt"
	"testing"
	"time"
)

func BenchmarkDuration_EndTask(b *testing.B) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(1180, 0)
	for i := 0; i < b.N; i++ {
		pid := fmt.Sprintf("bench-dur-%d", i)
		b.StopTimer()
		ctx1 := newTestCtx(t0)
		_ = tc.StartTask_Duration(ctx1, pid)
		ctx2 := advanceCtx(ctx1, t1)
		b.StartTimer()
		_ = tc.EndTask_Duration(ctx2, pid, 60, 300)
	}
}

func BenchmarkCrossOrgTD_Check(b *testing.B) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(1180, 0)
	for i := 0; i < b.N; i++ {
		pid := fmt.Sprintf("bench-cotd-%d", i)
		b.StopTimer()
		ctx1 := newL2Ctx(t0, "Org1MSP")
		_ = tc.CrossOrgTD_Store(ctx1, pid, "endA", "Org1MSP")
		ctx2 := advL2Ctx(ctx1, t1, "Org2MSP")
		b.StartTimer()
		_ = tc.CrossOrgTD_Check(ctx2, pid, "endA", "Org2MSP", 60, 300, "FS")
	}
}

func BenchmarkMarkComplete_Sync(b *testing.B) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	for i := 0; i < b.N; i++ {
		pid := fmt.Sprintf("bench-sync-%d", i)
		b.StopTimer()
		ctx1 := newL2Ctx(t0, "Org1MSP")
		_ = tc.InitSyncGate(ctx1, pid, `["Org1MSP","Org2MSP"]`, 7200)
		ctx2 := advL2Ctx(ctx1, t0, "Org1MSP")
		b.StartTimer()
		_ = tc.MarkComplete_Sync(ctx2, pid)
	}
}

func BenchmarkCID_RegisterReceive(b *testing.B) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(1180, 0)
	for i := 0; i < b.N; i++ {
		pid := fmt.Sprintf("bench-cid-%d", i)
		b.StopTimer()
		ctx1 := newTestCtx(t0)
		_ = tc.CID_RegisterSend(ctx1, pid, "send-msg", t0.Unix())
		ctx2 := advanceCtx(ctx1, t1)
		b.StartTimer()
		_ = tc.CID_RegisterReceive(ctx2, pid, "recv-msg", t1.Unix(), 7200)
	}
}

func BenchmarkCBTD_RecordOrgBRef(b *testing.B) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(1180, 0)
	for i := 0; i < b.N; i++ {
		pid := fmt.Sprintf("bench-cbtd-%d", i)
		b.StopTimer()
		ctx1 := newTestCtx(t0)
		_ = tc.CBTD_RecordOrgARef(ctx1, pid, "FS", "msg-a", t0.Unix())
		ctx2 := advanceCtx(ctx1, t1)
		b.StartTimer()
		_ = tc.CBTD_RecordOrgBRef(ctx2, pid, "FS", "msg-b", t1.Unix(), 60, 300)
	}
}

func BenchmarkCCCW_StartCompensation(b *testing.B) {
	tc := &TemporalContract{}
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(1180, 0)
	for i := 0; i < b.N; i++ {
		pid := fmt.Sprintf("bench-cccw-%d", i)
		b.StopTimer()
		ctx1 := newTestCtx(t0)
		_ = tc.CCCW_RecordFailure(ctx1, pid, "fail-msg", t0.Unix(), 7200)
		ctx2 := advanceCtx(ctx1, t1)
		b.StartTimer()
		_ = tc.CCCW_StartCompensation(ctx2, pid, "comp-msg", t1.Unix())
	}
}
