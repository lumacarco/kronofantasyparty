const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });

wss.on('listening', () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || 'unknown';
  console.log(`Client connected from origin: ${origin}`);

  ws.on('message', (message) => {
    // Broadcast received messages to all connected clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});
