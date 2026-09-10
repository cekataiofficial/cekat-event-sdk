// Package nethttp provides Cekat visitor context middleware for net/http handlers.
package nethttp

import (
	"net/http"

	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
)

// Middleware adds a request-local visitor ID, when supplied by the request, to
// the request passed to next. It does not mutate the original request.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, cekat.WithVisitorFromRequest(r))
	})
}
