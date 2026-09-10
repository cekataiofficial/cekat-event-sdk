// Package chi provides Cekat visitor context middleware for Chi routers.
package chi

import (
	"net/http"

	nethttp "github.com/cekataiofficial/cekat-event-sdk-go/middleware/nethttp"
)

// Middleware adds a request-local visitor ID, when supplied by the request, to
// the request passed to next. It delegates extraction to the net/http adapter.
func Middleware(next http.Handler) http.Handler {
	return nethttp.Middleware(next)
}
