package plugin

import "testing"

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
