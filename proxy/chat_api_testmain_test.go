package proxy

import (
	"context"
	"net/http"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	//! No test reaches Kiro: the create_response_api flag reads as off unless a test says otherwise.
	chatAPIFlagFetch = func(context.Context, *http.Client, *http.Request) (bool, error) { return false, nil }
	os.Exit(m.Run())
}
