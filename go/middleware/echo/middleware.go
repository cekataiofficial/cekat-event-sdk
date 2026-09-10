// Package echo provides Cekat visitor context middleware for Echo routers.
package echo

import (
	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
	"github.com/labstack/echo/v4"
)

// Middleware adds a request-local visitor ID, when supplied by the request, to
// the request passed to subsequent Echo handlers. It does not mutate headers or
// cookies and preserves Echo's error and panic semantics.
func Middleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.SetRequest(cekat.WithVisitorFromRequest(c.Request()))
			return next(c)
		}
	}
}
