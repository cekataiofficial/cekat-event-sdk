package cekat

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultBaseURL = "https://server.cekat.ai"

// Option configures a Client during construction.
type Option func(*config) error

type config struct {
	baseURL    string
	timeout    time.Duration
	retryCount int
	httpClient *http.Client
	sleep      func(context.Context, time.Duration) error
	jitter     func(time.Duration) time.Duration
}

func defaultConfig() config {
	return config{
		baseURL:    defaultBaseURL,
		timeout:    10 * time.Second,
		retryCount: 2,
		httpClient: &http.Client{},
	}
}

// New creates a Client with accessToken and optional configuration.
func New(accessToken string, options ...Option) (*Client, error) {
	cfg := defaultConfig()
	if strings.TrimSpace(accessToken) == "" {
		return nil, &ValidationError{Message: "access token must not be blank"}
	}
	for _, option := range options {
		if option == nil {
			return nil, &ValidationError{Message: "option must not be nil"}
		}
		if err := option(&cfg); err != nil {
			return nil, asValidationError(err)
		}
	}
	if err := validateConfig(&cfg); err != nil {
		return nil, err
	}
	return &Client{accessToken: accessToken, config: cfg}, nil
}

// WithBaseURL sets the HTTP(S) origin used for Cekat requests.
func WithBaseURL(baseURL string) Option {
	return func(cfg *config) error {
		cfg.baseURL = baseURL
		return nil
	}
}

// WithTimeout sets the timeout applied to each network attempt.
func WithTimeout(timeout time.Duration) Option {
	return func(cfg *config) error {
		cfg.timeout = timeout
		return nil
	}
}

// WithRetryCount sets the retries attempted after the first request.
func WithRetryCount(retryCount int) Option {
	return func(cfg *config) error {
		cfg.retryCount = retryCount
		return nil
	}
}

// WithHTTPClient sets the HTTP client used for requests. The client is not mutated.
func WithHTTPClient(httpClient *http.Client) Option {
	return func(cfg *config) error {
		cfg.httpClient = httpClient
		return nil
	}
}

func validateConfig(cfg *config) error {
	baseURL, err := parseBaseURL(cfg.baseURL)
	if err != nil {
		return &ValidationError{Message: err.Error()}
	}
	if cfg.timeout <= 0 {
		return &ValidationError{Message: "timeout must be greater than zero"}
	}
	if cfg.retryCount < 0 {
		return &ValidationError{Message: "retry count must not be negative"}
	}
	if cfg.httpClient == nil {
		return &ValidationError{Message: "HTTP client must not be nil"}
	}
	cfg.baseURL = baseURL
	return nil
}

func parseBaseURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("base URL must be a valid absolute HTTP(S) origin")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("base URL must use HTTP or HTTPS")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("base URL must include a host")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("base URL must not include credentials")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("base URL must not include a path")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return "", fmt.Errorf("base URL must not include a query")
	}
	if parsed.Fragment != "" || strings.Contains(rawURL, "#") {
		return "", fmt.Errorf("base URL must not include a fragment")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func asValidationError(err error) *ValidationError {
	if validationErr, ok := err.(*ValidationError); ok {
		return validationErr
	}
	return &ValidationError{Message: err.Error()}
}
