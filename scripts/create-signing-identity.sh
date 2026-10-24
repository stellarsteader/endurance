#!/bin/sh
# Creates a self-signed code-signing certificate in your login keychain, once, so that
# `npm run package:mac:local` can sign every local build with the same identity.
#
# Run it yourself:  sh scripts/create-signing-identity.sh
# It never deletes or replaces keychain items, and does nothing if the certificate already exists.
# The only thing it removes is its own temporary folder (which holds the new private key until it is imported).
#
# What this does and does not fix (see README "Signing your own builds"):
# - The app keeps one designated requirement across rebuilds, so macOS privacy grants such as the microphone stay.
# - It does NOT stop the Keychain prompt for "Endurance Safe Storage" on each rebuild: macOS ties keychain items to
#   the Team ID of an Apple-issued certificate, and a self-signed one has none, so each build still counts as new.
#   Use a free "Apple Development" certificate from Xcode for that instead.
set -eu

NAME="${ENDURANCE_SIGNING_IDENTITY:-Endurance Local Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
# macOS's own LibreSSL writes .p12 files that `security import` reads; a Homebrew OpenSSL 3 may not.
OPENSSL=/usr/bin/openssl

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

# 1. Skip everything if a certificate with this name is already in the login keychain.
if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "A certificate named \"$NAME\" is already in your login keychain. Nothing created."
else
  # 2. Work in a private temporary folder; the private key exists on disk only here, only until import.
  umask 077
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/endurance-signing.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT INT TERM

  # 3. Describe the certificate: a leaf (not a CA) that may only sign code.
  cat >"$WORK/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

  # 4. Make a 2048-bit RSA key and a self-signed certificate valid for 10 years.
  "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -config "$WORK/openssl.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

  # 5. Bundle key and certificate into a .p12 protected by a one-time random password.
  P12_PASS="$("$OPENSSL" rand -hex 16)"
  export P12_PASS
  "$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
    -out "$WORK/identity.p12" -passout env:P12_PASS

  # 6. Import it into the login keychain and let codesign use the private key.
  security import "$WORK/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$P12_PASS" -T /usr/bin/codesign
  echo "Created \"$NAME\" in your login keychain."
fi

# 7. electron-builder only uses identities macOS reports as valid, and a self-signed certificate is valid
#    for code signing only after you trust it for that. This script does not change trust settings itself.
if security find-identity -v -p codesigning "$KEYCHAIN" | grep -F "\"$NAME\"" >/dev/null; then
  echo "\"$NAME\" is ready. Build with: npm run package:mac:local -- --arm64   (Intel: --x64)"
else
  CER="${TMPDIR:-/tmp}/endurance-local-signing.cer"
  cat <<EOF

"$NAME" is not trusted for code signing yet, so electron-builder will not find it.
Trust it for code signing only, either:

  In Keychain Access: open the login keychain, double-click "$NAME", expand Trust,
  set "Code Signing" to "Always Trust", close the window and enter your password.

or in Terminal (macOS asks for your password):

  security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$CER"
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CER"

Then check that it is listed:

  security find-identity -v -p codesigning

EOF
fi
