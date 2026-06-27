package plugin

import (
	"context"
	"testing"

	"github.com/opencapital-dev/oc-plugin-sdk/datakey"
)

// fakeExecer captures every Exec call for assertion in tests.
type fakeExecer struct {
	sql  string
	args []any
}

func (f *fakeExecer) Exec(_ context.Context, sql string, args ...any) (int64, error) {
	f.sql = sql
	f.args = append([]any(nil), args...)
	return 1, nil
}

// ---- insertEvent -----------------------------------------------------------

func TestInsertEvent_SQL(t *testing.T) {
	db := &fakeExecer{}
	ctx := context.Background()
	pluginID := "test-plugin"
	traceID := "trace-1"
	instr := "AAPL"

	err := insertEvent(ctx, db, pluginID, traceID, "TRADE", "src-1", "port-A", &instr, 1_700_000_000_000_000, `{"foo":1}`)
	if err != nil {
		t.Fatalf("insertEvent: %v", err)
	}

	// Verify SQL contains the expected column list and placeholder count.
	wantSubstr := "INSERT INTO portfolio_events_log"
	if !containsStr(db.sql, wantSubstr) {
		t.Errorf("SQL missing %q; got: %s", wantSubstr, db.sql)
	}
	wantCols := []string{
		"source_id", "event_type", "portfolio_id", "instrument_id",
		"business_ts", "ingest_ts", "source", "plugin_id", "trace_id",
		"payload", "rw_key",
	}
	for _, c := range wantCols {
		if !containsStr(db.sql, c) {
			t.Errorf("SQL missing column %q", c)
		}
	}

	// $1=source_id $2=event_type $3=portfolio_id $4=instrument_id
	// $5=businessTs $6=source $7=plugin_id $8=trace_id $9=payload $10=rw_key
	if len(db.args) != 10 {
		t.Fatalf("want 10 args, got %d", len(db.args))
	}
	if db.args[0] != "src-1" {
		t.Errorf("$1 want src-1, got %v", db.args[0])
	}
	if db.args[1] != "TRADE" {
		t.Errorf("$2 want TRADE, got %v", db.args[1])
	}
	if db.args[2] != "port-A" {
		t.Errorf("$3 want port-A, got %v", db.args[2])
	}
	if db.args[3] != "AAPL" {
		t.Errorf("$4 want AAPL, got %v", db.args[3])
	}
	if db.args[4] != int64(1_700_000_000_000_000) {
		t.Errorf("$5 want business_ts micros, got %v", db.args[4])
	}
	if db.args[5] != "core-app" {
		t.Errorf("$6 want core-app, got %v", db.args[5])
	}
	if db.args[6] != pluginID {
		t.Errorf("$7 want %s, got %v", pluginID, db.args[6])
	}
	if db.args[7] != traceID {
		t.Errorf("$8 want %s, got %v", traceID, db.args[7])
	}
	if db.args[8] != `{"foo":1}` {
		t.Errorf("$9 want payload json, got %v", db.args[8])
	}

	// rw_key = EventKey(pluginID, sourceID)
	wantKey := datakey.EventKey(pluginID, "src-1")
	if db.args[9] != wantKey {
		t.Errorf("$10 (rw_key) want %s, got %v", wantKey, db.args[9])
	}
}

// TestInsertEvent_NilInstrumentID guards Critical 1: a nil instrumentID must
// bind as SQL NULL (interface{}(nil)), never as an empty string. An empty
// string would create phantom rows in the RW IS NULL / NOT LIKE 'CASH:%' folds.
func TestInsertEvent_NilInstrumentID(t *testing.T) {
	db := &fakeExecer{}
	ctx := context.Background()

	err := insertEvent(ctx, db, "plugin", "trace", "CASHFLOW", "src-2", "port-B", nil, 0, `{}`)
	if err != nil {
		t.Fatalf("insertEvent nil instr: %v", err)
	}
	if len(db.args) < 4 {
		t.Fatalf("too few args: %d", len(db.args))
	}
	// $4 must be nil (SQL NULL), not "".
	if db.args[3] != nil {
		t.Errorf("$4 (instrument_id) want nil (SQL NULL), got %v (%T)", db.args[3], db.args[3])
	}
}

// TestInsertEvent_EventTypePropagation ensures the event_type reaches $2.
func TestInsertEvent_EventTypePropagation(t *testing.T) {
	for _, et := range []string{"TRADE", "DIVIDEND", "CASHFLOW", "TRANSFER_IN", "FX_CONVERSION"} {
		db := &fakeExecer{}
		if err := insertEvent(context.Background(), db, "p", "t", et, "s", "port", nil, 0, `{}`); err != nil {
			t.Fatalf("insertEvent %s: %v", et, err)
		}
		if db.args[1] != et {
			t.Errorf("event_type $2: want %s got %v", et, db.args[1])
		}
	}
}

// ---- insertData ------------------------------------------------------------

