package proxy

import (
	"errors"
	"io"
)

const maxRequestBodyBytes int64 = 32 << 20

var errRequestBodyTooLarge = errors.New("request body exceeds 32 MiB limit")
var errRequestBodyBusy = errors.New("request body processing busy; retry later")
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
