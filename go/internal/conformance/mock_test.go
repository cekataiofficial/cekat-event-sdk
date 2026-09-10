package conformance

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestQueuePostsExactEnvelopeIncludingEmptyQueue(t *testing.T) {
	var received []byte
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/__control/responses" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		var err error
		received, err = io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	control, err := newControlClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err := control.queue(nil, nil); err != nil {
		t.Fatal(err)
	}
	if string(received) != `{"responses":[]}` {
		t.Fatalf("queue envelope = %s", received)
	}
	status := 200
	if err := control.queue([]mockResponse{{Status: &status, Body: "ok"}}, nil); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(received, &value); err != nil {
		t.Fatal(err)
	}
	response := value["responses"].([]any)[0].(map[string]any)
	if len(response) != 2 || response["status"] != float64(200) || response["body"] != "ok" {
		t.Fatalf("queue response fields = %#v", response)
	}
}
