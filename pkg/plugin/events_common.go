package plugin

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// nowMicros is the default business_ts when the request body omits it.
func nowMicros() int64 {
	return time.Now().UTC().UnixMicro()
}

// genID returns a UUIDv4 string.
func genID() string {
	return uuid.NewString()
}

// ptrStr lifts a non-empty string to *string, nil otherwise.
func ptrStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// derefStr returns *p or fallback when p is nil.
func derefStr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

// marshalPayload JSON-encodes a portfolio-event payload map into the string the
// gateway expects (its PortfolioEventBody.Payload field is a string).
func marshalPayload(m map[string]any) (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}
	return string(b), nil
}
