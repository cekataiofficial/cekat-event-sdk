// Package gin provides Cekat visitor context middleware for Gin routers.
package gin

import (
	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
	"github.com/gin-gonic/gin"
)

// Middleware adds a request-local visitor ID, when supplied by the request, to
// the request passed to subsequent Gin handlers. It does not mutate headers or
// cookies and preserves Gin's handler-chain semantics.
//
// Handlers must pass c.Request.Context(), not c, to client methods: *gin.Context
// only reads request-context values when engine.ContextWithFallback is enabled.
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request = cekat.WithVisitorFromRequest(c.Request)
		c.Next()
	}
}
