package plugin

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestDeletePortfolio_Wired guards the regression where DELETE /ref/portfolios/{id}
// returned 501 "not implemented". With no id the handler must reach its own
// validation (400) — never 501 — proving the route is wired to handleDeletePortfolio.
// The full delete (both stores + CDC) is covered by an integration test.
func TestDeletePortfolio_Wired(t *testing.T) {
	a := &App{}
	req := httptest.NewRequest(http.MethodDelete, "/ref/portfolios/", nil) // empty {id}
	w := httptest.NewRecorder()

	a.dispatchPortfolioByID(w, req)

	if w.Code == http.StatusNotImplemented {
		t.Fatal("DELETE portfolio still returns 501 — not wired")
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty id: want 400, got %d", w.Code)
	}
}

// TestPortfolioByID_MethodNotAllowed: non-DELETE still rejected.
func TestPortfolioByID_MethodNotAllowed(t *testing.T) {
	a := &App{}
	req := httptest.NewRequest(http.MethodPut, "/ref/portfolios/x", nil)
	w := httptest.NewRecorder()

	a.dispatchPortfolioByID(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT: want 405, got %d", w.Code)
	}
}
