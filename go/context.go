package cekat

import (
	"context"
	"net/http"
	"strings"
)

const (
	// VisitorHeader is the request header browser helpers use to propagate the
	// visitor ID to cross-origin APIs.
	VisitorHeader = "X-Cekat-Visitor-ID"
	// VisitorCookie is the cookie in which the Cekat browser tracker stores the
	// visitor ID.
	VisitorCookie = "_cekat_visitor_id"
)

type visitorContextKey struct{}

// ResolveVisitorID returns the trimmed visitor ID from the VisitorHeader value,
// falling back to the VisitorCookie value. Use it to build middleware for
// frameworks that do not expose *http.Request. Visitor IDs are untrusted
// correlation data and must never be used for authentication or authorization.
func ResolveVisitorID(header, cookie string) (string, bool) {
	if id := strings.TrimSpace(header); id != "" {
		return id, true
	}
	if id := strings.TrimSpace(cookie); id != "" {
		return id, true
	}
	return "", false
}

// WithVisitorID returns a context carrying a trimmed visitor ID. Blank visitor IDs
// leave ctx unchanged so existing request-local visitor state is not overwritten.
func WithVisitorID(ctx context.Context, visitorID string) context.Context {
	if visitorID = strings.TrimSpace(visitorID); visitorID == "" {
		return ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, visitorContextKey{}, visitorID)
}

// VisitorIDFromContext returns the request-local visitor ID, if one is present.
func VisitorIDFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	visitorID, ok := ctx.Value(visitorContextKey{}).(string)
	return visitorID, ok
}

// WithVisitorFromRequest returns a replacement request enriched with the visitor
// ID resolved from its header or cookie. It never mutates the input request.
func WithVisitorFromRequest(request *http.Request) *http.Request {
	if request == nil {
		return nil
	}
	cookie := ""
	if value, err := request.Cookie(VisitorCookie); err == nil {
		cookie = value.Value
	}
	visitorID, ok := ResolveVisitorID(request.Header.Get(VisitorHeader), cookie)
	if !ok {
		return request
	}
	return request.WithContext(WithVisitorID(request.Context(), visitorID))
}
