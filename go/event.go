package cekat

// Event is an identity-bearing event submitted to Cekat.
type Event struct {
	Email       string
	PhoneNumber string
	ContactName string
	VisitorID   string
	Properties  map[string]any
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
	ContactName string         `json:"contact_name,omitempty"`
	PhoneNumber string         `json:"phone_number,omitempty"`
	Email       string         `json:"email,omitempty"`
	VisitorID   string         `json:"visitor_id,omitempty"`
	IsCommon    bool           `json:"is_common"`
	Properties  map[string]any `json:"properties,omitempty"`
}
