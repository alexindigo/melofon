import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default (request: PathfinderRequest) => {
  const upgrade = request.upgrade({});
  void upgrade.socket.then((ws) => {
    ws.onmessage = (event) =>
      ws.send(JSON.stringify({
        echo: String(event.data),
        path: request.path,
        query: request.query.get('probe'),
        peer: request.remoteAddr?.hostname,
      }));
  });
  return upgrade.response;
};