func TestInsertData_SQL(t *testing.T) {
	db := &fakeExecer{}
	ctx := context.Background()
	pluginID := "test-plugin"
	traceID := "trace-2"

	err := insertData(ctx, db, pluginID, traceID, "prices.option_mark", "AAPL", "", 1_700_000_000_000_000, `{"close":1.5}`)
	if err != nil {
		t.Fatalf("insertData: %v", err)
	}

	wantSubstr := "INSERT INTO data_log"
	if !containsStr(db.sql, wantSubstr) {
		t.Errorf("SQL missing %q; got: %s", wantSubstr, db.sql)
	}
	wantCols := []string{
		"source_namespace", "source_id", "portfolio_id", "observed_at",
		"ingest_ts", "source", "plugin_id", "trace_id", "payload", "rw_key",
	}
	for _, c := range wantCols {
		if !containsStr(db.sql, c) {
			t.Errorf("SQL missing column %q", c)
		}
	}

	// $1=namespace $2=source_id $3=portfolio_id $4=observedAt
	// $5=source $6=plugin_id $7=trace_id $8=payload $9=rw_key
	if len(db.args) != 9 {
		t.Fatalf("want 9 args, got %d", len(db.args))
	}
	if db.args[0] != "prices.option_mark" {
		t.Errorf("$1 want namespace, got %v", db.args[0])
	}
	if db.args[1] != "AAPL" {
		t.Errorf("$2 want source_id, got %v", db.args[1])
	}
	if db.args[2] != "" {
		t.Errorf("$3 want empty portfolio_id, got %v", db.args[2])
	}
	if db.args[4] != "core-app" {
		t.Errorf("$5 want core-app, got %v", db.args[4])
	}
	if db.args[5] != pluginID {
		t.Errorf("$6 want %s, got %v", pluginID, db.args[5])
	}
	if db.args[6] != traceID {
		t.Errorf("$7 want %s, got %v", traceID, db.args[6])
	}
	if db.args[7] != `{"close":1.5}` {
		t.Errorf("$8 want payload, got %v", db.args[7])
	}

	wantKey := datakey.DataKey(pluginID, "prices.option_mark", "", "AAPL", 1_700_000_000_000_000)
	if db.args[8] != wantKey {
		t.Errorf("$9 (rw_key) want %s, got %v", wantKey, db.args[8])
	}
}

// ---- deleteEvent -----------------------------------------------------------

func TestDeleteEvent_SQL(t *testing.T) {
	db := &fakeExecer{}
	ctx := context.Background()
	pluginID := "test-plugin"

	err := deleteEvent(ctx, db, pluginID, "src-del")
	if err != nil {
		t.Fatalf("deleteEvent: %v", err)
	}

	wantSubstr := "DELETE FROM portfolio_events_log WHERE rw_key"
	if !containsStr(db.sql, wantSubstr) {
		t.Errorf("SQL missing %q; got: %s", wantSubstr, db.sql)
	}
	if len(db.args) != 1 {
		t.Fatalf("want 1 arg, got %d", len(db.args))
	}
	wantKey := datakey.EventKey(pluginID, "src-del")
	if db.args[0] != wantKey {
		t.Errorf("$1 (rw_key) want %s, got %v", wantKey, db.args[0])
	}
}

// ---- pure helpers ----------------------------------------------------------

func TestMarshalPayload(t *testing.T) {
	s, err := marshalPayload(map[string]any{"foo": "bar", "n": 42})
	if err != nil {
		t.Fatalf("marshalPayload: %v", err)
	}
	if s == "" {
		t.Fatal("expected non-empty JSON string")
	}
}

func TestPtrStr(t *testing.T) {
	if ptrStr("") != nil {
		t.Fatal("ptrStr(\"\") should be nil")
	}
	p := ptrStr("hello")
	if p == nil || *p != "hello" {
		t.Fatal("ptrStr(\"hello\") should return pointer to \"hello\"")
	}
}

func TestDerefStr(t *testing.T) {
	if derefStr(nil, "default") != "default" {
		t.Fatal("derefStr(nil) should return fallback")
	}
	s := "value"
	if derefStr(&s, "default") != "value" {
		t.Fatal("derefStr(&s) should return s")
	}
}

func TestNowMicros(t *testing.T) {
	ts := nowMicros()
	if ts <= 0 {
		t.Fatal("nowMicros should return positive timestamp")
	}
}

func TestGenID(t *testing.T) {
	id := genID()
	if len(id) == 0 {
		t.Fatal("genID should return non-empty string")
	}
	id2 := genID()
	if id == id2 {
		t.Fatal("genID should return unique IDs")
	}
}

// ---- utility ---------------------------------------------------------------

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && findStr(s, substr)
}

func findStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// ---- clampAcqMicros (TRANSFER_IN date guard) -------------------------------

func TestClampAcqMicros(t *testing.T) {
	const minValid = int64(631152000) * 1_000_000 // 1990-01-01
	// Go zero-time (the real corruption seen in prod): must be clamped to now-ish.
	if got := clampAcqMicros(-62102789413000000); got < minValid {
		t.Errorf("corrupt zero-time not clamped: %d", got)
	}
	// Exact zero: clamped.
	if got := clampAcqMicros(0); got < minValid {
		t.Errorf("zero not clamped: %d", got)
	}
	// Valid date (2026-01-15): passed through unchanged.
	valid := int64(1768492503) * 1_000_000
	if got := clampAcqMicros(valid); got != valid {
		t.Errorf("valid date changed: got %d want %d", got, valid)
	}
}
