module github.com/cekataiofficial/cekat-event-sdk-go/internal/conformance

go 1.22

require (
	github.com/cekataiofficial/cekat-event-sdk-go v0.1.0
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.1
)

require golang.org/x/text v0.14.0 // indirect

replace github.com/cekataiofficial/cekat-event-sdk-go => ../..
