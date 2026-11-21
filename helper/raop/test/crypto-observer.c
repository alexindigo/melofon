/* Test-only libgcrypt observer. Keys never cross this in-memory boundary.
 * OAEP input is independently unmasked and matched to the AES key; ciphertext
 * is decrypted here for the receiving ALAC/scheduled consumer. No production
 * build links this file, no secret file or diagnostic channel exists. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <gcrypt.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

struct observed {
  gcry_cipher_hd_t handle;
  uint8_t key[16], iv[16], rsa[256];
  int live, oaep, iv_set;
  unsigned packets;
};
static struct observed contexts[64]; /* test observations only, not a product quota */
static unsigned generated;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static _Thread_local struct observed *pending;

static void *real_symbol(const char *name)
{
  void *p = dlsym(RTLD_NEXT, name);
  if (!p) p = dlsym(dlopen("libgcrypt.so.20", RTLD_NOW | RTLD_LOCAL), name);
  if (!p) abort();
  return p;
}
static void erase(void *memory, size_t length)
{
  volatile uint8_t *p = memory;
  while (length--) *p++ = 0;
}
static struct observed *find(gcry_cipher_hd_t handle)
{
  for (unsigned i = 0; i < generated; i++)
    if (contexts[i].live && contexts[i].handle == handle) return &contexts[i];
  return NULL;
}
gcry_error_t gcry_cipher_setkey(gcry_cipher_hd_t h, const void *key, size_t length)
{
  gcry_error_t (*real)(gcry_cipher_hd_t, const void *, size_t) = real_symbol("gcry_cipher_setkey");
  gcry_error_t rc = real(h, key, length);
  if (!rc && length == 16) {
    pthread_mutex_lock(&lock);
    if (generated == 64) abort();
    pending = &contexts[generated++];
    *pending = (struct observed){ .handle = h, .live = 1 };
    memcpy(pending->key, key, 16);
    pthread_mutex_unlock(&lock);
  }
  return rc;
}
gcry_error_t gcry_cipher_setiv(gcry_cipher_hd_t h, const void *iv, size_t length)
{
  gcry_error_t (*real)(gcry_cipher_hd_t, const void *, size_t) = real_symbol("gcry_cipher_setiv");
  gcry_error_t rc = real(h, iv, length);
  pthread_mutex_lock(&lock);
  struct observed *s = find(h);
  if (s && !rc && length == 16) { memcpy(s->iv, iv, 16); s->iv_set = 1; }
  pthread_mutex_unlock(&lock);
  return rc;
}
gcry_error_t gcry_cipher_encrypt(gcry_cipher_hd_t h, void *out, size_t length,
                                const void *in, size_t inlength)
{
  gcry_error_t (*real)(gcry_cipher_hd_t, void *, size_t, const void *, size_t) = real_symbol("gcry_cipher_encrypt");
  gcry_error_t rc = real(h, out, length, in, inlength);
  pthread_mutex_lock(&lock);
  struct observed *s = find(h);
  if (s && !rc) s->packets++;
  pthread_mutex_unlock(&lock);
  return rc;
}
void gcry_cipher_close(gcry_cipher_hd_t h)
{
  void (*real)(gcry_cipher_hd_t) = real_symbol("gcry_cipher_close");
  pthread_mutex_lock(&lock);
  struct observed *s = find(h);
  if (s) { erase(s->key, 16); erase(s->iv, 16); s->live = 0; }
  pthread_mutex_unlock(&lock);
  real(h);
}
static void mgf(uint8_t *out, size_t length, const uint8_t *seed, size_t seedlength)
{
  uint8_t input[256], digest[20];
  memcpy(input, seed, seedlength);
  for (uint32_t i = 0; length; i++) {
    input[seedlength] = i >> 24; input[seedlength + 1] = i >> 16;
    input[seedlength + 2] = i >> 8; input[seedlength + 3] = i;
    gcry_md_hash_buffer(GCRY_MD_SHA1, digest, input, seedlength + 4);
    size_t take = length < 20 ? length : 20;
    memcpy(out, digest, take); out += take; length -= take;
  }
  erase(input, sizeof(input)); erase(digest, sizeof(digest));
}
static int mpi_bytes(gcry_sexp_t sexp, const char *token, uint8_t out[256])
{
  gcry_sexp_t part = gcry_sexp_find_token(sexp, token, 0);
  if (!part) return 0;
  gcry_mpi_t mpi = gcry_sexp_nth_mpi(part, 1, GCRYMPI_FMT_USG);
  gcry_sexp_release(part);
  if (!mpi) return 0;
  uint8_t bytes[256]; size_t length = 0;
  int rc = gcry_mpi_print(GCRYMPI_FMT_USG, bytes, sizeof(bytes), &length, mpi);
  gcry_mpi_release(mpi);
  if (!rc) { memset(out, 0, 256); memcpy(out + 256 - length, bytes, length); }
  erase(bytes, sizeof(bytes));
  return !rc;
}
gcry_error_t gcry_pk_encrypt(gcry_sexp_t *result, gcry_sexp_t input, gcry_sexp_t key)
{
  gcry_error_t (*real)(gcry_sexp_t *, gcry_sexp_t, gcry_sexp_t) = real_symbol("gcry_pk_encrypt");
  gcry_error_t rc = real(result, input, key);
  if (pending && !rc) {
    uint8_t em[256], seed[20], db[235], hash[20];
    int ok = mpi_bytes(input, "value", em) && mpi_bytes(*result, "a", pending->rsa);
    if (ok) {
      mgf(seed, 20, em + 21, 235);
      for (size_t i = 0; i < 20; i++) seed[i] ^= em[i + 1];
      mgf(db, 235, seed, 20);
      for (size_t i = 0; i < 235; i++) db[i] ^= em[i + 21];
      gcry_md_hash_buffer(GCRY_MD_SHA1, hash, "", 0);
      ok = !em[0] && !memcmp(db, hash, 20) && db[218] == 1 &&
        !memcmp(db + 219, pending->key, 16);
      for (size_t i = 20; i < 218; i++) if (db[i]) ok = 0;
    }
    pthread_mutex_lock(&lock); pending->oaep = ok; pthread_mutex_unlock(&lock);
    pending = NULL;
    erase(em, sizeof(em)); erase(seed, sizeof(seed));
    erase(db, sizeof(db)); erase(hash, sizeof(hash));
  }
  return rc;
}
unsigned raop_crypto_generated(void)
{
  pthread_mutex_lock(&lock); unsigned n = generated; pthread_mutex_unlock(&lock);
  return n;
}
unsigned raop_crypto_live(void)
{
  unsigned n = 0;
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < generated; i++) n += contexts[i].live;
  pthread_mutex_unlock(&lock);
  return n;
}
/* Return a non-secret observation index only when SDP RSA output and IV match
 * the cipher whose independently decoded RSA-OAEP input contained that key. */
