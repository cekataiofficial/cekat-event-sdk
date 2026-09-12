// Package visitor resolves visitor IDs from inbound HTTP request values.
package visitor

import "strings"

// Resolve returns the first nonblank, trimmed visitor ID from header then cookie.
func Resolve(header, cookie string) (string, bool) {
	if id := strings.TrimSpace(header); id != "" {
		return id, true
	}
	if id := strings.TrimSpace(cookie); id != "" {
		return id, true
	}
	return "", false
}
