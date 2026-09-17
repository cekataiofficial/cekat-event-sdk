package fiber

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"

	fiberlib "github.com/gofiber/fiber/v3"
	fiberecover "github.com/gofiber/fiber/v3/middleware/recover"
	cekat "golang.cekat.ai/event-sdk"
)

type priorKey struct{}

func TestMiddlewareResolvesTrimmedHeaderAndRestoresContext(t *testing.T) {
	app := fiberlib.New()
	prior := context.WithValue(context.Background(), priorKey{}, "value")
	app.Use(func(c fiberlib.Ctx) error {
		c.SetContext(prior)
		err := Middleware()(c)
		if got := c.Context(); got != prior {
			t.Errorf("context after middleware = %#v, want prior context", got)
		}
		return err
	})
	app.Get("/", func(c fiberlib.Ctx) error {
		if got, ok := cekat.VisitorIDFromContext(c.Context()); !ok || got != "header-visitor" {
			t.Errorf("VisitorIDFromContext(c.Context()) = (%q, %t), want (header-visitor, true)", got, ok)
		}
		if got := c.Context().Value(priorKey{}); got != "value" {
			t.Errorf("prior context value = %#v, want preserved parent value", got)
		}
		return c.SendStatus(http.StatusNoContent)
	})

	request := newRequest(t, "  header-visitor  ")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("app.Test() error = %v", err)
	}
	defer response.Body.Close()
	if got := response.StatusCode; got != http.StatusNoContent {
		t.Errorf("response status = %d, want %d", got, http.StatusNoContent)
	}
}

func TestMiddlewareUsesTrimmedCookie(t *testing.T) {
	app := fiberlib.New()
	app.Use(Middleware())
	app.Get("/", func(c fiberlib.Ctx) error {
		if got, ok := cekat.VisitorIDFromContext(c.Context()); !ok || got != "cookie-visitor" {
			t.Errorf("VisitorIDFromContext(c.Context()) = (%q, %t), want (cookie-visitor, true)", got, ok)
		}
		return c.SendStatus(http.StatusNoContent)
	})

	request, err := http.NewRequest(http.MethodGet, "/", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Cekat-Visitor-ID", " \t ")
	request.Header.Set("Cookie", "_cekat_visitor_id=  cookie-visitor  ")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("app.Test() error = %v", err)
	}
	defer response.Body.Close()
}

func TestMiddlewareWithoutVisitorLeavesContextUnchanged(t *testing.T) {
	app := fiberlib.New()
	app.Use(Middleware())
	app.Get("/", func(c fiberlib.Ctx) error {
		if got, ok := cekat.VisitorIDFromContext(c.Context()); ok {
			t.Errorf("VisitorIDFromContext(c.Context()) = (%q, true), want absent", got)
		}
		return c.SendStatus(http.StatusNoContent)
	})
	request, err := http.NewRequest(http.MethodGet, "/", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("app.Test() error = %v", err)
	}
	response.Body.Close()
}

func TestMiddlewareReturnsExactDownstreamErrorAndRestoresContext(t *testing.T) {
	want := errors.New("downstream error")
	app := fiberlib.New(fiberlib.Config{ErrorHandler: func(c fiberlib.Ctx, err error) error {
		if err != want {
			t.Errorf("error handler received %v, want exact downstream error %v", err, want)
		}
		return c.SendStatus(http.StatusTeapot)
	}})
	app.Use(func(c fiberlib.Ctx) error {
		prior := c.Context()
		got := Middleware()(c)
		if got != want {
			t.Errorf("Middleware() error = %v, want exact downstream error %v", got, want)
		}
		if c.Context() != prior {
			t.Error("context after middleware error was not restored")
		}
		return got
	})
	app.Get("/", func(fiberlib.Ctx) error { return want })

	response, err := app.Test(newRequest(t, "error-visitor"))
	if err != nil {
		t.Fatalf("app.Test() error = %v", err)
	}
	defer response.Body.Close()
	if got := response.StatusCode; got != http.StatusTeapot {
		t.Errorf("response status = %d, want %d", got, http.StatusTeapot)
	}
}

func TestMiddlewareRestoresContextWhenDownstreamPanics(t *testing.T) {
	panicValue := "handler panic"
	app := fiberlib.New()
	app.Use(fiberecover.New(fiberecover.Config{PanicHandler: func(_ fiberlib.Ctx, got any) error {
		if got != panicValue {
			t.Errorf("recovered panic = %#v, want %#v", got, panicValue)
		}
		return nil
	}}))
	app.Use(func(c fiberlib.Ctx) (err error) {
		prior := c.Context()
		defer func() {
			if c.Context() != prior {
				t.Error("context after panic was not restored")
			}
		}()
		return Middleware()(c)
	})
	app.Get("/", func(fiberlib.Ctx) error { panic(panicValue) })

	response, err := app.Test(newRequest(t, "panic-visitor"))
	if err != nil {
		t.Fatalf("app.Test() error = %v", err)
	}
	response.Body.Close()
}

func TestMiddlewareCopiesVisitorTextAcrossContextReuse(t *testing.T) {
	app := fiberlib.New()
	var retained context.Context
	app.Use(Middleware())
	app.Get("/", func(c fiberlib.Ctx) error {
		retained = c.Context()
		return c.SendStatus(http.StatusNoContent)
	})

	for i := range 100 {
		visitorID := fmt.Sprintf("visitor-%03d-with-distinct-length", i)
		response, err := app.Test(newRequest(t, visitorID))
		if err != nil {
			t.Fatalf("request %d app.Test() error = %v", i, err)
		}
		response.Body.Close()
		if got, ok := cekat.VisitorIDFromContext(retained); !ok || got != visitorID {
			t.Fatalf("retained visitor after request %d = (%q, %t), want (%q, true)", i, got, ok, visitorID)
		}
	}
}

func TestMiddlewareIsolatesFiftyConcurrentRequests(t *testing.T) {
	const requests = 50
	app := fiberlib.New()
	results := make(chan string, requests)
	app.Use(Middleware())
	app.Get("/", func(c fiberlib.Ctx) error {
		visitorID, _ := cekat.VisitorIDFromContext(c.Context())
		results <- visitorID
		return c.SendStatus(http.StatusNoContent)
	})

	var workers sync.WaitGroup
	workers.Add(requests)
	for i := range requests {
		go func(i int) {
			defer workers.Done()
			response, err := app.Test(newRequest(t, fmt.Sprintf("visitor-%d", i)))
			if err != nil {
				t.Errorf("request %d app.Test() error = %v", i, err)
				return
			}
			response.Body.Close()
			if got := response.StatusCode; got != http.StatusNoContent {
				t.Errorf("request %d response status = %d, want %d", i, got, http.StatusNoContent)
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
		visitorID := fmt.Sprintf("visitor-%d", i)
		if !seen[visitorID] {
			t.Errorf("concurrent visitor %q was not observed", visitorID)
		}
	}
}

func newRequest(t *testing.T, visitorID string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, "/", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Cekat-Visitor-ID", visitorID)
	return request
}
