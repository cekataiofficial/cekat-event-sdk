// Package fiber provides Cekat visitor context middleware for Fiber routers.
package fiber

import (
	"strings"

	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
	fiberlib "github.com/gofiber/fiber/v3"
)

// Middleware adds the request visitor ID, when supplied, to the standard context
// returned by c.Context(), so handlers pass c.Context() to client methods. The
// prior context is restored on every return path, including a downstream panic.
//
// Pass c.Context(), not c itself: fiber.Ctx does not expose values stored in its
// standard context.
func Middleware() fiberlib.Handler {
	return func(c fiberlib.Ctx) error {
		visitorID, ok := cekat.ResolveVisitorID(c.Get(cekat.VisitorHeader), c.Cookies(cekat.VisitorCookie))
		if !ok {
			return c.Next()
		}
		prior := c.Context()
		// Fiber's request values may be backed by pooled buffers. Clone before
		// retaining the visitor ID in a context that can outlive this request.
		c.SetContext(cekat.WithVisitorID(prior, strings.Clone(visitorID)))
		defer c.SetContext(prior)
		return c.Next()
	}
}
