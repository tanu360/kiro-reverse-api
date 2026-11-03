FROM --platform=$BUILDPLATFORM node:22-alpine AS ui
WORKDIR /app/ui
RUN corepack enable
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY ui/ ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
COPY --from=ui /app/ui/dist ./ui/dist
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o kiro-proxy .

FROM alpine:latest
RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /app/kiro-proxy .

EXPOSE 8080
ENV DATA_DIR=/app/state
VOLUME /app/state

CMD ["./kiro-proxy"]