int raop_crypto_sdp(const uint8_t rsa[256], const uint8_t iv[16])
{
  int index = -1;
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < generated; i++) {
    struct observed *s = &contexts[i];
    if (s->live && s->oaep && s->iv_set && s->packets &&
        !memcmp(s->rsa, rsa, 256) && !memcmp(s->iv, iv, 16)) index = i;
  }
  pthread_mutex_unlock(&lock);
  return index;
}
int raop_crypto_decrypt(unsigned index, const uint8_t *in, size_t length, uint8_t *out)
{
  gcry_error_t (*setkey)(gcry_cipher_hd_t, const void *, size_t) = real_symbol("gcry_cipher_setkey");
  gcry_error_t (*setiv)(gcry_cipher_hd_t, const void *, size_t) = real_symbol("gcry_cipher_setiv");
  void (*close_cipher)(gcry_cipher_hd_t) = real_symbol("gcry_cipher_close");
  pthread_mutex_lock(&lock);
  if (index >= generated) { pthread_mutex_unlock(&lock); return -1; }
  struct observed *s = &contexts[index];
  gcry_cipher_hd_t h = NULL;
  int rc = -1;
  if (s->live && s->oaep && s->iv_set &&
      !gcry_cipher_open(&h, GCRY_CIPHER_AES, GCRY_CIPHER_MODE_CBC, 0) &&
      !setkey(h, s->key, 16) && !setiv(h, s->iv, 16)) {
    memcpy(out, in, length);
    rc = gcry_cipher_decrypt(h, out, length / 16 * 16, NULL, 0) ? -1 : 0;
  }
  if (h) close_cipher(h);
  pthread_mutex_unlock(&lock);
  return rc;
}
