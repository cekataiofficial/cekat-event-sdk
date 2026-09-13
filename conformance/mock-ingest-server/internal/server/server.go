// Package server provides the mock ingest server HTTP handler.
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/cekataiofficial/cekat-event-sdk/conformance/mock-ingest-server/internal/state"
)

const (
	resetPath     = "/__control/reset"
	responsesPath = "/__control/responses"
	requestsPath  = "/__control/requests"
	ingestPath    = "/api/events/ingest"

	defaultSuccessBody = `{"success":true,"data":{"success":true,"message":"accepted","event_key":"conformance_default","validated_properties":[]}}`
)

// New returns the HTTP handler for a state-backed mock ingest server.
func New(store *state.State) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case resetPath:
			if !requireMethod(w, r, http.MethodPost) {
				return
			}
			handleReset(w, r, store)
		case responsesPath:
			if !requireMethod(w, r, http.MethodPost) {
				return
			}
			handleResponses(w, r, store)
		case requestsPath:
			if !requireMethod(w, r, http.MethodGet) {
				return
			}
			handleRequests(w, store)
		case ingestPath:
			if !requireMethod(w, r, http.MethodPost) {
				return
			}
			handleIngest(w, r, store)
		default:
			http.NotFound(w, r)
		}
	})
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
	return false
}

func handleReset(w http.ResponseWriter, r *http.Request, store *state.State) {
	body, err := io.ReadAll(r.Body)
	if err != nil || len(body) != 0 {
		writeInvalidRequest(w)
		return
	}
	store.Reset()
	w.WriteHeader(http.StatusNoContent)
}

func handleResponses(w http.ResponseWriter, r *http.Request, store *state.State) {
	var request responseQueueRequest
	if err := decodeJSON(r.Body, &request); err != nil {
		writeInvalidRequest(w)
		return
	}

	if request.Responses == nil {
		writeInvalidRequest(w)
		return
	}

	responses := make([]state.ResponseSpec, len(*request.Responses))
	for i, response := range *request.Responses {
		validated, ok := response.responseSpec()
		if !ok {
			writeInvalidRequest(w)
			return
		}
		responses[i] = validated
	}
	store.ReplaceResponses(responses)
	w.WriteHeader(http.StatusNoContent)
}

func handleRequests(w http.ResponseWriter, store *state.State) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Requests []state.RequestRecord `json:"requests"`
	}{Requests: store.Requests()})
}

func handleIngest(w http.ResponseWriter, r *http.Request, store *state.State) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return
	}

	headers := make(map[string][]string, len(r.Header))
	for name, values := range r.Header {
		normalizedName := strings.ToLower(name)
		headers[normalizedName] = append(headers[normalizedName], values...)
	}
	// Journal header values are an unordered multivalue representation, so sort
	// each copied slice to make journal output deterministic.
	for _, values := range headers {
		sort.Strings(values)
	}
	store.Record(state.RequestRecord{
		Method:  r.Method,
		Path:    r.URL.Path,
		Headers: headers,
		Body:    string(body),
	})

	response, queued := store.NextResponse()
	if !queued {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, defaultSuccessBody)
		return
	}

	if response.DelayMS > 0 {
		timer := time.NewTimer(time.Duration(response.DelayMS) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-r.Context().Done():
			return
		}
	}

	if response.DisconnectBeforeHeaders {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "connection hijacking unavailable", http.StatusInternalServerError)
			return
		}
		connection, _, err := hijacker.Hijack()
		if err != nil {
			return
		}
		_ = connection.Close()
		return
	}

	if response.DisconnectAfterHeaders {
		writeInterruptedResponse(w, response)
		return
	}

	for name, value := range response.Headers {
		w.Header().Set(name, value)
	}
	w.WriteHeader(response.Status)
	_, _ = io.WriteString(w, response.Body)
}

