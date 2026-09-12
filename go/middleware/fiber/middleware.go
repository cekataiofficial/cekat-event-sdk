// Package fiber provides Cekat visitor context middleware for Fiber routers.
package fiber

import (
	"context"
	"strings"

	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
	"github.com/cekataiofficial/cekat-event-sdk-go/internal/visitor"
	fiberlib "github.com/gofiber/fiber/v3"
)

type fiberContextKey struct{}

var contextKey = &fiberContextKey{}

// Middleware makes a derived standard context containing the request visitor ID
// available to downstream Fiber handlers. It restores any prior local state on
// every return path, including a downstream panic.
func Middleware() fiberlib.Handler {
	return func(c fiberlib.Ctx) error {
		prior := c.Locals(contextKey)
		visitorID, ok := visitor.Resolve(c.Get("X-Cekat-Visitor-ID"), c.Cookies("_cekat_visitor_id"))
		if ok {
			// Fiber's request values may be backed by pooled buffers. Clone before
			// retaining the visitor ID in a context that can outlive this request.
			c.Locals(contextKey, cekat.WithVisitorID(context.Background(), strings.Clone(visitorID)))
		} else {
			c.Locals(contextKey, context.Background())
		}
		defer func() {
			if prior == nil {
				c.RequestCtx().RemoveUserValue(contextKey)
				return
			}
			c.Locals(contextKey, prior)
		}()
		return c.Next()
	}
}

// Context returns the standard context installed by Middleware, or a background
// context when the middleware has not run for c.
func Context(c fiberlib.Ctx) context.Context {
	if ctx, ok := c.Locals(contextKey).(context.Context); ok {
		return ctx
	}
	return context.Background()
}
