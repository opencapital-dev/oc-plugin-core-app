package plugin

import (
	"encoding/json"
	"io"
	"net/http"
)

// decodeJSON parses the request body into v. Returns 400 on bad JSON.
func decodeJSON[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		respondErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return v, false
	}
	return v, true
}

// respondJSON writes the value as JSON with the given status code.
func respondJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}

// respondErr writes a JSON {"detail": msg} body matching FastAPI's
// HTTPException shape so the frontend's existing error-rendering keeps
// working unchanged.
func respondErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": msg})
}

// methodGuard rejects requests whose method isn't in allowed with 405.
func methodGuard(w http.ResponseWriter, r *http.Request, allowed ...string) bool {
	for _, m := range allowed {
		if r.Method == m {
			return true
		}
	}
	w.Header().Set("Allow", joinAllowed(allowed))
	respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

func joinAllowed(methods []string) string {
	out := ""
	for i, m := range methods {
		if i > 0 {
			out += ", "
		}
		out += m
	}
	return out
}

// readBody reads and returns the whole request body, capped at 4 MiB.
func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, 4<<20))
}
