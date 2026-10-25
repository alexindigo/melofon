// Reserve the whole fixture's port set, including its default listen, before
// releasing any socket. Separate bind/read/close calls can reuse a port number.
export function reservePorts(count: number) {
  const sockets: Deno.TcpListener[] = [];
  function release() {
    for (const socket of sockets.splice(0)) socket.close();
  }
  try {
    for (let i = 0; i < count; i++) {
      sockets.push(Deno.listen({ hostname: '0.0.0.0', port: 0 }));
    }
    return {
      ports: sockets.map((socket) => socket.addr.port),
      release,
      [Symbol.dispose]: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
