package totp

import (
	"strings"
	"testing"
	"time"
)

// rfcSecret is RFC 6238 appendix B's SHA-1 key, "12345678901234567890", in base32.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func TestRFC6238Vectors(t *testing.T) {
	// Appendix B lists eight digits; the six-digit code is its last six.
	vectors := []struct {
		unix int64
		code string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}
	key, err := decodeSecret(rfcSecret)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		step := Step(time.Unix(v.unix, 0))
		if got := hotp(key, uint64(step), 8); got != v.code {
			t.Errorf("t=%d: got %s, want %s", v.unix, got, v.code)
		}
		six, err := CodeAt(rfcSecret, step)
		if err != nil || six != v.code[2:] {
			t.Errorf("t=%d: six digits %s %v, want %s", v.unix, six, err, v.code[2:])
		}
	}
}

func TestMatchAllowsOneStepOfSkew(t *testing.T) {
	now := time.Unix(1111111111, 0)
	current := Step(now)
	for delta := int64(-1); delta <= 1; delta++ {
		code, _ := CodeAt(rfcSecret, current+delta)
		step, ok := Match(rfcSecret, code, now)
		if !ok || step != current+delta {
			t.Errorf("delta %d: step %d %v", delta, step, ok)
		}
	}
	for _, delta := range []int64{-2, 2} {
		code, _ := CodeAt(rfcSecret, current+delta)
		if _, ok := Match(rfcSecret, code, now); ok {
			t.Errorf("a code %d steps away matched", delta)
		}
	}
}

func TestMatchNormalizesAndRejectsJunk(t *testing.T) {
	now := time.Unix(1234567890, 0)
	code, _ := CodeAt(rfcSecret, Step(now))
	if _, ok := Match(rfcSecret, code[:3]+" "+code[3:], now); !ok {
		t.Error("a code with a space did not match")
	}
	for _, bad := range []string{"", "12345", "1234567", "abcdef", code + "x"} {
		if _, ok := Match(rfcSecret, bad, now); ok {
			t.Errorf("%q matched", bad)
		}
	}
	if _, ok := Match("not base32!", code, now); ok {
		t.Error("a broken secret matched")
	}
}

func TestNewSecretIsUsable(t *testing.T) {
	a, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewSecret()
	if a == b || len(a) != 32 || strings.Contains(a, "=") {
		t.Fatalf("secrets %q %q", a, b)
	}
	if _, err := CodeAt(a, 1); err != nil {
		t.Fatal(err)
	}
}

func TestURIAndQRCode(t *testing.T) {
	uri := URI("Kiro Proxy", "admin", rfcSecret)
	if !strings.HasPrefix(uri, "otpauth://totp/Kiro%20Proxy:admin?") || !strings.Contains(uri, "secret="+rfcSecret) || !strings.Contains(uri, "issuer=Kiro+Proxy") {
		t.Fatalf("uri %q", uri)
	}
	svg, err := QRSVG(uri)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(svg, "<svg") || !strings.Contains(svg, `fill="#000"`) || strings.Contains(svg, rfcSecret) {
		t.Fatalf("svg %.120s", svg)
	}
}
