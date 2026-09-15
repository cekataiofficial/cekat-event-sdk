package echo

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	"github.com/labstack/echo/v4"
	cekat "go.cekat.ai/event-sdk"
)

func TestMiddlewareEnrichesEchoRequestAndPreservesOriginalRequest(t *testing.T) {
	e := echo.New()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Cekat-Visitor-ID", "  header-visitor  ")
	request.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "cookie-visitor"})
	originalHeaders := request.Header.Clone()
	originalCookies := request.Cookies()
	context := e.NewContext(request, httptest.NewRecorder())

	var downstreamRequest *http.Request
	err := Middleware()(func(c echo.Context) error {
		downstreamRequest = c.Request()
		if got, ok := cekat.VisitorIDFromContext(c.Request().Context()); got != "header-visitor" || !ok {
			t.Errorf("VisitorIDFromContext(downstream.Context()) = (%q, %t), want (header-visitor, true)", got, ok)
		}
		return nil
	})(context)

	if err != nil {
		t.Fatalf("middleware returned error = %v, want nil", err)
	}
	if downstreamRequest == request {
		t.Error("downstream received the original request instead of a derived request")
	}
	if got, ok := cekat.VisitorIDFromContext(request.Context()); got != "" || ok {
		t.Errorf("VisitorIDFromContext(original.Context()) = (%q, %t), want (empty, false)", got, ok)
	}
	if !reflect.DeepEqual(request.Header, originalHeaders) {
		t.Errorf("middleware mutated request headers: got %#v, want %#v", request.Header, originalHeaders)
	}
	if got := request.Cookies(); !reflect.DeepEqual(got, originalCookies) {
		t.Errorf("middleware mutated request cookies: got %#v, want %#v", got, originalCookies)
	}
}

func TestMiddlewareUsesTrimmedCookieWhenHeaderIsBlank(t *testing.T) {
	e := echo.New()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Cekat-Visitor-ID", " \t ")
	request.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "  cookie-visitor  "})
	context := e.NewContext(request, httptest.NewRecorder())

	err := Middleware()(func(c echo.Context) error {
		if got, ok := cekat.VisitorIDFromContext(c.Request().Context()); got != "cookie-visitor" || !ok {
			t.Errorf("VisitorIDFromContext(downstream.Context()) = (%q, %t), want (cookie-visitor, true)", got, ok)
		}
		return nil
	})(context)

	if err != nil {
		t.Fatalf("middleware returned error = %v, want nil", err)
	}
}

func TestMiddlewareReturnsExactDownstreamError(t *testing.T) {
	e := echo.New()
	context := e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), httptest.NewRecorder())
	want := errors.New("downstream error")

	got := Middleware()(func(echo.Context) error {
		return want
	})(context)

	if got != want {
		t.Errorf("middleware error = %v, want exact downstream error %v", got, want)
	}
}

func TestMiddlewarePropagatesDownstreamPanic(t *testing.T) {
	e := echo.New()
	context := e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), httptest.NewRecorder())
	panicValue := "handler panic"

	defer func() {
		if got := recover(); got != panicValue {
			t.Errorf("recovered panic = %#v, want %#v", got, panicValue)
		}
	}()
	Middleware()(func(echo.Context) error {
		panic(panicValue)
	})(context)
}

func TestMiddlewareIsolatesFiftyParallelEchoRequests(t *testing.T) {
	const requests = 50
	results := make(chan string, requests)
	middleware := Middleware()
	handler := middleware(func(c echo.Context) error {
		visitorID, _ := cekat.VisitorIDFromContext(c.Request().Context())
		results <- visitorID
		return nil
	})

	var workers sync.WaitGroup
	workers.Add(requests)
	for i := range requests {
		go func(i int) {
			defer workers.Done()
			e := echo.New()
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("X-Cekat-Visitor-ID", parallelVisitorID(i))
			context := e.NewContext(request, httptest.NewRecorder())
			if err := handler(context); err != nil {
				t.Errorf("request %d middleware error = %v, want nil", i, err)
			}
		}(i)
	}
	workers.Wait()
	close(results)

	seen := make(map[string]bool, requests)
	for visitorID := range results {
		seen[visitorID] = true
	}
	for i := range requests {
		if !seen[parallelVisitorID(i)] {
			t.Errorf("parallel request visitor %q was not observed", parallelVisitorID(i))
		}
	}
}

func parallelVisitorID(i int) string {
	return fmt.Sprintf("visitor-%d", i)
}
