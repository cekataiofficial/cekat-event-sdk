// Package state provides synchronized state for the mock ingest server.
package state

import (
	"strings"
	"sync"
)

// ResponseSpec is a scripted HTTP response consumed by an ingest request.
type ResponseSpec struct {
	Status                  int               `json:"status"`
	Headers                 map[string]string `json:"headers,omitempty"`
	Body                    string            `json:"body"`
	DelayMS                 int               `json:"delay_ms,omitempty"`
	DisconnectBeforeHeaders bool              `json:"disconnect_before_headers,omitempty"`
	DisconnectAfterHeaders  bool              `json:"disconnect_after_headers,omitempty"`
}

// RequestRecord is an immutable journal entry returned from State snapshots.
type RequestRecord struct {
	Sequence uint64              `json:"sequence"`
	Method   string              `json:"method"`
	Path     string              `json:"path"`
	Headers  map[string][]string `json:"headers"`
	Body     string              `json:"body"`
}

// State owns the scripted response queue and ingest request journal.
type State struct {
	mu        sync.Mutex
	responses []ResponseSpec
	requests  []RequestRecord
	nextSeq   uint64
}

// New creates an empty State.
func New() *State {
	return &State{}
}

// Reset atomically clears both the response queue and request journal.
func (s *State) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.responses = nil
	s.requests = nil
	s.nextSeq = 0
}

// ReplaceResponses atomically replaces the remaining response queue.
func (s *State) ReplaceResponses(responses []ResponseSpec) {
	copies := copyResponses(responses)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.responses = copies
}

// Record captures a normalized request record and assigns its next sequence number.
func (s *State) Record(request RequestRecord) {
	request.Headers = copyNormalizedHeaders(request.Headers)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextSeq++
	request.Sequence = s.nextSeq
	s.requests = append(s.requests, request)
}

// NextResponse removes and returns the oldest scripted response, if one is queued.
func (s *State) NextResponse() (ResponseSpec, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.responses) == 0 {
		return ResponseSpec{}, false
	}

	response := copyResponse(s.responses[0])
	var zero ResponseSpec
	s.responses[0] = zero
	s.responses = s.responses[1:]
	return response, true
}

// Requests returns an immutable snapshot of the request journal.
func (s *State) Requests() []RequestRecord {
	s.mu.Lock()
	defer s.mu.Unlock()

	requests := make([]RequestRecord, len(s.requests))
	for i, request := range s.requests {
		requests[i] = copyRequest(request)
	}
	return requests
}

func copyResponses(responses []ResponseSpec) []ResponseSpec {
	if responses == nil {
		return nil
	}

	copies := make([]ResponseSpec, len(responses))
	for i, response := range responses {
		copies[i] = copyResponse(response)
	}
	return copies
}

func copyResponse(response ResponseSpec) ResponseSpec {
	response.Headers = copyResponseHeaders(response.Headers)
	return response
}

func copyResponseHeaders(headers map[string]string) map[string]string {
	if headers == nil {
		return nil
	}

	copy := make(map[string]string, len(headers))
	for key, value := range headers {
		copy[key] = value
	}
	return copy
}

func copyRequest(request RequestRecord) RequestRecord {
	request.Headers = copyNormalizedHeaders(request.Headers)
	return request
}

func copyNormalizedHeaders(headers map[string][]string) map[string][]string {
	if headers == nil {
		return nil
	}

	copy := make(map[string][]string, len(headers))
	for key, values := range headers {
		normalizedKey := strings.ToLower(key)
		copy[normalizedKey] = append(copy[normalizedKey], values...)
	}
	return copy
}
