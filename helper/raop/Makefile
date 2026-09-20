# helper/raop/Makefile — build melofon-raop, the AirPlay 1 (RAOP) sender
# helper wrapping OwnTone's raop.c (see VENDORING.md).
#
# Deps (Arch/Debian names): libevent, ffmpeg (libavcodec/libavformat/
# libavfilter/libavutil), json-c, libgcrypt + libgpg-error, libsodium,
# libplist-2.0, libunistring, util-linux (uuid), curl.

PKGS    = libevent libavcodec libavformat libavfilter libavutil json-c \
          libsodium libplist-2.0 libgcrypt uuid libcurl

CC      ?= cc
CFLAGS  ?= -O2 -g
CFLAGS  += -DHAVE_CONFIG_H -D_GNU_SOURCE -DCONFIG_GCRYPT=1 -Wall -Wno-unused \
           -I stub -I vendor -I vendor/outputs -I vendor/evrtsp \
           $(shell pkg-config --cflags $(PKGS))
LDLIBS  = $(shell pkg-config --libs $(PKGS)) -lgpg-error -lunistring -lpthread -lm

SRC = main.c \
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

melofon-raop: $(OBJ)
	$(CC) -o $@ $(OBJ) $(LDLIBS)

# Functional smoke test: a fake RAOP device (no Apple hardware needed).
test: melofon-raop
	python3 test/run_fake_device_test.py

clean:
	rm -f $(OBJ) melofon-raop

.PHONY: test clean
