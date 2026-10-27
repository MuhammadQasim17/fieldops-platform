import { Request, Response } from 'express';

/**
 * Active SSE client connection pool
 */
const sseClients = new Set<Response>();

/**
 * GET /api/events
 * Server-Sent Events (SSE) stream registration handler for real-time dispatcher telemetry.
 */
export const eventsHandler = (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    sseClients.delete(res);
  };

  // Heartbeat comment every 25 seconds to keep intermediary proxies alive
  const heartbeatInterval = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch {
      cleanup();
    }
  }, 25000);

  // Initial handshake comment
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.write(': connected\n\n');
      sseClients.add(res);
    } catch {
      cleanup();
      return;
    }
  } else {
    cleanup();
    return;
  }

  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', (err) => {
    cleanup();
  });
  if (res.socket) {
    res.socket.on('error', () => {
      cleanup();
    });
  }
};

/**
 * Broadcast a real-time SSE event to all connected dispatcher clients.
 * Formats payload as: `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
 */
export const broadcastEvent = (eventType: string, data: any): void => {
  if (sseClients.size === 0) return;

  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const client of sseClients) {
    if (client.writableEnded || client.destroyed) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(payload);
    } catch (err) {
      console.warn('[SSE] Failed to write to client, removing from pool:', err);
      sseClients.delete(client);
    }
  }
};

