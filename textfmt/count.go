package textfmt

import "strconv"

// Count writes n with the noun that fits it: "1 request", "2 requests", "0 requests".
// Go's "%d requests" read "1 requests", and "account(s)" is not plain English.
func Count(n int, singular, plural string) string {
	if n == 1 {
		return "1 " + singular
	}
	return strconv.Itoa(n) + " " + plural
}
