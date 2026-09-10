package cekat

import (
	"context"
	"net/http"
	"strings"

	"github.com/cekataiofficial/cekat-event-sdk-go/internal/visitor"
)

type visitorContextKey struct{}

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
	if value, err := request.Cookie("_cekat_visitor_id"); err == nil {
		cookie = value.Value
	}
	visitorID, ok := visitor.Resolve(request.Header.Get("X-Cekat-Visitor-ID"), cookie)
	if !ok {
		return request
	}
	return request.WithContext(WithVisitorID(request.Context(), visitorID))
}
