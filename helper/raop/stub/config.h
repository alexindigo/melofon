/* config.h — hand-written autoconf stand-in for the melofon RAOP helper
 * (Linux/glibc). Defines the HAVE_* the vendored OwnTone sources test for,
 * and selects gcrypt for pair_ap's bignum/hash glue. */
#ifndef MELOFON_RAOP_CONFIG_H
#define MELOFON_RAOP_CONFIG_H

#define HAVE_CLOCK_GETTIME 1
#define HAVE_TIMER_SETTIME 1
#define HAVE_GETADDRINFO 1
#define HAVE_GETNAMEINFO 1
#define HAVE_STRSEP 1
#define HAVE_REGEX_H 1
#define HAVE_ENDIAN_H 1
#define HAVE_GETTID 1
#define HAVE_PTHREAD_SETNAME_NP 1
#define HAVE_PTHREAD_GETNAME_NP 1
#define HAVE_FFMPEG 1
#define HAVE_UUID 1

#define SIZEOF_VOID_P 8

#define CONFIG_GCRYPT 1
#define CONFIG_OPENSSL 0

#endif
