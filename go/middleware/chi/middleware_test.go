package chi

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	cekat "github.com/cekataiofficial/cekat-event-sdk-go"
	chiv5 "github.com/go-chi/chi/v5"
)

func TestMiddlewareEnrichesChiDerivedRequestAndPreservesRequestAndResponse(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Cekat-Visitor-ID", "  header-visitor  ")
	request.AddCookie(&http.Cookie{Name: "_cekat_visitor_id", Value: "cookie-visitor"})
	originalHeaders := request.Header.Clone()
	originalCookies := request.Cookies()

	var downstreamRequest *http.Request
	router := chiv5.NewRouter()
	router.Use(Middleware)
	router.Get("/", func(w http.ResponseWriter, r *http.Request) {
		downstreamRequest = r
		if got, ok := cekat.VisitorIDFromContext(r.Context()); got != "header-visitor" || !ok {
			t.Errorf("VisitorIDFromContext(downstream.Context()) = (%q, %t), want (header-visitor, true)", got, ok)
		}
		w.WriteHeader(http.StatusCreated)
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
	router := chiv5.NewRouter()
	router.Use(Middleware)
	router.Get("/", func(w http.ResponseWriter, r *http.Request) {
		if got, ok := cekat.VisitorIDFromContext(r.Context()); got != "cookie-visitor" || !ok {
			t.Errorf("VisitorIDFromContext(downstream.Context()) = (%q, %t), want (cookie-visitor, true)", got, ok)
		}
		w.WriteHeader(http.StatusNoContent)
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

func TestMiddlewareDoesNotLeakVisitorAfterRequestCompletion(t *testing.T) {
	var visitors []string
	router := chiv5.NewRouter()
	router.Use(Middleware)
	router.Get("/", func(w http.ResponseWriter, r *http.Request) {
		visitorID, _ := cekat.VisitorIDFromContext(r.Context())
		visitors = append(visitors, visitorID)
		w.WriteHeader(http.StatusAccepted)
	})

	withVisitor := httptest.NewRequest(http.MethodGet, "/", nil)
	withVisitor.Header.Set("X-Cekat-Visitor-ID", "visitor-one")
	router.ServeHTTP(httptest.NewRecorder(), withVisitor)

	withoutVisitor := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, withoutVisitor)

	if got, want := visitors, []string{"visitor-one", ""}; !reflect.DeepEqual(got, want) {
		t.Errorf("visitor IDs across completed requests = %#v, want %#v", got, want)
	}
	if got, ok := cekat.VisitorIDFromContext(withoutVisitor.Context()); got != "" || ok {
		t.Errorf("VisitorIDFromContext(visitorless original request) = (%q, %t), want (empty, false)", got, ok)
	}
	if got := response.Code; got != http.StatusAccepted {
		t.Errorf("response status = %d, want %d", got, http.StatusAccepted)
	}
}

func TestMiddlewareIsolatesParallelChiRequests(t *testing.T) {
	const requests = 32
	results := make(chan string, requests)
	router := chiv5.NewRouter()
	router.Use(Middleware)
	router.Get("/", func(w http.ResponseWriter, r *http.Request) {
		visitorID, _ := cekat.VisitorIDFromContext(r.Context())
		results <- visitorID
		w.WriteHeader(http.StatusOK)
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
	return "visitor-" + string(rune('a'+i))
}
