package tunnel

import (
	"encoding/json"
	"testing"
)

func TestRunningStatusSaysWhenTheLinkIsNotReachableYet(t *testing.T) {
	cases := []struct {
		line           string
		url            string
		wantPublishing bool
	}{
		// The certificate is on its way.
		{line: `{"protocol":1,"state":"running"}`},
		// Waiting for the link to answer from the internet.
		{line: `{"protocol":1,"state":"running","publishing":true}`, wantPublishing: true},
		// Live: a link is never "publishing".
		{line: `{"protocol":1,"state":"running","url":"https://kiro.tail1234.ts.net","publishing":true}`, url: "https://kiro.tail1234.ts.net"},
	}
	for _, c := range cases {
		var line helperLine
		if err := json.Unmarshal([]byte(c.line), &line); err != nil {
			t.Fatal(err)
		}
		st, ok := (&Manager{}).statusFromHelper(line)
		if !ok || st.State != StateRunning || st.URL != c.url || st.Publishing != c.wantPublishing {
			t.Errorf("%s: status = %+v, ok %v", c.line, st, ok)
		}
	}
}
