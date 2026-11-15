package tunnel

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrorStatusCarriesCodeAndDetail(t *testing.T) {
	err := &failure{code: CodeHelperStart, detail: "permission denied", err: fmt.Errorf("start the Tailscale helper: %w", errors.New("permission denied"))}
	st := errorStatus(err)
	if st.State != StateError || st.Error != "start the Tailscale helper: permission denied" ||
		st.ErrorCode != CodeHelperStart || st.ErrorDetail != "permission denied" {
		t.Fatalf("status = %+v", st)
	}

	mismatch := &failure{code: CodeHelperMismatch, err: fmt.Errorf("%w (protocol 1, want 2)", errProtocol)}
	if !errors.Is(mismatch, errProtocol) {
		t.Fatal("a mismatch failure no longer unwraps to errProtocol")
	}

	plain := errorStatus(errors.New("boom"))
	if plain.Error != "boom" || plain.ErrorCode != "" || plain.ErrorDetail != "" {
		t.Fatalf("plain status = %+v", plain)
	}
}
