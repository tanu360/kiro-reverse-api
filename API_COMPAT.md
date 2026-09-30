# Kiro API compatibility repair — 2026-10-01

This service adapts Anthropic, Chat Completions and Responses requests to
Kiro's protocol. It is not the official Anthropic API.

## Deployment policy

Client text, image labels, history and generated output must not be shortened.
There is no local output-token limiter and no stop-sequence truncation.
Disabled prompt filters remain no-ops. The HTTP body limit is an explicit
rejection; it never changes an accepted request's content.

## Changes

- Invalid native model options are checked against Kiro's advertised schema
  before a generation request. A cold model cache still validates the verified
  Opus 5.5 schema. Wrong types, enums, native token bounds and unsupported
  structured-output settings return a local 400.
- A Kiro 400 carrying REQUEST_BODY_INVALID or Invalid
  additionalModelRequestFields is returned immediately. The same invalid body
  is not resent to the other two endpoints or another account. Such a request
  does not disable or cool down the account.
- Opus 5.5 sampling defaults are validated: temperature 1 and top_p >= 0.99
  are accepted for compatibility; other sampling settings are rejected.
  Manual/disabled thinking and forced tool choice are rejected for this model.
- Missing generation max_tokens and mismatched/duplicate tool IDs are rejected
  locally. Count-tokens remains an estimate and does not require max_tokens.
- The -thinking model suffix activates native reasoning controls and removes
  the proxy-generated legacy 200000-token thinking prompt.
- PDF blocks now become Kiro documents instead of incorrectly becoming images.
  A real one-page PDF with a unique code was recognized by the upstream.
- HTTP(S) image sources are fetched and encoded only as required by Kiro's
  inline-image protocol. Plain text URLs and tool arguments are untouched.
  The fetcher blocks private/metadata addresses, pins checked DNS addresses,
  checks redirects and image formats, and limits downloaded image sizes.
- Upstream thinking signatures are forwarded without inventing or replacing
  signatures. An actual reasoning response returned an 884-character signature.
  This is forwarding, not official cryptographic signature verification.
- Both request-id and x-request-id are returned for SDK request tracing.
  Top-level ephemeral cache_control becomes a Kiro cache point; the exact
  official cache TTL/accounting contract is not promised. service_tier=auto
  is accepted as the default behavior; paid tier selection remains unsupported.

## Upstream limitations — not disguised by gateway processing

Real tests reproduced ignored max_tokens both directly and via sub2api.
Kiro rejects native additional_model_request_fields.max_tokens below 1024 or
above 128000, but a valid native value of 1024 still produced 8178 output
tokens. Therefore max_tokens is not a reliable length or cost control here.
The gateway leaves complete output intact as requested. Responses expose
x-kiro-max-tokens-mode: upstream-not-enforced; no-local-truncation.

stop_sequences, strict output_config.format, mid-conversation system roles,
inference_geo, MCP server execution, paid service tiers, Files and Batches
remain unsupported. The gateway does not add a prompt to fake a capability.
The upstream Kiro identity/system instructions and hidden prompt token overhead
cannot be removed by this adapter. Local count_tokens estimates cannot serve
as exact upstream billing records. Thinking signatures are opaque and are
not verified using Anthropic's official verification rules. Model aliases may
still be normalized, and anthropic-version is still optional for legacy clients.

## Validation

614 tests/subtests passed; go vet passed. Real isolated requests verified
local rejection without upstream calls, native thinking, full output without
local truncation, PDF recognition, remote images, all three protocol adapters,
large inline images with accompanying text and labels, a one-million-character
message, document cache points and tool-result history.

Primary API references:

- https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
- https://platform.claude.com/docs/en/api/messages/create
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool

Later web-search tools add code-execution filtering. This adapter's existing
basic Kiro search is not a replacement for that official feature.
