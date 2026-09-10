package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type controlClient struct {
	origin string
	http   *http.Client
}
type journalEnvelope struct {
	Requests []journalEntry `json:"requests"`
}
type journalEntry struct {
	Sequence int                 `json:"sequence"`
	Method   string              `json:"method"`
	Path     string              `json:"path"`
	Headers  map[string][]string `json:"headers"`
	Body     string              `json:"body"`
}

func newControlClient(origin string) *controlClient {
	return &controlClient{origin: strings.TrimSuffix(origin, "/"), http: &http.Client{}}
}
func (c *controlClient) reset() error { return c.post("/__control/reset", nil) }
func (c *controlClient) queue(responses []mockResponse, recipe *bodyRecipe) error {
	if len(responses) == 0 && recipe == nil {
		return nil
	}
	queued := append([]mockResponse(nil), responses...)
	if recipe != nil {
		if len(queued) != 1 {
			return fmt.Errorf("response-body recipe requires exactly one response")
		}
		queued[0].Body = expandBodyRecipe(recipe)
	}
	return c.post("/__control/responses", struct {
		Responses []mockResponse `json:"responses"`
	}{queued})
}
func (c *controlClient) requests() ([]journalEntry, error) {
	response, err := c.http.Get(c.origin + "/__control/requests")
	if err != nil {
		return nil, fmt.Errorf("read mock journal: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("read mock journal: status %d", response.StatusCode)
	}
	var envelope journalEnvelope
	decoder := json.NewDecoder(response.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode mock journal: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("decode mock journal: trailing JSON")
	}
	return envelope.Requests, nil
}
func (c *controlClient) post(path string, body any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(http.MethodPost, c.origin+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("mock control %s unreachable: %w", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("mock control %s returned status %d", path, response.StatusCode)
	}
	return nil
}
