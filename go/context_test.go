package cekat

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVisitorIDContext(t *testing.T) {
	contextWithVisitor := WithVisitorID(context.Background(), "  visitor-123  ")
	if got, ok := VisitorIDFromContext(contextWithVisitor); got != "visitor-123" || !ok {
		t.Errorf("VisitorIDFromContext() = (%q, %t), want (%q, true)", got, ok, "visitor-123")
	}
	if got := contextWithVisitor.Value("visitorID"); got != nil {
		t.Errorf("visitor ID was stored under a string context key: %v", got)
	}

	original := WithVisitorID(context.Background(), "existing-visitor")
	if got := WithVisitorID(original, " \t "); got != original {
		t.Error("WithVisitorID() returned a replacement context for blank input")
	}
	if got, ok := VisitorIDFromContext(original); got != "existing-visitor" || !ok {
		t.Errorf("blank WithVisitorID() changed visitor to (%q, %t), want (%q, true)", got, ok, "existing-visitor")
	}

	if got, ok := VisitorIDFromContext(context.Background()); got != "" || ok {
		t.Errorf("VisitorIDFromContext() = (%q, %t), want (empty string, false) for missing visitor", got, ok)
	}
}

func TestVisitorFromRequest(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Cekat-Visitor-ID", "  header-visitor  ")
	request.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "cookie-visitor"})

	enriched := WithVisitorFromRequest(request)
	if enriched == request {
		t.Error("WithVisitorFromRequest() did not replace request with visitor source")
	}
	if got, ok := VisitorIDFromContext(enriched.Context()); got != "header-visitor" || !ok {
		t.Errorf("VisitorIDFromContext(enriched.Context()) = (%q, %t), want (%q, true)", got, ok, "header-visitor")
	}
	if got, ok := VisitorIDFromContext(request.Context()); got != "" || ok {
		t.Errorf("VisitorIDFromContext(original.Context()) = (%q, %t), want (empty string, false)", got, ok)
	}

	fallbackRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	fallbackRequest.Header.Set("X-Cekat-Visitor-ID", " \t ")
	fallbackRequest.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "  cookie-visitor  "})
	if got, ok := VisitorIDFromContext(WithVisitorFromRequest(fallbackRequest).Context()); got != "cookie-visitor" || !ok {
		t.Errorf("blank header fallback visitor = (%q, %t), want (%q, true)", got, ok, "cookie-visitor")
	}

	noVisitorRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := WithVisitorFromRequest(noVisitorRequest); got != noVisitorRequest {
		t.Error("WithVisitorFromRequest() replaced request with no visitor source")
	}
}
