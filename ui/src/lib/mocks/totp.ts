// RFC 6238 for the mock server (HMAC-SHA1, six digits, 30 s steps), the same as totp/totp.go,
// so a real authenticator app that scans the mock's QR code signs in to the mock UI.

/** The mock's fixed enrolment secret; the QR code below encodes it. */
export const MOCK_TOTP_SECRET = "MZXW6YTBOI4DGNJQGEZTSMBVGM2DONZY";
export const MOCK_TOTP_URI =
  "otpauth://totp/Kiro%20Proxy:admin?algorithm=SHA1&digits=6&issuer=Kiro+Proxy&period=30&secret=MZXW6YTBOI4DGNJQGEZTSMBVGM2DONZY";
/** totp.QRSVG(MOCK_TOTP_URI), made by the Go server's own code. */
export const MOCK_TOTP_QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 57 57" shape-rendering="crispEdges"><rect width="57" height="57" fill="#fff"/><path fill="#000" d="M4 4h7v1h-7zM13 4h1v1h-1zM15 4h1v1h-1zM17 4h2v1h-2zM21 4h2v1h-2zM25 4h5v1h-5zM33 4h1v1h-1zM37 4h1v1h-1zM41 4h1v1h-1zM44 4h1v1h-1zM46 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1zM12 5h2v1h-2zM17 5h2v1h-2zM20 5h1v1h-1zM22 5h2v1h-2zM25 5h5v1h-5zM32 5h2v1h-2zM36 5h2v1h-2zM40 5h1v1h-1zM42 5h3v1h-3zM46 5h1v1h-1zM52 5h1v1h-1zM4 6h1v1h-1zM6 6h3v1h-3zM10 6h1v1h-1zM14 6h3v1h-3zM19 6h1v1h-1zM22 6h3v1h-3zM28 6h1v1h-1zM31 6h1v1h-1zM34 6h2v1h-2zM39 6h1v1h-1zM43 6h2v1h-2zM46 6h1v1h-1zM48 6h3v1h-3zM52 6h1v1h-1zM4 7h1v1h-1zM6 7h3v1h-3zM10 7h1v1h-1zM14 7h1v1h-1zM20 7h4v1h-4zM26 7h1v1h-1zM28 7h4v1h-4zM33 7h1v1h-1zM35 7h1v1h-1zM38 7h1v1h-1zM43 7h1v1h-1zM46 7h1v1h-1zM48 7h3v1h-3zM52 7h1v1h-1zM4 8h1v1h-1zM6 8h3v1h-3zM10 8h1v1h-1zM12 8h2v1h-2zM17 8h1v1h-1zM21 8h3v1h-3zM26 8h10v1h-10zM37 8h5v1h-5zM46 8h1v1h-1zM48 8h3v1h-3zM52 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM17 9h3v1h-3zM22 9h3v1h-3zM26 9h1v1h-1zM30 9h3v1h-3zM37 9h2v1h-2zM42 9h1v1h-1zM46 9h1v1h-1zM52 9h1v1h-1zM4 10h7v1h-7zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h1v1h-1zM32 10h1v1h-1zM34 10h1v1h-1zM36 10h1v1h-1zM38 10h1v1h-1zM40 10h1v1h-1zM42 10h1v1h-1zM44 10h1v1h-1zM46 10h7v1h-7zM14 11h1v1h-1zM16 11h2v1h-2zM21 11h1v1h-1zM24 11h3v1h-3zM30 11h2v1h-2zM33 11h1v1h-1zM36 11h1v1h-1zM40 11h2v1h-2zM44 11h1v1h-1zM4 12h1v1h-1zM6 12h1v1h-1zM8 12h1v1h-1zM10 12h1v1h-1zM14 12h1v1h-1zM16 12h1v1h-1zM19 12h1v1h-1zM23 12h11v1h-11zM35 12h2v1h-2zM38 12h7v1h-7zM48 12h1v1h-1zM51 12h1v1h-1zM6 13h1v1h-1zM9 13h1v1h-1zM13 13h1v1h-1zM15 13h1v1h-1zM19 13h1v1h-1zM25 13h4v1h-4zM41 13h1v1h-1zM47 13h3v1h-3zM51 13h2v1h-2zM4 14h3v1h-3zM8 14h1v1h-1zM10 14h1v1h-1zM13 14h2v1h-2zM16 14h2v1h-2zM19 14h4v1h-4zM24 14h1v1h-1zM27 14h1v1h-1zM31 14h1v1h-1zM33 14h1v1h-1zM37 14h1v1h-1zM46 14h1v1h-1zM48 14h1v1h-1zM50 14h3v1h-3zM4 15h2v1h-2zM7 15h1v1h-1zM11 15h2v1h-2zM17 15h1v1h-1zM22 15h1v1h-1zM27 15h1v1h-1zM29 15h2v1h-2zM32 15h1v1h-1zM36 15h1v1h-1zM39 15h1v1h-1zM43 15h2v1h-2zM47 15h2v1h-2zM51 15h2v1h-2zM5 16h7v1h-7zM15 16h1v1h-1zM17 16h5v1h-5zM23 16h7v1h-7zM32 16h1v1h-1zM36 16h1v1h-1zM38 16h3v1h-3zM46 16h3v1h-3zM52 16h1v1h-1zM5 17h3v1h-3zM11 17h1v1h-1zM14 17h2v1h-2zM17 17h1v1h-1zM22 17h2v1h-2zM25 17h1v1h-1zM27 17h2v1h-2zM35 17h3v1h-3zM40 17h1v1h-1zM43 17h1v1h-1zM48 17h2v1h-2zM52 17h1v1h-1zM4 18h1v1h-1zM7 18h5v1h-5zM14 18h1v1h-1zM16 18h1v1h-1zM20 18h1v1h-1zM23 18h5v1h-5zM33 18h2v1h-2zM36 18h2v1h-2zM39 18h1v1h-1zM41 18h1v1h-1zM44 18h1v1h-1zM47 18h1v1h-1zM51 18h2v1h-2zM5 19h1v1h-1zM8 19h1v1h-1zM11 19h2v1h-2zM14 19h1v1h-1zM16 19h2v1h-2zM19 19h1v1h-1zM23 19h1v1h-1zM25 19h1v1h-1zM27 19h2v1h-2zM33 19h1v1h-1zM37 19h1v1h-1zM41 19h3v1h-3zM46 19h1v1h-1zM48 19h1v1h-1zM52 19h1v1h-1zM4 20h2v1h-2zM7 20h1v1h-1zM10 20h1v1h-1zM13 20h1v1h-1zM19 20h3v1h-3zM23 20h4v1h-4zM28 20h1v1h-1zM30 20h1v1h-1zM32 20h3v1h-3zM36 20h3v1h-3zM40 20h4v1h-4zM45 20h2v1h-2zM48 20h4v1h-4zM5 21h4v1h-4zM12 21h2v1h-2zM15 21h2v1h-2zM22 21h1v1h-1zM26 21h1v1h-1zM28 21h1v1h-1zM33 21h1v1h-1zM37 21h1v1h-1zM41 21h1v1h-1zM43 21h1v1h-1zM51 21h1v1h-1zM4 22h2v1h-2zM8 22h1v1h-1zM10 22h1v1h-1zM12 22h3v1h-3zM16 22h2v1h-2zM20 22h3v1h-3zM27 22h1v1h-1zM30 22h1v1h-1zM32 22h3v1h-3zM36 22h3v1h-3zM40 22h1v1h-1zM42 22h6v1h-6zM50 22h3v1h-3zM5 23h1v1h-1zM11 23h1v1h-1zM13 23h1v1h-1zM15 23h4v1h-4zM20 23h2v1h-2zM23 23h3v1h-3zM27 23h3v1h-3zM31 23h1v1h-1zM33 23h1v1h-1zM37 23h4v1h-4zM43 23h1v1h-1zM48 23h1v1h-1zM9 24h2v1h-2zM12 24h1v1h-1zM15 24h2v1h-2zM20 24h4v1h-4zM25 24h1v1h-1zM27 24h6v1h-6zM34 24h7v1h-7zM42 24h1v1h-1zM46 24h4v1h-4zM51 24h1v1h-1zM5 25h1v1h-1zM7 25h1v1h-1zM9 25h1v1h-1zM11 25h5v1h-5zM18 25h2v1h-2zM21 25h2v1h-2zM25 25h1v1h-1zM29 25h1v1h-1zM32 25h1v1h-1zM35 25h1v1h-1zM39 25h2v1h-2zM43 25h1v1h-1zM45 25h1v1h-1zM49 25h2v1h-2zM52 25h1v1h-1zM5 26h1v1h-1zM7 26h6v1h-6zM14 26h1v1h-1zM17 26h2v1h-2zM20 26h1v1h-1zM24 26h1v1h-1zM26 26h6v1h-6zM33 26h1v1h-1zM37 26h1v1h-1zM40 26h1v1h-1zM43 26h10v1h-10zM6 27h3v1h-3zM12 27h3v1h-3zM16 27h3v1h-3zM21 27h6v1h-6zM30 27h1v1h-1zM32 27h2v1h-2zM35 27h3v1h-3zM39 27h2v1h-2zM44 27h1v1h-1zM48 27h1v1h-1zM51 27h2v1h-2zM5 28h1v1h-1zM7 28h2v1h-2zM10 28h1v1h-1zM12 28h2v1h-2zM15 28h2v1h-2zM18 28h3v1h-3zM26 28h1v1h-1zM28 28h1v1h-1zM30 28h1v1h-1zM32 28h2v1h-2zM35 28h3v1h-3zM39 28h2v1h-2zM43 28h2v1h-2zM46 28h1v1h-1zM48 28h2v1h-2zM51 28h2v1h-2zM4 29h1v1h-1zM8 29h1v1h-1zM12 29h1v1h-1zM14 29h1v1h-1zM19 29h2v1h-2zM26 29h1v1h-1zM30 29h3v1h-3zM35 29h3v1h-3zM40 29h1v1h-1zM44 29h1v1h-1zM48 29h1v1h-1zM52 29h1v1h-1zM4 30h9v1h-9zM14 30h1v1h-1zM16 30h3v1h-3zM22 30h1v1h-1zM24 30h7v1h-7zM32 30h2v1h-2zM35 30h3v1h-3zM39 30h2v1h-2zM43 30h10v1h-10zM6 31h3v1h-3zM12 31h4v1h-4zM17 31h1v1h-1zM20 31h3v1h-3zM24 31h3v1h-3zM28 31h1v1h-1zM32 31h3v1h-3zM36 31h1v1h-1zM38 31h4v1h-4zM43 31h2v1h-2zM46 31h1v1h-1zM52 31h1v1h-1zM4 32h1v1h-1zM8 32h1v1h-1zM10 32h2v1h-2zM15 32h4v1h-4zM21 32h2v1h-2zM24 32h1v1h-1zM26 32h3v1h-3zM30 32h5v1h-5zM36 32h3v1h-3zM40 32h2v1h-2zM44 32h4v1h-4zM49 32h1v1h-1zM51 32h1v1h-1zM4 33h2v1h-2zM8 33h2v1h-2zM14 33h1v1h-1zM17 33h5v1h-5zM24 33h4v1h-4zM31 33h1v1h-1zM39 33h1v1h-1zM44 33h2v1h-2zM47 33h1v1h-1zM51 33h2v1h-2zM9 34h2v1h-2zM12 34h2v1h-2zM15 34h4v1h-4zM20 34h1v1h-1zM27 34h4v1h-4zM33 34h4v1h-4zM38 34h1v1h-1zM40 34h1v1h-1zM43 34h1v1h-1zM45 34h4v1h-4zM51 34h2v1h-2zM5 35h1v1h-1zM12 35h2v1h-2zM15 35h1v1h-1zM17 35h2v1h-2zM22 35h1v1h-1zM24 35h1v1h-1zM27 35h1v1h-1zM29 35h3v1h-3zM34 35h2v1h-2zM38 35h2v1h-2zM42 35h1v1h-1zM45 35h1v1h-1zM48 35h1v1h-1zM4 36h2v1h-2zM10 36h1v1h-1zM13 36h1v1h-1zM15 36h2v1h-2zM18 36h1v1h-1zM21 36h1v1h-1zM23 36h3v1h-3zM28 36h1v1h-1zM31 36h1v1h-1zM35 36h1v1h-1zM39 36h1v1h-1zM50 36h2v1h-2zM8 37h2v1h-2zM12 37h1v1h-1zM14 37h2v1h-2zM20 37h1v1h-1zM22 37h1v1h-1zM31 37h2v1h-2zM34 37h3v1h-3zM38 37h3v1h-3zM42 37h1v1h-1zM45 37h1v1h-1zM49 37h1v1h-1zM51 37h1v1h-1zM7 38h2v1h-2zM10 38h3v1h-3zM14 38h1v1h-1zM16 38h1v1h-1zM20 38h1v1h-1zM23 38h2v1h-2zM27 38h1v1h-1zM29 38h3v1h-3zM34 38h2v1h-2zM38 38h2v1h-2zM42 38h1v1h-1zM44 38h1v1h-1zM46 38h3v1h-3zM50 38h3v1h-3zM4 39h1v1h-1zM6 39h4v1h-4zM11 39h2v1h-2zM16 39h3v1h-3zM22 39h1v1h-1zM30 39h2v1h-2zM33 39h1v1h-1zM37 39h1v1h-1zM40 39h1v1h-1zM42 39h3v1h-3zM46 39h3v1h-3zM52 39h1v1h-1zM4 40h1v1h-1zM8 40h1v1h-1zM10 40h2v1h-2zM13 40h1v1h-1zM18 40h2v1h-2zM23 40h1v1h-1zM25 40h1v1h-1zM29 40h4v1h-4zM35 40h2v1h-2zM39 40h3v1h-3zM44 40h1v1h-1zM46 40h1v1h-1zM52 40h1v1h-1zM6 41h1v1h-1zM9 41h1v1h-1zM11 41h4v1h-4zM16 41h3v1h-3zM20 41h2v1h-2zM25 41h2v1h-2zM29 41h1v1h-1zM31 41h2v1h-2zM35 41h2v1h-2zM40 41h1v1h-1zM43 41h1v1h-1zM46 41h1v1h-1zM51 41h2v1h-2zM5 42h1v1h-1zM9 42h2v1h-2zM12 42h3v1h-3zM19 42h1v1h-1zM21 42h3v1h-3zM25 42h1v1h-1zM29 42h2v1h-2zM32 42h1v1h-1zM40 42h2v1h-2zM43 42h4v1h-4zM48 42h1v1h-1zM50 42h1v1h-1zM52 42h1v1h-1zM5 43h3v1h-3zM11 43h1v1h-1zM18 43h1v1h-1zM22 43h1v1h-1zM24 43h2v1h-2zM27 43h1v1h-1zM29 43h1v1h-1zM32 43h1v1h-1zM35 43h2v1h-2zM38 43h3v1h-3zM45 43h1v1h-1zM47 43h2v1h-2zM4 44h3v1h-3zM10 44h4v1h-4zM20 44h3v1h-3zM26 44h9v1h-9zM36 44h5v1h-5zM42 44h1v1h-1zM44 44h5v1h-5zM12 45h3v1h-3zM16 45h3v1h-3zM20 45h1v1h-1zM26 45h1v1h-1zM30 45h1v1h-1zM35 45h3v1h-3zM43 45h2v1h-2zM48 45h2v1h-2zM51 45h2v1h-2zM4 46h7v1h-7zM16 46h2v1h-2zM19 46h1v1h-1zM22 46h3v1h-3zM26 46h1v1h-1zM28 46h1v1h-1zM30 46h3v1h-3zM35 46h3v1h-3zM43 46h2v1h-2zM46 46h1v1h-1zM48 46h1v1h-1zM51 46h2v1h-2zM4 47h1v1h-1zM10 47h1v1h-1zM13 47h1v1h-1zM15 47h1v1h-1zM17 47h2v1h-2zM20 47h4v1h-4zM25 47h2v1h-2zM30 47h1v1h-1zM32 47h1v1h-1zM35 47h2v1h-2zM38 47h1v1h-1zM40 47h1v1h-1zM43 47h2v1h-2zM48 47h1v1h-1zM52 47h1v1h-1zM4 48h1v1h-1zM6 48h3v1h-3zM10 48h1v1h-1zM12 48h2v1h-2zM15 48h6v1h-6zM22 48h11v1h-11zM34 48h1v1h-1zM36 48h13v1h-13zM51 48h2v1h-2zM4 49h1v1h-1zM6 49h3v1h-3zM10 49h1v1h-1zM14 49h1v1h-1zM17 49h1v1h-1zM19 49h1v1h-1zM22 49h2v1h-2zM25 49h4v1h-4zM30 49h1v1h-1zM32 49h1v1h-1zM36 49h1v1h-1zM39 49h1v1h-1zM43 49h1v1h-1zM46 49h1v1h-1zM48 49h1v1h-1zM52 49h1v1h-1zM4 50h1v1h-1zM6 50h3v1h-3zM10 50h1v1h-1zM12 50h1v1h-1zM15 50h4v1h-4zM21 50h8v1h-8zM31 50h1v1h-1zM34 50h2v1h-2zM37 50h4v1h-4zM43 50h7v1h-7zM51 50h2v1h-2zM4 51h1v1h-1zM10 51h1v1h-1zM13 51h1v1h-1zM15 51h1v1h-1zM17 51h1v1h-1zM22 51h2v1h-2zM26 51h2v1h-2zM30 51h1v1h-1zM33 51h1v1h-1zM37 51h1v1h-1zM41 51h1v1h-1zM44 51h2v1h-2zM51 51h1v1h-1zM4 52h7v1h-7zM12 52h1v1h-1zM14 52h2v1h-2zM17 52h1v1h-1zM19 52h1v1h-1zM21 52h1v1h-1zM24 52h5v1h-5zM30 52h1v1h-1zM32 52h3v1h-3zM36 52h3v1h-3zM40 52h4v1h-4zM45 52h1v1h-1zM48 52h1v1h-1zM50 52h3v1h-3z"/></svg>';

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
