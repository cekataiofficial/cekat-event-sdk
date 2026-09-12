// Package cekat provides synchronous Cekat event submission.
//
// A successful acknowledgement means that Cekat accepted an event for asynchronous
// processing; it does not confirm durable storage, identity resolution, delivery
// completion, or analytics availability. Retried requests can create duplicate
// events because the SDK does not provide an idempotency guarantee.
package cekat
