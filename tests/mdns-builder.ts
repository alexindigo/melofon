// tests/mdns-builder.ts — canned DNS message builder for the mDNS tests.
// Compresses suffixes automatically (like real devices): repeated suffixes
// become 0xC0xx pointers.

export class MsgBuilder {
  bytes: number[] = [];
  private offsets = new Map<string, number>();

  header(ancount: number) {
    this.bytes.push(
      0,
      0, // id
      0x84,
      0x00, // flags: response, authoritative
      0,
      0, // qd
      (ancount >> 8) & 0xff,
      ancount & 0xff,
      0,
      0,
      0,
      0, // ns, ar
    );
  }

  name(fqdn: string) {
    const labels = fqdn.split('.');
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      const existing = this.offsets.get(suffix);
      if (existing !== undefined) {
        this.bytes.push(0xc0 | (existing >> 8), existing & 0xff);
        return;
      }
      this.offsets.set(suffix, this.bytes.length);
      this.bytes.push(
        labels[i].length,
        ...[...labels[i]].map((c) => c.charCodeAt(0)),
      );
    }
    this.bytes.push(0);
  }

  u16(v: number) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
  }

  u32(v: number) {
    this.bytes.push(
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    );
  }

  record(
    fqdn: string,
    type: number,
    ttl: number,
    writeRdata: (b: MsgBuilder) => void,
  ) {
    this.name(fqdn);
    this.u16(type);
    this.u16(1); // IN
    this.u32(ttl);
    const lenPos = this.bytes.length;
    this.u16(0);
    const start = this.bytes.length;
    writeRdata(this);
    const len = this.bytes.length - start;
    this.bytes[lenPos] = (len >> 8) & 0xff;
    this.bytes[lenPos + 1] = len & 0xff;
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** A full AirPlay advertisement: PTR + TXT + SRV + A. */
export function airplayAnswer(opts: {
  instance: string;
  host: string;
  address: number[];
  port?: number;
  ttl?: number;
  txt?: string[];
}): Uint8Array {
  const ttl = opts.ttl ?? 120;
  const port = opts.port ?? 7000;
  const txt = opts.txt ?? ['tp=UDP', 'am=AppleTV3,1', 'ek=1', 'sf=0x200'];
  const b = new MsgBuilder();
  b.header(4);
  b.record('_raop._tcp.local', 12, ttl, (bb) => bb.name(opts.instance));
  b.record(opts.instance, 16, ttl, (bb) => {
    for (const kv of txt) {
      bb.bytes.push(kv.length, ...[...kv].map((c) => c.charCodeAt(0)));
    }
  });
  b.record(opts.instance, 33, ttl, (bb) => {
    bb.u16(0);
    bb.u16(0);
    bb.u16(port);
    bb.name(opts.host);
  });
  b.record(opts.host, 1, ttl, (bb) => bb.bytes.push(...opts.address));
  return b.build();
}
