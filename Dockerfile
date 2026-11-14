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

# The public-link helper (helper/kiro-tunnel) is its own module on the newer Go that Tailscale
# needs. The image carries it, so the switch works without a download inside the container.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS tunnel

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY helper/kiro-tunnel/go.mod helper/kiro-tunnel/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY helper/kiro-tunnel/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/kiro-tunnel .

FROM alpine:latest
RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /app/kiro-proxy .
COPY --from=tunnel /out/kiro-tunnel .

EXPOSE 8080
ENV DATA_DIR=/app/state
# Inside a container the port mapping decides who can connect, so listen on every interface.
ENV LISTEN_HOST=0.0.0.0
VOLUME /app/state
# The public link runs this helper; its Tailscale sign-in lives in /app/state/tailscale.
ENV KIRO_TUNNEL_BIN=/app/kiro-tunnel

CMD ["./kiro-proxy"]
