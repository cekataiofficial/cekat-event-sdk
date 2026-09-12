package state

import (
	"fmt"
	"sync"
	"testing"
)

func TestNextResponseIsFIFOAndReplaceDoesNotAppend(t *testing.T) {
	s := New()
	s.Record(RequestRecord{Method: "POST", Path: "/retained-journal"})
	s.ReplaceResponses([]ResponseSpec{
		{Status: 201, Body: "first"},
		{Status: 202, Body: "second"},
	})
	s.ReplaceResponses([]ResponseSpec{{Status: 203, Body: "replacement"}})

	response, ok := s.NextResponse()
	if !ok {
		t.Fatal("NextResponse() reported an empty queue")
	}
	if response.Status != 203 || response.Body != "replacement" {
		t.Fatalf("NextResponse() = %#v, want replacement response", response)
	}
	if _, ok := s.NextResponse(); ok {
		t.Fatal("NextResponse() retained responses that ReplaceResponses should discard")
	}
	if requests := s.Requests(); len(requests) != 1 || requests[0].Path != "/retained-journal" {
		t.Fatalf("ReplaceResponses() changed the journal: %#v", requests)
	}

	s.ReplaceResponses([]ResponseSpec{
		{Status: 204, Body: "one"},
		{Status: 205, Body: "two"},
	})
	for _, want := range []string{"one", "two"} {
		response, ok := s.NextResponse()
		if !ok || response.Body != want {
			t.Fatalf("NextResponse() = (%#v, %t), want body %q", response, ok, want)
		}
	}
}

func TestResetClearsQueueJournalAndSequence(t *testing.T) {
	s := New()
	s.ReplaceResponses([]ResponseSpec{{Status: 200, Body: "queued"}})
	s.Record(RequestRecord{Method: "POST", Path: "/before"})

	s.Reset()

	if _, ok := s.NextResponse(); ok {
		t.Fatal("NextResponse() returned a response after Reset()")
	}
	if requests := s.Requests(); len(requests) != 0 {
		t.Fatalf("Requests() = %#v after Reset(), want empty", requests)
	}

	s.Record(RequestRecord{Method: "POST", Path: "/after"})
	requests := s.Requests()
	if len(requests) != 1 || requests[0].Sequence != 1 {
		t.Fatalf("Requests() = %#v, want one entry with sequence 1 after Reset()", requests)
	}
}

func TestStateCapturesAndReturnsDefensiveCopies(t *testing.T) {
	s := New()
	responseHeaders := map[string]string{"X-Response": "original"}
	responses := []ResponseSpec{{Status: 200, Headers: responseHeaders, Body: "original"}}
	s.ReplaceResponses(responses)
	responseHeaders["X-Response"] = "mutated"
	responses[0].Body = "mutated"

	response, ok := s.NextResponse()
	if !ok {
		t.Fatal("NextResponse() reported an empty queue")
	}
	if response.Headers["X-Response"] != "original" || response.Body != "original" {
		t.Fatalf("NextResponse() = %#v, want original stored copy", response)
	}
	response.Headers["X-Response"] = "returned mutation"

	s.ReplaceResponses([]ResponseSpec{{Status: 201, Headers: map[string]string{"X-Response": "second"}}})
	response, ok = s.NextResponse()
	if !ok || response.Headers["X-Response"] != "second" {
		t.Fatalf("NextResponse() = (%#v, %t), want independent response copy", response, ok)
	}

	requestHeaders := map[string][]string{"X-Request": {"one", "two"}}
	s.Record(RequestRecord{Method: "POST", Path: "/api/events/ingest", Headers: requestHeaders, Body: "original"})
	requestHeaders["X-Request"][0] = "mutated"
	requestHeaders["x-extra"] = []string{"mutated"}

	requests := s.Requests()
	if len(requests) != 1 {
		t.Fatalf("Requests() length = %d, want 1", len(requests))
	}
	if got := requests[0].Headers["x-request"]; len(got) != 2 || got[0] != "one" || got[1] != "two" {
		t.Fatalf("Requests()[0].Headers = %#v, want captured values", requests[0].Headers)
	}
	requests[0].Headers["x-request"][0] = "returned mutation"
	requests[0].Headers["x-returned"] = []string{"returned mutation"}

	again := s.Requests()
	if got := again[0].Headers["x-request"][0]; got != "one" {
		t.Fatalf("Requests() leaked returned slice mutation: got %q, want %q", got, "one")
	}
	if _, found := again[0].Headers["x-returned"]; found {
		t.Fatalf("Requests() leaked returned map mutation: %#v", again[0].Headers)
	}
}

func TestRecordRetainsValuesForDifferentlyCasedHeaderKeys(t *testing.T) {
	s := New()
	s.Record(RequestRecord{
		Headers: map[string][]string{
			"X-Trace": {"one"},
			"x-trace": {"two"},
		},
	})

	requests := s.Requests()
	if len(requests) != 1 {
		t.Fatalf("Requests() length = %d, want 1", len(requests))
	}
	if got := requests[0].Headers; len(got) != 1 {
		t.Fatalf("Requests()[0].Headers = %#v, want one normalized key", got)
	}
	values := requests[0].Headers["x-trace"]
	if len(values) != 2 || !contains(values, "one") || !contains(values, "two") {
		t.Fatalf("Requests()[0].Headers[x-trace] = %#v, want both values", values)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestRecordAssignsMonotonicSequencesDuringConcurrentAccess(t *testing.T) {
	const records = 100

	s := New()
	var group sync.WaitGroup
	group.Add(records)
	for i := 0; i < records; i++ {
		go func(i int) {
			defer group.Done()
			s.Record(RequestRecord{
				Method:  "POST",
				Path:    fmt.Sprintf("/requests/%d", i),
				Headers: map[string][]string{"x-request": {fmt.Sprintf("%d", i)}},
			})
		}(i)
	}
	group.Wait()

	requests := s.Requests()
	if len(requests) != records {
		t.Fatalf("Requests() length = %d, want %d", len(requests), records)
	}
	for i, request := range requests {
		want := uint64(i + 1)
		if request.Sequence != want {
			t.Fatalf("Requests()[%d].Sequence = %d, want %d", i, request.Sequence, want)
		}
	}
}
