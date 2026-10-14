import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  createMdnsResolver,
  type ResolverSocket,
} from '../src/mdns-resolver.ts';
import { createServiceRecords, dnsQuestions } from '../src/mdns.ts';
import { PreparationError } from '../src/output-admission.ts';
import { airplayAnswer, MsgBuilder, ptrOnlyAnswer } from './mdns-builder.ts';

type Message = (
  message: Uint8Array,
  peer: { address: string; port: number },
) => void;
type SocketError = (error: Error) => void;
class Socket implements ResolverSocket {
  sent: { message: Uint8Array; port: number; address: string }[] = [];
  bound: number[] = [];
  closes = 0;
  message?: Message;
  error?: SocketError;
  afterSend?: () => void;
  bind(port: number, callback: () => void) {
    this.bound.push(port);
    callback();
  }
  send(message: Uint8Array, port: number, address: string) {
    this.sent.push({ message, port, address });
    this.afterSend?.();
  }
  on(event: 'message' | 'error', listener: Message | SocketError) {
    if (event === 'message') this.message = listener as Message;
    else this.error = listener as SocketError;
  }
  close() {
    this.closes++;
  }
  receive(packet: Uint8Array, address = '127.0.0.1', port = 5353) {
    this.message?.(packet, { address, port });
  }
  echo(index = this.sent.length - 1) {
    const query = this.sent[index].message;
    return {
      id: new DataView(query.buffer, query.byteOffset).getUint16(0),
      questions: dnsQuestions(query)!,
    };
  }
}
const instance = '001122334455@test._raop._tcp.local';
const answer = (
  socket: Socket,
  extra: Partial<Parameters<typeof airplayAnswer>[0]> = {},
) =>
  airplayAnswer({
    instance,
    host: 'test.local',
    address: [127, 0, 0, 1],
    txt: ['tp=UDP', 'am=AppleTV3,1', 'md=0,1,2'],
    ...socket.echo(),
    ...extra,
  });
const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test('target-only resolver uses ephemeral port, correlated unicast, and closes on complete TXT', async () => {
  const socket = new Socket();
  const resolver = createMdnsResolver({ socket: () => socket, timeoutMs: 100 });
  const pending = resolver.resolve('127.0.0.1');
  await settle();
  assertEquals(socket.bound, [0]);
  assertEquals(socket.sent.length, 1);
  assertEquals(socket.sent[0].address, '127.0.0.1');
  assertEquals(socket.sent[0].port, 5353);
  assert(socket.echo().id > 0);
  socket.receive(answer(socket));
  assertEquals((await pending).txt.md, '0,1,2');
  assertEquals(socket.closes, 1);
  resolver.close();
});

Deno.test('target-only resolver waits for split TXT and validates responder/query identity', async () => {
  const socket = new Socket();
  const resolver = createMdnsResolver({ socket: () => socket, timeoutMs: 100 });
  let completed = false;
  const pending = resolver.resolve('127.0.0.1').then((s) => {
    completed = true;
    return s;
  });
  await settle();
  socket.receive(answer(socket), '127.0.0.2');
  socket.receive(answer(socket, { id: 0 }));
  socket.receive(answer(socket, { omitTxt: true }));
  await settle();
  assert(!completed);
  assertEquals(socket.sent.length, 2);
  socket.receive(answer(socket));
  assertEquals((await pending).port, 7000);
  assertEquals(socket.closes, 1);
  resolver.close();
});

Deno.test('target-only resolver follows PTR/SRV/address without multicast fallback', async () => {
  const socket = new Socket();
  const resolver = createMdnsResolver({ socket: () => socket, timeoutMs: 100 });
  const pending = resolver.resolve('127.0.0.1');
  await settle();
  socket.receive(
    ptrOnlyAnswer(instance, 120, socket.echo().id, socket.echo().questions),
  );
  assertEquals(socket.sent.length, 2);
  socket.receive(answer(socket, { omitA: true }));
  assertEquals(socket.sent.length, 3);
  socket.receive(answer(socket));
  await pending;
  assert(socket.sent.every((s) => s.address === '127.0.0.1'));
  resolver.close();
});