// writeInterruptedResponse sends a complete status line and headers, promises
// more body bytes than it writes, and then closes the connection. Clients observe
// a known HTTP status followed by a body read failure.
func writeInterruptedResponse(w http.ResponseWriter, response state.ResponseSpec) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "connection hijacking unavailable", http.StatusInternalServerError)
		return
	}
	connection, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer connection.Close()
	names := make([]string, 0, len(response.Headers))
	for name := range response.Headers {
		if !strings.EqualFold(name, "Content-Length") && !strings.EqualFold(name, "Transfer-Encoding") && !strings.EqualFold(name, "Connection") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	_, _ = fmt.Fprintf(buffered, "HTTP/1.1 %d %s\r\n", response.Status, http.StatusText(response.Status))
	for _, name := range names {
		_, _ = fmt.Fprintf(buffered, "%s: %s\r\n", name, response.Headers[name])
	}
	_, _ = fmt.Fprintf(buffered, "Content-Length: %d\r\nConnection: close\r\n\r\n%s", len(response.Body)+interruptedBodyShortfall, response.Body)
	_ = buffered.Flush()
}

// interruptedBodyShortfall is the number of promised body bytes never written.
const interruptedBodyShortfall = 1024

func writeInvalidRequest(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = io.WriteString(w, `{"error":"invalid request"}`)
}

func decodeJSON(body io.Reader, destination any) error {
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errTrailingJSON
		}
		return err
	}
	return nil
}

type responseQueueRequest struct {
	Responses *[]responseInput `json:"responses"`
}

type responseInput struct {
	Status                  *int              `json:"status"`
	Headers                 map[string]string `json:"headers"`
	Body                    *string           `json:"body"`
	DelayMS                 *int              `json:"delay_ms"`
	DisconnectBeforeHeaders *bool             `json:"disconnect_before_headers"`
	DisconnectAfterHeaders  *bool             `json:"disconnect_after_headers"`
}

func (r responseInput) responseSpec() (state.ResponseSpec, bool) {
	if r.Body == nil {
		return state.ResponseSpec{}, false
	}
	if r.Status == nil && (r.DisconnectBeforeHeaders == nil || !*r.DisconnectBeforeHeaders) {
		return state.ResponseSpec{}, false
	}
	if r.Status != nil && (*r.Status < http.StatusOK || *r.Status > 599) {
		return state.ResponseSpec{}, false
	}
	if r.DisconnectAfterHeaders != nil && *r.DisconnectAfterHeaders && (r.Status == nil || (r.DisconnectBeforeHeaders != nil && *r.DisconnectBeforeHeaders)) {
		return state.ResponseSpec{}, false
	}
	if r.DelayMS != nil && (*r.DelayMS < 0 || int64(*r.DelayMS) > math.MaxInt64/int64(time.Millisecond)) {
		return state.ResponseSpec{}, false
	}
	for name, value := range r.Headers {
		if !validHeaderName(name) || !validHeaderValue(value) {
			return state.ResponseSpec{}, false
		}
	}

	response := state.ResponseSpec{
		Headers: r.Headers,
		Body:    *r.Body,
	}
	if r.Status != nil {
		response.Status = *r.Status
	}
	if r.DelayMS != nil {
		response.DelayMS = *r.DelayMS
	}
	if r.DisconnectBeforeHeaders != nil {
		response.DisconnectBeforeHeaders = *r.DisconnectBeforeHeaders
	}
	if r.DisconnectAfterHeaders != nil {
		response.DisconnectAfterHeaders = *r.DisconnectAfterHeaders
	}
	return response, true
}

// validHeaderValue accepts HTTP field-value bytes: visible ASCII, obs-text,
// spaces, and HTAB. Other control bytes (including CR, LF, and DEL) are invalid.
func validHeaderValue(value string) bool {
	for i := 0; i < len(value); i++ {
		character := value[i]
		if character < ' ' && character != '\t' || character == 0x7f {
			return false
		}
	}
	return true
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for _, character := range name {
		if !((character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			strings.ContainsRune("!#$%&'*+-.^_`|~", character)) {
			return false
		}
	}
	return true
}

type trailingJSONError struct{}

func (trailingJSONError) Error() string { return "trailing JSON value" }

var errTrailingJSON error = trailingJSONError{}
