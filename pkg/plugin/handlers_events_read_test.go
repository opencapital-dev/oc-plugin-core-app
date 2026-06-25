package plugin

import (
	"testing"

	"github.com/opencapital-dev/oc-plugin-sdk/pluginclient"
)

func strptr(s string) *string { return &s }

func TestMapEventRows(t *testing.T) {
	res := pluginclient.Result{
		Columns: []pluginclient.Column{
			{Name: "source_id"}, {Name: "event_type"}, {Name: "instrument_id"},
			{Name: "business_ts"}, {Name: "payload"},
		},
		Rows: [][]any{
			{"src-1", "TRADE", "AMRZ", int64(1752756415000000),
				`{"side":"buy","price":50.228,"quantity":35,"currency":"USD","venue":"XLON"}`},
			{"src-2", "CASHFLOW", nil, int64(1767921037000000),
				`{"type":"INTEREST_ON_CASH","amount_native":0.25,"currency":"GBP"}`},
		},
	}

	rows, err := mapEventRows(res)
	if err != nil {
		t.Fatalf("mapEventRows: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].SourceID != "src-1" || rows[0].EventType != "TRADE" {
		t.Fatalf("row0 header wrong: %+v", rows[0])
	}
	if rows[0].InstrumentID == nil || *rows[0].InstrumentID != "AMRZ" {
		t.Fatalf("row0 instrument wrong: %+v", rows[0].InstrumentID)
	}
	if rows[0].BusinessTs != 1752756415000000 {
		t.Fatalf("row0 ts wrong: %d", rows[0].BusinessTs)
	}
	if rows[0].Payload["side"] != "buy" {
		t.Fatalf("row0 payload not decoded: %+v", rows[0].Payload)
	}
	if rows[1].InstrumentID != nil {
		t.Fatalf("row1 instrument should be nil, got %+v", rows[1].InstrumentID)
	}
}
