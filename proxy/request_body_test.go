package proxy

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"github.com/klauspost/compress/zstd"
	"io"
	"net/http/httptest"
	"testing"
)

func encodeBody(t *testing.T, codec string, plain []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	switch codec {
	case "gzip", "x-gzip":
		w := gzip.NewWriter(&out)
		w.Write(plain)
		w.Close()
	case "deflate":
		w := zlib.NewWriter(&out)
		w.Write(plain)
		w.Close()
	case "zstd":
		w, err := zstd.NewWriter(&out)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(plain)
		w.Close()
	default:
		return plain
	}
	return out.Bytes()
}
func TestRequestBodyLimitsAcrossEncodings(t *testing.T) {
	for _, codec := range []string{"identity", "gzip", "x-gzip", "deflate", "zstd"} {
		t.Run(codec, func(t *testing.T) {
			plain := bytes.Repeat([]byte("x"), int(maxRequestBodyBytes)+1)
			body := encodeBody(t, codec, plain)
			req := httptest.NewRequest("POST", "/missing", bytes.NewReader(body))
			req.Header.Set("Content-Encoding", codec)
			rec := httptest.NewRecorder()
			(&Handler{}).ServeHTTP(rec, req)
			if rec.Code != 413 {
				t.Fatalf("oversized %s status=%d body=%s", codec, rec.Code, rec.Body.String())
			}
			req = httptest.NewRequest("POST", "/", bytes.NewReader(encodeBody(t, codec, []byte("hello"))))
			req.Header.Set("Content-Encoding", codec)
			if err := decompressRequestBody(req); err != nil {
				t.Fatal(err)
			}
			got, _ := io.ReadAll(req.Body)
			if string(got) != "hello" {
				t.Fatalf("got %q", got)
			}
		})
	}
}
func TestRequestBodyStackingAndMalformed(t *testing.T) {
	req := httptest.NewRequest("POST", "/", bytes.NewReader(encodeBody(t, "gzip", encodeBody(t, "deflate", []byte("hello")))))
	req.Header.Set("Content-Encoding", "deflate, GZip")
	if err := decompressRequestBody(req); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(req.Body)
	if string(got) != "hello" {
		t.Fatal("wrong stacking order")
	}
	for _, codec := range []string{"gzip", "deflate", "zstd", "br", "identity,identity,identity,identity"} {
		req = httptest.NewRequest("POST", "/", bytes.NewReader([]byte("invalid")))
		req.Header.Set("Content-Encoding", codec)
		if err := decompressRequestBody(req); err == nil {
			t.Fatalf("accepted %s", codec)
		}
	}
	member := encodeBody(t, "gzip", bytes.Repeat([]byte("x"), int(maxRequestBodyBytes)/2+1))
	req = httptest.NewRequest("POST", "/", bytes.NewReader(append(member, member...)))
	req.Header.Set("Content-Encoding", "gzip")
	if err := decompressRequestBody(req); !errors.Is(err, errRequestBodyTooLarge) {
		t.Fatalf("multi-member: %v", err)
	}
}
func TestRequestBodyExactLimit(t *testing.T) {
	req := httptest.NewRequest("POST", "/", io.LimitReader(zeroReader{}, maxRequestBodyBytes))
	if err := decompressRequestBody(req); err != nil {
		t.Fatal(err)
	}
	if req.ContentLength != maxRequestBodyBytes {
		t.Fatal("wrong length")
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestIdentityListsCannotBypassBodyLimit(t *testing.T) {
	for _, encoding := range []string{"identity, identity", ",", " , identity,"} {
		req := httptest.NewRequest("POST", "/missing", io.LimitReader(zeroReader{}, maxRequestBodyBytes+1))
		req.Header.Set("Content-Encoding", encoding)
		rec := httptest.NewRecorder()
		(&Handler{}).ServeHTTP(rec, req)
		if rec.Code != 413 {
			t.Fatalf("%q status=%d", encoding, rec.Code)
		}
	}
}
func TestBusyBodyReadersDoNotBlockBodylessRequests(t *testing.T) {
	for i := 0; i < cap(requestBodySlots); i++ {
		requestBodySlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < cap(requestBodySlots); i++ {
			<-requestBodySlots
		}
	}()
	rec := httptest.NewRecorder()
	(&Handler{}).ServeHTTP(rec, httptest.NewRequest("GET", "/missing", nil))
	if rec.Code != 404 {
		t.Fatalf("bodyless request blocked: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	(&Handler{}).ServeHTTP(rec, httptest.NewRequest("POST", "/missing", bytes.NewReader([]byte("body"))))
	if rec.Code != 503 {
		t.Fatalf("busy admission=%d", rec.Code)
	}
}
