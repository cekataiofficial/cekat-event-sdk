package cekat

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/cekataiofficial/cekat-event-sdk-go/internal/retryobserver"
)

const ingestPath = "/api/events/ingest"

// UserRegistration submits the common user_registration event.
func (c *Client) UserRegistration(ctx context.Context, event Event) (*Acknowledgement, error) {
	return c.track(ctx, "user_registration", true, event)
}

// UserLogin submits the common user_login event.
func (c *Client) UserLogin(ctx context.Context, event Event) (*Acknowledgement, error) {
	return c.track(ctx, "user_login", true, event)
}

// OrderCreated submits the common order_created event.
func (c *Client) OrderCreated(ctx context.Context, event Event) (*Acknowledgement, error) {
	return c.track(ctx, "order_created", true, event)
}

// OrderPaid submits the common order_paid event.
func (c *Client) OrderPaid(ctx context.Context, event Event) (*Acknowledgement, error) {
	return c.track(ctx, "order_paid", true, event)
}

// CustomEvent submits event using its caller-provided event key.
func (c *Client) CustomEvent(ctx context.Context, eventKey string, event Event) (*Acknowledgement, error) {
	return c.track(ctx, eventKey, false, event)
}

func (c *Client) track(ctx context.Context, eventKey string, isCommon bool, event Event) (*Acknowledgement, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	payload, err := buildPayload(ctx, eventKey, isCommon, event)
	if err != nil {
		return nil, err
	}
	// The body is encoded once so every retry sends the same event ID and timestamp.
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &ValidationError{Message: "event payload is not JSON-compatible"}
	}
	return c.deliver(ctx, body)
}

// attemptResult is the outcome of one HTTP attempt.
type attemptResult struct {
	acknowledgement *Acknowledgement
	err             error
	retryable       bool
	retryAfter      time.Duration
	hasRetryAfter   bool
}

func (c *Client) deliver(ctx context.Context, body []byte) (*Acknowledgement, error) {
	attempts, ok := retryAttempts(c.config.retryCount)
	if !ok {
		return nil, &ValidationError{Message: retryCountAttemptBoundsMessage}
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result := c.doAttempt(ctx, body, attempt)
		if result.err == nil {
			return result.acknowledgement, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !result.retryable || attempt == attempts {
			return nil, result.err
		}
		if result.hasRetryAfter && result.retryAfter > maximumRetryAfter {
			return nil, result.err
		}
		delay := c.config.jitter(retryMaximum(attempt))
		if result.hasRetryAfter && result.retryAfter > delay {
			delay = result.retryAfter
		}
		retryobserver.Observe(ctx, delay)
		if err := c.config.sleep(ctx, delay); err != nil {
			return nil, ctx.Err()
		}
	}
	panic("unreachable")
}

func (c *Client) doAttempt(ctx context.Context, body []byte, attempt int) attemptResult {
	attemptContext, cancel := context.WithTimeout(ctx, c.config.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptContext, http.MethodPost, c.config.baseURL+ingestPath, bytes.NewReader(body))
	if err != nil {
		return attemptResult{err: &TransportError{Message: "failed to create request", Attempts: attempt, Cause: err}}
	}
	request.Header.Set("Authorization", "Bearer "+c.accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", userAgent)

	httpClient := *c.config.httpClient
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return attemptResult{err: ctx.Err()}
		}
		return attemptResult{
			err: &TransportError{
				Message:                "Cekat API request failed before a response was received",
				Attempts:               attempt,
				DeliveryOutcomeUnknown: true,
				Cause:                  err,
			},
			retryable: true,
		}
	}
	defer response.Body.Close()

	// Retry is decided by status alone: a body read failure on a received 200 is a
	// decode error (the event was accepted), while a retryable status stays retryable.
	acknowledgement, err := decodeResponse(response.StatusCode, response.Body, attempt)
	if err != nil {
		result := attemptResult{err: err, retryable: retryableStatus(response.StatusCode)}
		if result.retryable {
			result.retryAfter, result.hasRetryAfter = parseRetryAfter(response.Header.Get("Retry-After"), time.Now())
		}
		return result
	}
	return attemptResult{acknowledgement: acknowledgement}
}
