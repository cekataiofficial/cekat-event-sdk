package cekat

import "time"

// Event is an identity-bearing event submitted to Cekat.
type Event struct {
	Email       string
	PhoneNumber string
	ContactName string
	VisitorID   string
	// EventID identifies this event so the server can deduplicate deliveries.
	// When blank, the SDK generates a random UUID for the call and reuses it for
	// every retry. Supply a stable ID (for example an order or webhook ID) when
	// the same business event may be submitted more than once.
	EventID string
	// OccurredAt is when the event happened. When zero, the SDK uses the time of
	// the call. It is sent in UTC with millisecond precision.
	OccurredAt time.Time
	// Properties are encoded with encoding/json, so values such as time.Time,
	// pointers, structs, and types implementing json.Marshaler use their standard
	// JSON form. The encoded result must contain only finite numbers and integers
	// within ±(2^53-1).
	Properties map[string]any
}

// Acknowledgement is Cekat's response to a successfully accepted event.
type Acknowledgement struct {
	Success             bool
	Message             string
	EventKey            string
	ValidatedProperties []string
	RawBody             []byte
}

// Client submits Cekat events using its configured access token.
type Client struct {
	accessToken string
	config      config
}

type wirePayload struct {
	EventKey    string         `json:"event_key"`
	EventID     string         `json:"event_id"`
	OccurredAt  string         `json:"occurred_at"`
	ContactName string         `json:"contact_name,omitempty"`
	PhoneNumber string         `json:"phone_number,omitempty"`
	Email       string         `json:"email,omitempty"`
	VisitorID   string         `json:"visitor_id,omitempty"`
	IsCommon    bool           `json:"is_common"`
	Properties  map[string]any `json:"properties,omitempty"`
}
