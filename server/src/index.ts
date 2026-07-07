import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerApiRoutes } from './routes/api.js';
import { registerWsRoutes } from './routes/ws.js';
import { startScheduler } from './pollers/scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

// Red de seguridad: algunas librerías (p. ej. node-routeros al recibir una respuesta
// inesperada de un MikroTik) lanzan errores de forma asíncrona que un try/catch normal
// no atrapa. Sin esto, un solo equipo con una respuesta rara tumbaría TODO el monitoreo.
// Aquí los registramos y dejamos que el sistema siga corriendo.
process.on('uncaughtException', (err) => {
  console.error('[resiliencia] excepción no controlada (se continúa):', err instanceof Error ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[resiliencia] promesa rechazada no controlada (se continúa):', reason instanceof Error ? reason.message : reason);
});

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: 'info' } });

  // Tolerar cuerpos vacíos con Content-Type application/json (DELETE / POST sin body),
  // que de otro modo Fastify rechaza con 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  registerApiRoutes(app);
  await app.register(async (instance) => registerWsRoutes(instance));

  // En producción sirve el build del frontend (web/dist)
  const webDist = path.resolve(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws')) {
        return reply.code(404).send({ error: 'No encontrado' });
      }
      return reply.sendFile('index.html');
    });
  }

  startScheduler();
  const { syncTelegramPoller } = await import('./alerts/telegram-poller.js');
  syncTelegramPoller(); // arranca el poller de botones si está configurado

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`MonitorCt escuchando en http://localhost:${PORT}`);
  const { aiAvailable } = await import('./ai/agent.js');
  if (!aiAvailable()) {
    console.warn('AVISO: sin API key de Anthropic — el diagnóstico con IA está deshabilitado. Puedes agregarla desde la pestaña Ajustes (⚙) de la interfaz.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
