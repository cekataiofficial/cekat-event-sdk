package gin

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	cekat "golang.cekat.ai/event-sdk"
)

func TestMiddlewareEnrichesGinRequestAndPreservesRequestAndResponse(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Cekat-Visitor-ID", "  header-visitor  ")
	request.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "cookie-visitor"})
	originalHeaders := request.Header.Clone()
	originalCookies := request.Cookies()

	var downstreamRequest *http.Request
	router := gin.New()
	router.Use(Middleware())
	router.GET("/", func(c *gin.Context) {
		downstreamRequest = c.Request
		if got, ok := cekat.VisitorIDFromContext(c.Request.Context()); got != "header-visitor" || !ok {
			t.Errorf("VisitorIDFromContext(downstream.Context()) = (%q, %t), want (header-visitor, true)", got, ok)
		}
		c.Status(http.StatusCreated)
	})

	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

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
	if got := response.Code; got != http.StatusCreated {
		t.Errorf("response status = %d, want %d", got, http.StatusCreated)
	}
	if cookies := response.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("middleware emitted cookies: %#v", cookies)
	}
}

func TestMiddlewareUsesTrimmedCookieWhenHeaderIsBlank(t *testing.T) {
	router := gin.New()
	router.Use(Middleware())
	router.GET("/", func(c *gin.Context) {
		if got, ok := cekat.VisitorIDFromContext(c.Request.Context()); got != "cookie-visitor" || !ok {
			t.Errorf("VisitorIDFromContext(downstream.Context()) = (%q, %t), want (cookie-visitor, true)", got, ok)
		}
		c.Status(http.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Cekat-Visitor-ID", " \t ")
	request.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "  cookie-visitor  "})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if got := response.Code; got != http.StatusNoContent {
		t.Errorf("response status = %d, want %d", got, http.StatusNoContent)
	}
	if cookies := response.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("middleware emitted cookies: %#v", cookies)
	}
}

func TestMiddlewarePreservesGinAbortAndStatus(t *testing.T) {
	endpointCalled := false
	router := gin.New()
	router.Use(Middleware())
	router.GET("/", func(c *gin.Context) {
		c.AbortWithStatus(http.StatusTeapot)
	}, func(c *gin.Context) {
		endpointCalled = true
	})

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))

	if endpointCalled {
		t.Error("handler after AbortWithStatus was called")
	}
	if got := response.Code; got != http.StatusTeapot {
		t.Errorf("response status = %d, want %d", got, http.StatusTeapot)
	}
}

func TestMiddlewareAllowsPanicToReachGinRecovery(t *testing.T) {
	router := gin.New()
	router.Use(gin.RecoveryWithWriter(io.Discard), Middleware())
	router.GET("/", func(c *gin.Context) {
		panic("handler panic")
	})

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := response.Code; got != http.StatusInternalServerError {
		t.Errorf("response status after panic = %d, want %d from Gin recovery", got, http.StatusInternalServerError)
	}
}

func TestMiddlewareIsolatesFiftyParallelGinRequests(t *testing.T) {
	const requests = 50
	results := make(chan string, requests)
	router := gin.New()
	router.Use(Middleware())
	router.GET("/", func(c *gin.Context) {
		visitorID, _ := cekat.VisitorIDFromContext(c.Request.Context())
		results <- visitorID
		c.Status(http.StatusOK)
	})

	var workers sync.WaitGroup
	workers.Add(requests)
	for i := range requests {
		go func(i int) {
			defer workers.Done()
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("X-Cekat-Visitor-ID", parallelVisitorID(i))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Errorf("request %d response status = %d, want %d", i, response.Code, http.StatusOK)
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
