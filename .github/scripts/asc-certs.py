#!/usr/bin/env python3
"""Keeps the iOS workflow from filling the Apple account with development certificates.

Every run signs on a fresh Mac, so Xcode creates a new Apple Development certificate each time
(-allowProvisioningUpdates) and the account soon reaches its limit ("Choose a certificate to
revoke"). The workflow notes the account's certificates before archiving and, once the build is
uploaded, revokes the development certificates that appeared during the run. Nothing else is
touched: certificates that existed before the run, and distribution certificates, stay.

  asc-certs.py snapshot FILE     the ids of the account's certificates, into FILE
  asc-certs.py revoke-new FILE   revoke development certificates not in FILE

Uses the App Store Connect API key the workflow already has (ASC_KEY_PATH, ASC_KEY_ID,
ASC_ISSUER_ID); standard library, openssl and curl only. Never fails the build: problems
are reported as warnings.
"""
import base64, json, os, subprocess, sys, time

API = 'https://api.appstoreconnect.apple.com/v1/certificates'
DEVELOPMENT = {'DEVELOPMENT', 'IOS_DEVELOPMENT'}


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def der_to_raw(der: bytes) -> bytes:
    """An ECDSA signature from DER (SEQUENCE of two INTEGERs) to JWS's r || s, 32 bytes each."""
    if der[0] != 0x30:
        raise ValueError('not a DER sequence')
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7f)
    out = b''
    for _ in range(2):
        if der[i] != 0x02:
            raise ValueError('not a DER integer')
        n = der[i + 1]
        v = der[i + 2:i + 2 + n].lstrip(b'\0')
        if len(v) > 32:
            raise ValueError('integer too long')
        out += v.rjust(32, b'\0')
        i += 2 + n
    return out


def token() -> str:
    head = b64url(json.dumps({'alg': 'ES256', 'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'}).encode())
    now = int(time.time())
    body = b64url(json.dumps({'iss': os.environ['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 900, 'aud': 'appstoreconnect-v1'}).encode())
    signing = f'{head}.{body}'.encode()
    der = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', os.environ['ASC_KEY_PATH']],
                         input=signing, capture_output=True, check=True).stdout
    return f'{head}.{body}.{b64url(der_to_raw(der))}'


def call(method: str, url: str):
    """curl, not urllib: the runner's Python may lack a certificate store."""
    # -g: the brackets in fields[certificates] are not curl's globbing. The token goes through stdin (-H @-)
    # so it never shows in an error message.
    r = subprocess.run(['curl', '-sS', '-g', '-X', method, '-H', '@-', '-w', '\n%{http_code}', url],
                       input=('Authorization: Bearer ' + token() + '\n').encode(), capture_output=True, timeout=90)
    if r.returncode:
        raise RuntimeError(f'curl exit {r.returncode}: {r.stderr.decode()[:300]}')
    body, _, code = r.stdout.decode().rpartition('\n')
    if not code.startswith('2'):
        raise RuntimeError(f'HTTP {code} {body[:300]}')
    return json.loads(body) if body.strip() else None


def certificates() -> list:
    out, url = [], API + '?limit=200&fields[certificates]=certificateType,displayName,name,expirationDate'
    while url:
        page = call('GET', url)
        out += page.get('data', [])
        url = (page.get('links') or {}).get('next')
    return out


def main() -> int:
    cmd, path = sys.argv[1], sys.argv[2]
    try:
        if cmd == 'snapshot':
            ids = [c['id'] for c in certificates()]
            with open(path, 'w') as f:
                json.dump(ids, f)
            print(f'{len(ids)} certificates before the build')
        elif cmd == 'revoke-new':
            if not os.path.exists(path):
                print('::warning::no certificate list from before the build; nothing revoked')
                return 0
            before = set(json.load(open(path)))
            new = [c for c in certificates() if c['id'] not in before and c['attributes'].get('certificateType') in DEVELOPMENT]
            if not new:
                print('no development certificate was created by this run')
            for c in new:
                a = c['attributes']
                call('DELETE', f"{API}/{c['id']}")
                print(f"revoked {a.get('certificateType')} {a.get('displayName') or a.get('name')} (expires {a.get('expirationDate')})")
        else:
            print(f'unknown command {cmd}', file=sys.stderr)
            return 2
    except Exception as e:  # never fail the build over this
        print(f'::warning::App Store Connect certificates ({cmd}): {e}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
