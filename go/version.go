package cekat

import "runtime"

// Version is the SDK release version reported in the User-Agent header.
const Version = "0.2.0"

var userAgent = "cekat-event-sdk-go/" + Version + " " + runtime.Version()
