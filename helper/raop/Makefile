# helper/raop/Makefile — build libmelofon_raop, OwnTone's RAOP (raop.c,
# vendored) as an in-process shared library for Melofon's Deno FFI. See
# VENDORING.md.
#
# Deps (Arch/Debian names): libevent (+pthreads), ffmpeg (libavcodec/
# libavformat/libavfilter/libavutil), json-c, libgcrypt + libgpg-error,
# libsodium, libplist-2.0, libunistring, util-linux (uuid), curl.

PKGS    = libevent libavcodec libavformat libavfilter libavutil json-c \
          libsodium libplist-2.0 libgcrypt uuid libcurl

CC      ?= cc
CFLAGS  ?= -O2 -g
CFLAGS  += -fPIC -DHAVE_CONFIG_H -D_GNU_SOURCE -DCONFIG_GCRYPT=1 \
           -Wall -Wno-unused \
           -I stub -I vendor -I vendor/outputs -I vendor/evrtsp \
           $(shell pkg-config --cflags $(PKGS))
LDLIBS  = $(shell pkg-config --libs $(PKGS)) -levent_pthreads -lgpg-error \
          -lunistring -lpthread -lm

# -z nodelete: the library's background loop thread can outlive the dlopen
# handle (a consumer that drops it without raop_free must not get the code
# unmapped from under the thread — dlclose becomes a no-op).
LDFLAGS  = -Wl,-z,nodelete

SRC = ffi.c \
      player.c \
      stub/stubs.c \
      vendor/outputs/raop.c \
      vendor/outputs/rtp_common.c \
      vendor/evrtsp/rtsp.c \
      vendor/pair_ap/pair.c \
      vendor/pair_ap/pair_fruit.c \
      vendor/pair_ap/pair_homekit.c \
      vendor/pair_ap/pair-tlv.c \
      vendor/transcode.c \
      vendor/misc.c

OBJ = $(SRC:.c=.o)

libmelofon_raop.so: $(OBJ)
	$(CC) -shared -o $@ $(OBJ) $(LDFLAGS) $(LDLIBS)

# Functional smoke test: driver links the library; a fake RAOP device (no
# Apple hardware needed) asserts the wire.
test/driver: test/driver.o libmelofon_raop.so
	$(CC) -o $@ test/driver.o -L. -lmelofon_raop -Wl,-rpath,'$$ORIGIN/..'

# Test-only failure-injection interposer (LD_PRELOAD; never linked into the
# library or the driver) for the queue/cleanup failure-contract scenarios.
test/faultinject.so: test/faultinject.c
	$(CC) $(CFLAGS) -shared -o $@ $< -ldl

test: libmelofon_raop.so test/driver test/faultinject.so
	python3 test/run_fake_device_test.py

clean:
	rm -f $(OBJ) test/driver.o libmelofon_raop.so test/driver \
	  test/faultinject.so test/probe_free_contract

.PHONY: test clean
