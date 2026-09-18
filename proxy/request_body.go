package proxy

import (
	"errors"
	"io"
	"strings"
)

const maxRequestBodyBytes int64 = 32 << 20

var errRequestBodyTooLarge = errors.New("request body exceeds 32 MiB limit")

// requestBodySlots bounds concurrent decompression: a few KB on the wire can
// expand to the full body limit in memory.
var requestBodySlots = make(chan struct{}, 8)

func readRequestBody(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxRequestBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxRequestBodyBytes {
		return nil, errRequestBodyTooLarge
	}
	return data, nil
}

func hasCompressionLayer(encodings []string) bool {
	for _, encoding := range encodings {
		switch strings.TrimSpace(encoding) {
		case "", "identity":
		default:
			return true
		}
	}
	return false
}
