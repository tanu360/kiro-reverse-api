// RFC 6238 for the mock server (HMAC-SHA1, six digits, 30 s steps), the same as totp/totp.go,
// so a real authenticator app that scans the mock's QR code signs in to the mock UI.

/** The mock's fixed enrolment secret; the QR code below encodes it. */
export const MOCK_TOTP_SECRET = "MZXW6YTBOI4DGNJQGEZTSMBVGM2DONZY";
export const MOCK_TOTP_URI =
  "otpauth://totp/Kiro%20Proxy:Administrator?algorithm=SHA1&digits=6&issuer=Kiro+Proxy&period=30&secret=MZXW6YTBOI4DGNJQGEZTSMBVGM2DONZY";
/** totp.QRSVG(MOCK_TOTP_URI), made by the Go server's own code. */
export const MOCK_TOTP_QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 57 57" shape-rendering="crispEdges"><rect width="57" height="57" fill="#fff"/><path fill="#000" d="M4 4h7v1h-7zM16 4h1v1h-1zM19 4h1v1h-1zM22 4h1v1h-1zM25 4h5v1h-5zM33 4h1v1h-1zM37 4h3v1h-3zM41 4h1v1h-1zM44 4h1v1h-1zM46 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1zM12 5h1v1h-1zM14 5h1v1h-1zM16 5h1v1h-1zM18 5h2v1h-2zM21 5h1v1h-1zM23 5h1v1h-1zM25 5h5v1h-5zM32 5h2v1h-2zM36 5h2v1h-2zM40 5h1v1h-1zM42 5h3v1h-3zM46 5h1v1h-1zM52 5h1v1h-1zM4 6h1v1h-1zM6 6h3v1h-3zM10 6h1v1h-1zM13 6h2v1h-2zM16 6h1v1h-1zM19 6h2v1h-2zM22 6h1v1h-1zM24 6h3v1h-3zM28 6h1v1h-1zM31 6h2v1h-2zM34 6h2v1h-2zM39 6h1v1h-1zM43 6h2v1h-2zM46 6h1v1h-1zM48 6h3v1h-3zM52 6h1v1h-1zM4 7h1v1h-1zM6 7h3v1h-3zM10 7h1v1h-1zM13 7h1v1h-1zM17 7h1v1h-1zM19 7h1v1h-1zM23 7h1v1h-1zM28 7h3v1h-3zM33 7h1v1h-1zM38 7h2v1h-2zM43 7h1v1h-1zM46 7h1v1h-1zM48 7h3v1h-3zM52 7h1v1h-1zM4 8h1v1h-1zM6 8h3v1h-3zM10 8h1v1h-1zM12 8h1v1h-1zM15 8h1v1h-1zM17 8h2v1h-2zM21 8h1v1h-1zM23 8h1v1h-1zM26 8h5v1h-5zM33 8h3v1h-3zM37 8h5v1h-5zM46 8h1v1h-1zM48 8h3v1h-3zM52 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM15 9h1v1h-1zM18 9h1v1h-1zM23 9h2v1h-2zM26 9h1v1h-1zM30 9h3v1h-3zM35 9h1v1h-1zM37 9h2v1h-2zM40 9h1v1h-1zM42 9h1v1h-1zM46 9h1v1h-1zM52 9h1v1h-1zM4 10h7v1h-7zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h1v1h-1zM32 10h1v1h-1zM34 10h1v1h-1zM36 10h1v1h-1zM38 10h1v1h-1zM40 10h1v1h-1zM42 10h1v1h-1zM44 10h1v1h-1zM46 10h7v1h-7zM15 11h1v1h-1zM18 11h1v1h-1zM21 11h2v1h-2zM24 11h1v1h-1zM26 11h1v1h-1zM30 11h3v1h-3zM35 11h5v1h-5zM41 11h2v1h-2zM44 11h1v1h-1zM4 12h1v1h-1zM6 12h1v1h-1zM8 12h1v1h-1zM10 12h1v1h-1zM13 12h2v1h-2zM16 12h3v1h-3zM20 12h2v1h-2zM24 12h1v1h-1zM26 12h5v1h-5zM32 12h2v1h-2zM35 12h2v1h-2zM38 12h7v1h-7zM48 12h1v1h-1zM51 12h1v1h-1zM5 13h1v1h-1zM8 13h1v1h-1zM11 13h1v1h-1zM13 13h1v1h-1zM18 13h3v1h-3zM22 13h1v1h-1zM27 13h2v1h-2zM31 13h2v1h-2zM40 13h1v1h-1zM47 13h2v1h-2zM50 13h3v1h-3zM4 14h1v1h-1zM7 14h1v1h-1zM10 14h1v1h-1zM12 14h6v1h-6zM19 14h3v1h-3zM24 14h1v1h-1zM26 14h2v1h-2zM30 14h3v1h-3zM38 14h1v1h-1zM40 14h2v1h-2zM45 14h2v1h-2zM49 14h1v1h-1zM51 14h2v1h-2zM6 15h1v1h-1zM14 15h2v1h-2zM17 15h1v1h-1zM32 15h2v1h-2zM36 15h2v1h-2zM39 15h1v1h-1zM43 15h1v1h-1zM48 15h2v1h-2zM51 15h1v1h-1zM4 16h2v1h-2zM7 16h2v1h-2zM10 16h1v1h-1zM14 16h3v1h-3zM18 16h1v1h-1zM23 16h2v1h-2zM26 16h3v1h-3zM32 16h1v1h-1zM36 16h2v1h-2zM39 16h4v1h-4zM46 16h3v1h-3zM51 16h2v1h-2zM7 17h2v1h-2zM12 17h3v1h-3zM16 17h1v1h-1zM18 17h3v1h-3zM23 17h1v1h-1zM25 17h1v1h-1zM35 17h3v1h-3zM40 17h1v1h-1zM48 17h3v1h-3zM52 17h1v1h-1zM4 18h1v1h-1zM6 18h6v1h-6zM14 18h1v1h-1zM20 18h2v1h-2zM23 18h4v1h-4zM36 18h2v1h-2zM39 18h1v1h-1zM41 18h1v1h-1zM44 18h1v1h-1zM47 18h1v1h-1zM51 18h2v1h-2zM4 19h1v1h-1zM6 19h1v1h-1zM8 19h2v1h-2zM11 19h3v1h-3zM15 19h1v1h-1zM17 19h3v1h-3zM22 19h2v1h-2zM25 19h1v1h-1zM28 19h3v1h-3zM33 19h1v1h-1zM38 19h2v1h-2zM43 19h1v1h-1zM46 19h3v1h-3zM52 19h1v1h-1zM6 20h1v1h-1zM10 20h2v1h-2zM15 20h1v1h-1zM18 20h1v1h-1zM21 20h1v1h-1zM24 20h5v1h-5zM30 20h1v1h-1zM32 20h3v1h-3zM36 20h1v1h-1zM39 20h2v1h-2zM46 20h6v1h-6zM5 21h2v1h-2zM8 21h2v1h-2zM11 21h2v1h-2zM15 21h4v1h-4zM20 21h2v1h-2zM26 21h1v1h-1zM28 21h1v1h-1zM33 21h1v1h-1zM39 21h1v1h-1zM51 21h1v1h-1zM6 22h1v1h-1zM10 22h2v1h-2zM13 22h5v1h-5zM19 22h1v1h-1zM21 22h2v1h-2zM24 22h1v1h-1zM28 22h3v1h-3zM32 22h3v1h-3zM36 22h5v1h-5zM42 22h1v1h-1zM48 22h1v1h-1zM50 22h3v1h-3zM6 23h3v1h-3zM13 23h1v1h-1zM17 23h1v1h-1zM19 23h3v1h-3zM27 23h3v1h-3zM33 23h1v1h-1zM35 23h4v1h-4zM40 23h1v1h-1zM43 23h1v1h-1zM45 23h2v1h-2zM48 23h1v1h-1zM51 23h2v1h-2zM4 24h2v1h-2zM8 24h4v1h-4zM14 24h1v1h-1zM17 24h1v1h-1zM27 24h6v1h-6zM34 24h5v1h-5zM40 24h1v1h-1zM42 24h1v1h-1zM46 24h4v1h-4zM51 24h1v1h-1zM7 25h1v1h-1zM12 25h2v1h-2zM16 25h1v1h-1zM19 25h1v1h-1zM21 25h2v1h-2zM29 25h1v1h-1zM39 25h1v1h-1zM43 25h1v1h-1zM50 25h3v1h-3zM5 26h1v1h-1zM8 26h5v1h-5zM18 26h2v1h-2zM23 26h1v1h-1zM26 26h6v1h-6zM33 26h1v1h-1zM35 26h3v1h-3zM39 26h2v1h-2zM43 26h7v1h-7zM51 26h2v1h-2zM4 27h1v1h-1zM6 27h1v1h-1zM8 27h1v1h-1zM12 27h1v1h-1zM15 27h1v1h-1zM17 27h2v1h-2zM20 27h1v1h-1zM22 27h3v1h-3zM26 27h1v1h-1zM30 27h1v1h-1zM32 27h6v1h-6zM44 27h1v1h-1zM48 27h1v1h-1zM51 27h2v1h-2zM4 28h1v1h-1zM8 28h1v1h-1zM10 28h1v1h-1zM12 28h1v1h-1zM16 28h4v1h-4zM21 28h3v1h-3zM26 28h1v1h-1zM28 28h1v1h-1zM30 28h1v1h-1zM32 28h9v1h-9zM42 28h3v1h-3zM46 28h1v1h-1zM48 28h2v1h-2zM52 28h1v1h-1zM4 29h5v1h-5zM12 29h1v1h-1zM15 29h1v1h-1zM18 29h2v1h-2zM22 29h1v1h-1zM26 29h1v1h-1zM30 29h1v1h-1zM35 29h1v1h-1zM37 29h1v1h-1zM44 29h1v1h-1zM48 29h3v1h-3zM52 29h1v1h-1zM7 30h6v1h-6zM15 30h2v1h-2zM19 30h1v1h-1zM21 30h1v1h-1zM24 30h8v1h-8zM33 30h1v1h-1zM35 30h3v1h-3zM39 30h1v1h-1zM44 30h6v1h-6zM51 30h2v1h-2zM5 31h3v1h-3zM12 31h2v1h-2zM15 31h1v1h-1zM17 31h3v1h-3zM21 31h1v1h-1zM25 31h2v1h-2zM28 31h1v1h-1zM32 31h1v1h-1zM36 31h2v1h-2zM39 31h3v1h-3zM43 31h2v1h-2zM46 31h1v1h-1zM5 32h1v1h-1zM7 32h6v1h-6zM14 32h3v1h-3zM18 32h2v1h-2zM22 32h1v1h-1zM24 32h5v1h-5zM30 32h5v1h-5zM36 32h1v1h-1zM38 32h1v1h-1zM40 32h1v1h-1zM45 32h6v1h-6zM52 32h1v1h-1zM4 33h2v1h-2zM7 33h3v1h-3zM12 33h1v1h-1zM14 33h1v1h-1zM16 33h3v1h-3zM20 33h2v1h-2zM24 33h2v1h-2zM27 33h1v1h-1zM31 33h1v1h-1zM37 33h1v1h-1zM39 33h1v1h-1zM43 33h3v1h-3zM49 33h1v1h-1zM51 33h2v1h-2zM6 34h1v1h-1zM8 34h5v1h-5zM18 34h1v1h-1zM20 34h1v1h-1zM27 34h4v1h-4zM33 34h1v1h-1zM35 34h2v1h-2zM40 34h1v1h-1zM43 34h1v1h-1zM45 34h8v1h-8zM4 35h1v1h-1zM6 35h3v1h-3zM11 35h1v1h-1zM14 35h1v1h-1zM17 35h1v1h-1zM19 35h1v1h-1zM22 35h1v1h-1zM24 35h1v1h-1zM27 35h1v1h-1zM29 35h3v1h-3zM34 35h2v1h-2zM37 35h3v1h-3zM44 35h1v1h-1zM9 36h3v1h-3zM13 36h3v1h-3zM17 36h2v1h-2zM21 36h3v1h-3zM25 36h1v1h-1zM27 36h2v1h-2zM31 36h1v1h-1zM35 36h1v1h-1zM39 36h3v1h-3zM44 36h1v1h-1zM50 36h3v1h-3zM5 37h1v1h-1zM7 37h1v1h-1zM12 37h1v1h-1zM14 37h2v1h-2zM17 37h1v1h-1zM19 37h1v1h-1zM23 37h1v1h-1zM31 37h2v1h-2zM34 37h3v1h-3zM39 37h2v1h-2zM44 37h2v1h-2zM49 37h1v1h-1zM51 37h1v1h-1zM5 38h1v1h-1zM7 38h2v1h-2zM10 38h3v1h-3zM14 38h1v1h-1zM19 38h1v1h-1zM21 38h1v1h-1zM23 38h2v1h-2zM29 38h3v1h-3zM34 38h2v1h-2zM37 38h2v1h-2zM40 38h1v1h-1zM42 38h1v1h-1zM46 38h1v1h-1zM50 38h3v1h-3zM4 39h1v1h-1zM7 39h3v1h-3zM12 39h2v1h-2zM18 39h4v1h-4zM23 39h2v1h-2zM30 39h2v1h-2zM33 39h1v1h-1zM35 39h3v1h-3zM39 39h2v1h-2zM42 39h1v1h-1zM44 39h1v1h-1zM46 39h2v1h-2zM52 39h1v1h-1zM5 40h4v1h-4zM10 40h1v1h-1zM12 40h2v1h-2zM15 40h1v1h-1zM18 40h1v1h-1zM21 40h1v1h-1zM24 40h1v1h-1zM26 40h2v1h-2zM29 40h4v1h-4zM35 40h2v1h-2zM39 40h3v1h-3zM45 40h2v1h-2zM51 40h2v1h-2zM4 41h2v1h-2zM7 41h1v1h-1zM9 41h1v1h-1zM11 41h1v1h-1zM14 41h1v1h-1zM16 41h2v1h-2zM21 41h2v1h-2zM25 41h2v1h-2zM30 41h1v1h-1zM36 41h1v1h-1zM40 41h1v1h-1zM44 41h1v1h-1zM46 41h1v1h-1zM49 41h1v1h-1zM52 41h1v1h-1zM5 42h1v1h-1zM9 42h2v1h-2zM13 42h1v1h-1zM17 42h4v1h-4zM22 42h4v1h-4zM27 42h1v1h-1zM30 42h2v1h-2zM36 42h1v1h-1zM39 42h1v1h-1zM41 42h1v1h-1zM43 42h5v1h-5zM51 42h2v1h-2zM5 43h3v1h-3zM13 43h2v1h-2zM16 43h3v1h-3zM20 43h3v1h-3zM24 43h4v1h-4zM30 43h1v1h-1zM32 43h1v1h-1zM35 43h3v1h-3zM40 43h3v1h-3zM45 43h2v1h-2zM48 43h2v1h-2zM4 44h3v1h-3zM10 44h1v1h-1zM12 44h2v1h-2zM15 44h1v1h-1zM17 44h5v1h-5zM23 44h1v1h-1zM26 44h5v1h-5zM32 44h1v1h-1zM34 44h5v1h-5zM40 44h1v1h-1zM42 44h1v1h-1zM44 44h6v1h-6zM12 45h6v1h-6zM21 45h1v1h-1zM26 45h1v1h-1zM30 45h1v1h-1zM32 45h1v1h-1zM35 45h3v1h-3zM43 45h2v1h-2zM48 45h2v1h-2zM51 45h2v1h-2zM4 46h7v1h-7zM15 46h2v1h-2zM18 46h1v1h-1zM23 46h1v1h-1zM26 46h1v1h-1zM28 46h1v1h-1zM30 46h1v1h-1zM32 46h2v1h-2zM35 46h2v1h-2zM39 46h1v1h-1zM43 46h2v1h-2zM46 46h1v1h-1zM48 46h1v1h-1zM50 46h3v1h-3zM4 47h1v1h-1zM10 47h1v1h-1zM13 47h2v1h-2zM18 47h1v1h-1zM20 47h4v1h-4zM25 47h2v1h-2zM30 47h1v1h-1zM32 47h1v1h-1zM35 47h2v1h-2zM40 47h5v1h-5zM48 47h1v1h-1zM51 47h2v1h-2zM4 48h1v1h-1zM6 48h3v1h-3zM10 48h1v1h-1zM12 48h1v1h-1zM14 48h1v1h-1zM17 48h1v1h-1zM19 48h1v1h-1zM23 48h2v1h-2zM26 48h7v1h-7zM34 48h1v1h-1zM36 48h1v1h-1zM39 48h11v1h-11zM52 48h1v1h-1zM4 49h1v1h-1zM6 49h3v1h-3zM10 49h1v1h-1zM13 49h1v1h-1zM15 49h5v1h-5zM21 49h1v1h-1zM23 49h1v1h-1zM26 49h3v1h-3zM30 49h1v1h-1zM32 49h2v1h-2zM36 49h1v1h-1zM39 49h1v1h-1zM43 49h1v1h-1zM45 49h2v1h-2zM48 49h1v1h-1zM51 49h1v1h-1zM4 50h1v1h-1zM6 50h3v1h-3zM10 50h1v1h-1zM12 50h2v1h-2zM21 50h1v1h-1zM23 50h3v1h-3zM27 50h2v1h-2zM31 50h1v1h-1zM33 50h1v1h-1zM35 50h1v1h-1zM37 50h1v1h-1zM39 50h2v1h-2zM43 50h7v1h-7zM4 51h1v1h-1zM10 51h1v1h-1zM13 51h1v1h-1zM17 51h1v1h-1zM19 51h1v1h-1zM21 51h1v1h-1zM23 51h1v1h-1zM26 51h2v1h-2zM30 51h1v1h-1zM33 51h1v1h-1zM35 51h1v1h-1zM37 51h2v1h-2zM40 51h1v1h-1zM42 51h1v1h-1zM44 51h2v1h-2zM51 51h1v1h-1zM4 52h7v1h-7zM12 52h3v1h-3zM17 52h2v1h-2zM20 52h1v1h-1zM22 52h1v1h-1zM24 52h5v1h-5zM30 52h1v1h-1zM32 52h3v1h-3zM36 52h3v1h-3zM40 52h3v1h-3zM44 52h1v1h-1zM48 52h1v1h-1zM50 52h3v1h-3z"/></svg>';

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret: string): Uint8Array<ArrayBuffer> {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 30_000);
}

/** The code for one step. */
export async function totpCodeAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(step / 2 ** 32));
  counter.setUint32(4, step >>> 0);
  const sum = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const offset = sum[sum.length - 1] & 0x0f;
  const value =
    ((sum[offset] & 0x7f) << 24) |
    (sum[offset + 1] << 16) |
    (sum[offset + 2] << 8) |
    sum[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

/** The step a code was made for within one step of now, or null; totp.Match. */
export async function totpMatch(
  secret: string,
  code: string,
  nowMs = Date.now(),
): Promise<number | null> {
  const digits = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(nowMs);
  for (const delta of [-1, 0, 1]) {
    if ((await totpCodeAt(secret, current + delta)) === digits) return current + delta;
  }
  return null;
}
