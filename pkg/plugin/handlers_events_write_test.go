package plugin

import (
	"context"
	"errors"
	"testing"
)

// TestTradeCreateFromRawInjectsSourceID verifies the pure helper that backs
// the TRADE upsert path.
func TestTradeCreateFromRawInjectsSourceID(t *testing.T) {
	t.Run("source_id injected as TradeID", func(t *testing.T) {
		raw := []byte(`{"event_type":"TRADE","source_id":"abc","price":1}`)
		b, err := tradeCreateFromRaw(raw, "abc")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if b.TradeID == nil {
			t.Fatal("want TradeID non-nil, got nil")
		}
		if *b.TradeID != "abc" {
			t.Fatalf("want TradeID=abc, got %q", *b.TradeID)
		}
	})

	t.Run("explicit trade_id preserved when sourceID empty", func(t *testing.T) {
		raw := []byte(`{"event_type":"TRADE","trade_id":"xyz","price":1}`)
		b, err := tradeCreateFromRaw(raw, "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if b.TradeID == nil {
			t.Fatal("want TradeID non-nil, got nil")
		}
		if *b.TradeID != "xyz" {
			t.Fatalf("want TradeID=xyz, got %q", *b.TradeID)
		}
	})
}

func TestEventTypeFromRaw(t *testing.T) {
	got, err := eventTypeFromRaw([]byte(`{"event_type":"trade","price":1}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "TRADE" {
		t.Fatalf("want TRADE, got %q", got)
	}
}

func TestEventTypeFromRawMissing(t *testing.T) {
	if _, err := eventTypeFromRaw([]byte(`{"price":1}`)); err == nil {
		t.Fatal("want error for missing event_type")
	}
}

func TestWriteEventUnknownType(t *testing.T) {
	a := &App{}
	err := a.writeEvent(context.TODO(), []byte(`{"event_type":"NONSENSE"}`))
	if err == nil {
		t.Fatal("want error for unknown event_type")
	}
}

// TestWriteEventValidationError asserts that client-input problems (unknown
// event_type, missing event_type, malformed JSON) surface as validationError so
// the handler maps them to HTTP 400, not 502.
func TestWriteEventValidationError(t *testing.T) {
	a := &App{}

	cases := []struct {
		name string
		body []byte
	}{
		{"unknown type", []byte(`{"event_type":"NONSENSE"}`)},
		{"missing type", []byte(`{"price":1}`)},
		{"malformed json tag", []byte(`{bad json}`)},
		{"malformed typed body", []byte(`{"event_type":"TRADE","quantity":"not-a-number"}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := a.writeEvent(context.Background(), tc.body)
			if err == nil {
				t.Fatal("want error, got nil")
			}
			var ve validationError
			if !errors.As(err, &ve) {
				t.Fatalf("want validationError, got %T: %v", err, err)
			}
		})
	}
}
