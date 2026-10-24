# Native API TLS fixture

Self-signed certificate and **public test-only private key**, generated inside
the a4 test VM with OpenSSL for `DNS:melofon.home`. No production identity or
credential. The API tests explicitly trust this certificate with Deno's
`caCerts` option; normal certificate and hostname checks stay enabled.
Valid from 2026-10-24 for ten years. Plain HTTP remains the primary acceptance
address; this extra TLS case verifies the conditional `Secure` cookie flag.
