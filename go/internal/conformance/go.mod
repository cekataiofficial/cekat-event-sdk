module golang.cekat.ai/event-sdk/internal/conformance

go 1.22

require (
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.1
	golang.cekat.ai/event-sdk v0.1.0
)

require golang.org/x/text v0.14.0 // indirect

replace golang.cekat.ai/event-sdk => ../..