Deno.test('target-only resolver cancellation, timeout and socket failure release owned resources', async () => {
  for (const mode of ['cancel', 'timeout', 'error', 'close']) {
    const socket = new Socket();
    const resolver = createMdnsResolver({
      socket: () => socket,
      timeoutMs: 15,
    });
    const controller = new AbortController();
    const pending = resolver.resolve('127.0.0.1', undefined, controller.signal);
    const rejected = assertRejects(() => pending, PreparationError);
    await settle();
    if (mode === 'cancel') controller.abort();
    if (mode === 'error') socket.error?.(new Error('fixture'));
    if (mode === 'close') resolver.close();
    await rejected;
    assertEquals(socket.closes, 1);
    resolver.close();
  }
});

Deno.test('target-only resolver malformed TXT and wrong requested service port never succeed', async () => {
  for (const mode of ['txt', 'port']) {
    const socket = new Socket();
    const resolver = createMdnsResolver({
      socket: () => socket,
      timeoutMs: 15,
    });
    const pending = resolver.resolve('127.0.0.1', 7000);
    const rejected = assertRejects(() => pending, PreparationError);
    await settle();
    if (mode === 'port') socket.receive(answer(socket, { port: 7001 }));
    else {
      const b = new MsgBuilder();
      b.header(2, socket.echo().id, socket.echo().questions);
      b.record('_raop._tcp.local', 12, 10, (r) => r.name(instance));
      b.record(instance, 16, 10, (r) => r.bytes.push(10, 1));
      socket.receive(b.build());
    }
    await rejected;
    assertEquals(socket.closes, 1);
    resolver.close();
  }
});

Deno.test('record completion requires TXT and retains earliest required-record expiry', () => {
  let now = 0;
  const records = createServiceRecords('_raop._tcp', () => now);
  records.ingest(
    airplayAnswer({
      instance,
      host: 'test.local',
      address: [127, 0, 0, 1],
      omitTxt: true,
      ttl: 120,
    }),
  );
  assertEquals(records.services(), []);
  const b = new MsgBuilder();
  b.header(1);
  b.record(
    instance,
    16,
    1,
    (r) => r.bytes.push(6, ...new TextEncoder().encode('tp=UDP')),
  );
  assert(records.ingest(b.build()));
  assertEquals(records.services()[0].ttlMs, 1000);
  now = 1001;
  assertEquals(records.services(), []);
});

Deno.test('target-only resolver rejects ambiguous complete services at the requested endpoint', async () => {
  const socket = new Socket();
  const resolver = createMdnsResolver({ socket: () => socket, timeoutMs: 100 });
  const pending = resolver.resolve('127.0.0.1', 7000);
  const rejected = assertRejects(
    () => pending,
    PreparationError,
    'ambiguous receiver service',
  );
  await settle();
  const b = new MsgBuilder();
  b.header(7, socket.echo().id, socket.echo().questions);
  const names = [instance, '009988776655@second._raop._tcp.local'];
  for (const name of names) {
    b.record('_raop._tcp.local', 12, 10, (r) => r.name(name));
  }
  for (const name of names) {
    b.record(
      name,
      16,
      10,
      (r) => r.bytes.push(6, ...new TextEncoder().encode('tp=UDP')),
    );
    b.record(name, 33, 10, (r) => {
      r.u16(0);
      r.u16(0);
      r.u16(7000);
      r.name('test.local');
    });
  }
  b.record('test.local', 1, 10, (r) => r.bytes.push(127, 0, 0, 1));
  socket.receive(b.build());
  await rejected;
  assertEquals(socket.closes, 1);
  resolver.close();
});
