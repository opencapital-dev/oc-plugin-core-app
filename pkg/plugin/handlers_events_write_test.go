package plugin

import (
	"context"
	"errors"
	"testing"
)

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
	err := a.writeEvent(nil, []byte(`{"event_type":"NONSENSE"}`))
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
