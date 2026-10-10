package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

func newRemoteImageServer(t *testing.T, allowLoopback bool) (*httptest.Server, *int32) {
	t.Helper()
	png, _ := base64.StdEncoding.DecodeString(testPNGBase64)
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		switch r.URL.Path {
		case "/img.png":
			_, _ = w.Write(png)
		case "/page":
			_, _ = w.Write([]byte("<html>not an image</html>"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	if allowLoopback {
		old := remoteImageAddrAllowed
		remoteImageAddrAllowed = func(netip.Addr) bool { return true }
		t.Cleanup(func() { remoteImageAddrAllowed = old })
	}
	return srv, &hits
}

func TestPublicImageIP(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "::1", "169.254.169.254", "10.0.0.1", "192.168.1.1", "100.100.100.200", "::ffff:127.0.0.1", "0.0.0.0"} {
		if publicImageIP(netip.MustParseAddr(s)) {
			t.Errorf("non-public address allowed: %s", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		if !publicImageIP(netip.MustParseAddr(s)) {
			t.Errorf("public address denied: %s", s)
		}
	}
}

func TestInlineRemoteImagesRewritesImageBlocks(t *testing.T) {
	srv, _ := newRemoteImageServer(t, true)
	img := srv.URL + "/img.png"
	dataURL := "data:image/png;base64," + testPNGBase64

	claude := inlineRemoteImages(context.Background(), []byte(`{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"`+img+`"}},{"type":"text","text":"see `+img+`"}]}]}`))
	var claudeReq ClaudeRequest
	if err := json.Unmarshal(claude, &claudeReq); err != nil {
		t.Fatal(err)
	}
	cur := ClaudeToKiro(&claudeReq, false).ConversationState.CurrentMessage.UserInputMessage
	if len(cur.Images) != 1 || cur.Images[0].Source.Bytes != testPNGBase64 || cur.Content != "see "+img {
		t.Fatalf("claude images=%d content=%q", len(cur.Images), cur.Content)
	}

	openai := inlineRemoteImages(context.Background(), []byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"`+img+`","detail":"high"}}]}]}`))
	if !strings.Contains(string(openai), `"url":"`+dataURL+`"`) || !strings.Contains(string(openai), `"detail":"high"`) {
		t.Fatalf("openai body = %s", openai)
	}

	responses := inlineRemoteImages(context.Background(), []byte(`{"input":[{"role":"user","content":[{"type":"input_image","image_url":"`+img+`"}]}]}`))
	if !strings.Contains(string(responses), `"image_url":"`+dataURL+`"`) {
		t.Fatalf("responses body = %s", responses)
	}
}

func TestInlineRemoteImagesLeavesBodyAloneOnFailure(t *testing.T) {
	srv, hits := newRemoteImageServer(t, true)
	for _, body := range []string{
		`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"` + srv.URL + `/page"}}]}]}`,
		`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"` + srv.URL + `/missing"}}]}]}`,
		`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"ftp://example.com/a.png"}}]}]}`,
	} {
		if got := inlineRemoteImages(context.Background(), []byte(body)); string(got) != body {
			t.Fatalf("body changed after failed fetch: %s", got)
		}
	}
	if atomic.LoadInt32(hits) != 2 {
		t.Fatalf("hits = %d, want 2", atomic.LoadInt32(hits))
	}
}

func TestInlineRemoteImagesIgnoresNonImageURLs(t *testing.T) {
	srv, hits := newRemoteImageServer(t, true)
	img := srv.URL + "/img.png"
	body := `{"messages":[{"role":"user","content":"` + img + `"},{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"n","input":{"type":"image","url":"` + img + `"}}]}],"tools":[{"name":"n","input_schema":{"type":"image","url":"` + img + `"}}]}`
	if got := inlineRemoteImages(context.Background(), []byte(body)); string(got) != body || atomic.LoadInt32(hits) != 0 {
		t.Fatalf("hits=%d body=%s", atomic.LoadInt32(hits), got)
	}
}

func TestInlineRemoteImagesBlocksLoopbackByDefault(t *testing.T) {
	srv, hits := newRemoteImageServer(t, false)
	body := `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"` + srv.URL + `/img.png"}}]}]}`
	if got := inlineRemoteImages(context.Background(), []byte(body)); string(got) != body || atomic.LoadInt32(hits) != 0 {
		t.Fatalf("loopback image fetched: hits=%d", atomic.LoadInt32(hits))
	}
}

func TestOpenAIChatInlinesRemoteImageBeforeUpstream(t *testing.T) {
	imgSrv, _ := newRemoteImageServer(t, true)
	var images int
	h := newStreamTestHandler(t, func(w http.ResponseWriter, r *http.Request) {
		var payload KiroPayload
		_ = json.NewDecoder(r.Body).Decode(&payload)
		images = len(payload.ConversationState.CurrentMessage.UserInputMessage.Images)
		writeFrames(w, awsEventStreamFrame(t, "assistantResponseEvent", map[string]interface{}{"content": "OK"}), meteringFrame(t))
	})
	body := `{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":[{"type":"text","text":"what is this"},{"type":"image_url","image_url":{"url":"` + imgSrv.URL + `/img.png"}}]}]}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body)))
	if rec.Code != 200 || images != 1 {
		t.Fatalf("code=%d images=%d body=%s", rec.Code, images, rec.Body.String())
	}
}
