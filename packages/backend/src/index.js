import { createAppServer, createRuntime } from './app.js';
import { startWsServer } from './ws/WsServer.js';

const httpPort = Number(process.env.PORT || 8700);
const wsPort = Number(process.env.WS_PORT || httpPort + 1);

const runtime = createRuntime();
const server = createAppServer(runtime);
const wss = startWsServer(wsPort, runtime.orchestrator);

server.listen(httpPort, () => {
  console.log(`backend listening on ${httpPort}`);
});

function shutdown() {
  runtime.gatewaySubscriber?.close?.();
  runtime.orchestrator.close?.();
  wss.close?.();
  server.close?.(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
