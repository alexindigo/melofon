# Outbound TLS fixture

Self-signed certificate and **public test-only private key**, generated inside
the p1 test VM with OpenSSL for `DNS:feed.test`. No production identity or
credential. Tests explicitly trust this certificate only for their network
instance; normal certificate and hostname checks remain enabled. Valid from
2026-10-21 for ten years.
