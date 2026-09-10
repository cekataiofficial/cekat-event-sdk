package cekat

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
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
	return c.deliver(ctx, payload)
}

func (c *Client) deliver(ctx context.Context, payload wirePayload) (*Acknowledgement, error) {
	attempt := 1
	retriesRemaining := c.config.retryCount
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		acknowledgement, err, retryable := c.doAttempt(ctx, payload, attempt)
		if err == nil {
			return acknowledgement, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !retryable || retriesRemaining == 0 {
			return nil, err
		}
		max := retryMaximum(attempt)
		if err := c.config.sleep(ctx, c.config.jitter(max)); err != nil {
			return nil, ctx.Err()
		}
		retriesRemaining--
		if attempt < int(^uint(0)>>1) {
			attempt++
		}
	}
}

func (c *Client) doAttempt(ctx context.Context, payload wirePayload, attempt int) (*Acknowledgement, error, bool) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &ValidationError{Message: "event payload is not JSON-compatible"}, false
	}
	attemptContext, cancel := context.WithTimeout(ctx, c.config.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptContext, http.MethodPost, c.config.baseURL+ingestPath, bytes.NewReader(body))
	if err != nil {
		return nil, &TransportError{Message: "failed to create request", Attempts: attempt, Cause: err}, false
	}
	request.Header.Set("Authorization", "Bearer "+c.accessToken)
	request.Header.Set("Content-Type", "application/json")

	httpClient := *c.config.httpClient
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err(), false
		}
		return nil, &TransportError{
			Message:                "Cekat API request failed before a response was received",
			Attempts:               attempt,
			DeliveryOutcomeUnknown: true,
			Cause:                  err,
		}, true
	}
	defer response.Body.Close()

	acknowledgement, err := decodeResponse(response.StatusCode, response.Body, attempt)
	if err != nil {
		return nil, err, response.StatusCode == http.StatusInternalServerError
	}
	return acknowledgement, nil, false
}
