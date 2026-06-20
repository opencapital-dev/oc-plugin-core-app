package plugin

import (
	"testing"
)

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
