"""Make the "Secret Key" Supabase needs for Sign in with Apple.

Apple doesn't hand out a fixed secret: you sign a short token with your .p8 key, and
Apple lets that token live at most 6 months. Run this again before it runs out.

    python tools/apple_secret.py path/to/AuthKey_TABRGU7PG5.p8

It prints the token (and the date it expires). Paste it into
Supabase > Authentication > Sign In / Providers > Apple > Secret Key.
No extra packages needed: the ES256 signature is done in plain Python.
"""
import base64, hashlib, json, re, secrets, sys, time
from datetime import datetime, timezone

TEAM_ID = "9GGGM64WUN"
KEY_ID = "TABRGU7PG5"
SERVICES_ID = "io.github.jelalh.partylist.web"
LIFETIME = 180 * 24 * 3600  # Apple's maximum is ~6 months

# NIST P-256 curve
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
     0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)

def add(p1, p2):
    if p1 is None: return p2
    if p2 is None: return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % P == 0: return None
    if p1 == p2: m = (3 * x1 * x1 + A) * pow(2 * y1, -1, P) % P
    else: m = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (m * m - x1 - x2) % P
    return x3, (m * (x1 - x3) - y1) % P

def mul(k, pt=G):
    out = None
    while k:
        if k & 1: out = add(out, pt)
        pt = add(pt, pt); k >>= 1
    return out

def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def load_key(path):
    pem = open(path, "r", encoding="ascii").read()
    der = base64.b64decode("".join(l for l in pem.splitlines() if l and not l.startswith("-----")))
    m = re.search(rb"\x02\x01\x01\x04\x20(.{32})", der, re.S)       # ECPrivateKey: version 1, 32-byte d
    if not m: sys.exit("That doesn't look like an Apple .p8 key file.")
    d = int.from_bytes(m.group(1), "big")
    pub = re.search(rb"\x03\x42\x00\x04(.{64})", der, re.S)          # public key, if included
    if pub:
        x, y = int.from_bytes(pub.group(1)[:32], "big"), int.from_bytes(pub.group(1)[32:], "big")
        if mul(d) != (x, y): sys.exit("Key file check failed (public key doesn't match).")
    return d

def sign(d, msg):
    e = int.from_bytes(hashlib.sha256(msg).digest(), "big")
    while True:
        k = secrets.randbelow(N - 1) + 1
        r = mul(k)[0] % N
        s = pow(k, -1, N) * (e + r * d) % N
        if r and s: return r.to_bytes(32, "big") + s.to_bytes(32, "big")

def main():
    if len(sys.argv) != 2: sys.exit(__doc__)
    d = load_key(sys.argv[1])
    now = int(time.time())
    header = {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
    payload = {"iss": TEAM_ID, "iat": now, "exp": now + LIFETIME, "aud": "https://appleid.apple.com", "sub": SERVICES_ID}
    signing_input = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
                     b64url(json.dumps(payload, separators=(",", ":")).encode())).encode()
    token = signing_input.decode() + "." + b64url(sign(d, signing_input))
    print(token)
    print("expires:", datetime.fromtimestamp(now + LIFETIME, timezone.utc).strftime("%d %B %Y"), file=sys.stderr)

if __name__ == "__main__":
    main()
