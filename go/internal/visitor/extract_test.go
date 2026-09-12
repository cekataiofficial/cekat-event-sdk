package visitor

import "testing"

func TestResolve(t *testing.T) {
	tests := []struct {
		name   string
		header string
		cookie string
		want   string
		ok     bool
	}{
		{name: "trimmed header takes precedence over cookie", header: "  header-visitor  ", cookie: "cookie-visitor", want: "header-visitor", ok: true},
		{name: "blank header falls back to cookie", header: " \t ", cookie: "  cookie-visitor  ", want: "cookie-visitor", ok: true},
		{name: "missing visitor", want: "", ok: false},
		{name: "blank candidates", header: " ", cookie: "\t", want: "", ok: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := Resolve(test.header, test.cookie)
			if got != test.want || ok != test.ok {
				t.Errorf("Resolve(%q, %q) = (%q, %t), want (%q, %t)", test.header, test.cookie, got, ok, test.want, test.ok)
			}
		})
	}
}
