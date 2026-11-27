import { createServer, createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A credential-free TCP relay. Only this service joins the host-facing network;
// the application and PostgreSQL remain on the internal backend network.
export async function startGateway({ host = '127.0.0.1', targetHost = '127.0.0.1', ports }) {
  const servers = [], sockets = new Set();
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(r => server.close(r))));
  };
  try {
    for (const [port, target] of ports) {
      const server = createServer(socket => {
        const upstream = createConnection({ host: targetHost, port: target });
        sockets.add(socket); sockets.add(upstream);
        const stop = () => { socket.destroy(); upstream.destroy(); sockets.delete(socket); sockets.delete(upstream); };
        socket.on('error', stop); upstream.on('error', stop);
        socket.on('close', () => { upstream.destroy(); sockets.delete(socket); });
        // Let pipe() flush a complete response before the client socket closes.
        upstream.on('close', () => { sockets.delete(upstream); });
        socket.setTimeout(120000, stop); upstream.setTimeout(120000, stop);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      servers.push(server);
      await new Promise((yes, no) => { server.once('error', no); server.listen(port, host, yes); });
    }
    return { servers, close };
  } catch (e) { await close(); throw e; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gateway = await startGateway({ host: '0.0.0.0', targetHost: 'api', ports: [[3110,3000],[8186,8080]] });
  console.log('[sandbox gateway] API and website forwarding ready.');
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => gateway.close().then(() => process.exit(0)));
}
