const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 30000);
const MAX_MESSAGE_SIZE = Number(process.env.MAX_MESSAGE_SIZE || 16 * 1024);
const MAX_CHAT_LENGTH = Number(process.env.MAX_CHAT_LENGTH || 400);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'https://kronofantasy.net,https://www.kronofantasy.net,http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const clients = new Map();
const rooms = new Map();
const parties = new Map();

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createPartyCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function originAllowed(origin) {
  if (!origin) {
    return true;
  }

  if (ALLOWED_ORIGINS.includes('*')) {
    return true;
  }

  return ALLOWED_ORIGINS.includes(origin);
}

function sanitizeText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength) || fallback;
}

function sanitizeId(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const cleanValue = value.trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '');
  return cleanValue.slice(0, 64) || fallback;
}

function safePayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function send(ws, type, payload = {}, requestId = null) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    type,
    requestId,
    ts: nowIso(),
    payload,
  }));
}

function sendToSession(session, type, payload = {}, requestId = null) {
  send(session.ws, type, payload, requestId);
}

function sendError(session, code, message, requestId = null, details = {}) {
  sendToSession(session, 'error', { code, message, details }, requestId);
}

function publicClient(session) {
  return {
    clientId: session.id,
    playerId: session.playerId,
    saveId: session.saveId,
    name: session.name,
    avatar: session.avatar,
    joinedAt: session.joinedAt,
    partyId: session.partyId,
    meta: session.meta,
  };
}

function roomSnapshot(room) {
  return {
    roomId: room.id,
    name: room.name,
    kind: room.kind,
    ownerId: room.ownerId,
    isPrivate: room.isPrivate,
    partyId: room.partyId,
    members: Array.from(room.members).map((clientId) => {
      const session = clients.get(clientId);
      return session ? publicClient(session) : { clientId, disconnected: true };
    }),
  };
}

function partySnapshot(party) {
  return {
    partyId: party.id,
    code: party.code,
    name: party.name,
    leaderId: party.leaderId,
    roomId: party.roomId,
    isOpen: party.isOpen,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
    sharedState: party.sharedState,
    members: Array.from(party.members.values()),
  };
}

function broadcastToSessions(sessionIds, type, payload) {
  for (const clientId of sessionIds) {
    const session = clients.get(clientId);
    if (session) {
      sendToSession(session, type, payload);
    }
  }
}

function broadcastRoom(roomId, type, payload) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  broadcastToSessions(room.members, type, payload);
}

function broadcastParty(party, type, payload) {
  broadcastToSessions(party.members.keys(), type, payload);
}

function deleteRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.members.size > 0) {
    return;
  }

  rooms.delete(roomId);
}

function createRoom(options) {
  const roomId = sanitizeId(options.roomId, createId('room'));
  const room = {
    id: roomId,
    name: sanitizeText(options.name, 40, 'Chat di gioco'),
    kind: options.kind || 'chat',
    ownerId: options.ownerId || null,
    isPrivate: Boolean(options.isPrivate),
    partyId: options.partyId || null,
    members: new Set(),
  };

  rooms.set(roomId, room);
  return room;
}

function joinRoom(session, room) {
  if (room.members.has(session.id)) {
    return room;
  }

  room.members.add(session.id);
  session.rooms.add(room.id);
  broadcastRoom(room.id, 'chat.room_updated', { room: roomSnapshot(room) });
  return room;
}

function leaveRoom(session, roomId, quiet = false) {
  const room = rooms.get(roomId);
  if (!room || !room.members.has(session.id)) {
    return;
  }

  room.members.delete(session.id);
  session.rooms.delete(roomId);

  if (!quiet && room.members.size > 0) {
    broadcastRoom(room.id, 'chat.room_updated', { room: roomSnapshot(room) });
  }

  deleteRoomIfEmpty(roomId);
}

function nextPartyLeader(party) {
  const iterator = party.members.keys();
  const next = iterator.next();
  return next.done ? null : next.value;
}

function createParty(session, payload) {
  const partyId = sanitizeId(payload.partyId, createId('party'));
  const roomId = `party:${partyId}`;
  const room = createRoom({
    roomId,
    name: `Party ${sanitizeText(payload.name, 40, 'Squadra')}`,
    kind: 'party',
    ownerId: session.id,
    partyId,
    isPrivate: true,
  });

  const party = {
    id: partyId,
    code: createPartyCode(),
    name: sanitizeText(payload.name, 40, 'Squadra'),
    leaderId: session.id,
    roomId: room.id,
    isOpen: payload.isOpen !== false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    sharedState: {
      status: 'idle',
      mapId: null,
      row: null,
      col: null,
      encounter: null,
    },
    members: new Map(),
  };

  parties.set(partyId, party);
  return party;
}

function upsertPartyMember(session, party, payload = {}) {
  const current = party.members.get(session.id) || {
    clientId: session.id,
    playerId: session.playerId,
    saveId: session.saveId,
    name: session.name,
    avatar: session.avatar,
    ready: false,
    role: session.id === party.leaderId ? 'leader' : 'member',
    level: null,
    hp: null,
    mapId: null,
    row: null,
    col: null,
    status: 'idle',
    meta: {},
  };

  const next = {
    ...current,
    playerId: session.playerId,
    saveId: session.saveId,
    name: session.name,
    avatar: session.avatar,
    ready: typeof payload.ready === 'boolean' ? payload.ready : current.ready,
    role: session.id === party.leaderId ? 'leader' : 'member',
    level: Number.isFinite(payload.level) ? payload.level : current.level,
    hp: Number.isFinite(payload.hp) ? payload.hp : current.hp,
    mapId: sanitizeId(payload.mapId, current.mapId),
    row: Number.isFinite(payload.row) ? payload.row : current.row,
    col: Number.isFinite(payload.col) ? payload.col : current.col,
    status: sanitizeText(payload.status, 30, current.status || 'idle'),
    meta: {
      ...current.meta,
      ...safePayload(payload.meta),
    },
  };

  party.members.set(session.id, next);
  party.updatedAt = nowIso();
  session.partyId = party.id;
  return next;
}

function joinParty(session, party, payload = {}) {
  if (session.partyId && session.partyId !== party.id) {
    throw new Error('Il client e gia in un altro party');
  }

  upsertPartyMember(session, party, payload);
  joinRoom(session, rooms.get(party.roomId));
  return party;
}

function closePartyIfEmpty(party) {
  if (party.members.size > 0) {
    return false;
  }

  parties.delete(party.id);
  rooms.delete(party.roomId);
  return true;
}

function leaveParty(session, reason = 'left') {
  if (!session.partyId) {
    return null;
  }

  const party = parties.get(session.partyId);
  session.partyId = null;

  if (!party) {
    return null;
  }

  party.members.delete(session.id);
  leaveRoom(session, party.roomId, true);

  if (closePartyIfEmpty(party)) {
    return null;
  }

  if (party.leaderId === session.id) {
    party.leaderId = nextPartyLeader(party);
    for (const member of party.members.values()) {
      member.role = member.clientId === party.leaderId ? 'leader' : 'member';
    }
  }

  party.updatedAt = nowIso();
  broadcastParty(party, 'party.updated', {
    party: partySnapshot(party),
    reason,
  });

  return party;
}

function listRooms() {
  return Array.from(rooms.values())
    .filter((room) => room.kind === 'chat' && !room.isPrivate)
    .map((room) => roomSnapshot(room));
}

function listParties() {
  return Array.from(parties.values())
    .filter((party) => party.isOpen)
    .map((party) => ({
      partyId: party.id,
      code: party.code,
      name: party.name,
      leaderId: party.leaderId,
      members: party.members.size,
      sharedState: party.sharedState,
      updatedAt: party.updatedAt,
    }));
}

function resolveParty(payload) {
  if (payload.partyId) {
    return parties.get(sanitizeId(payload.partyId));
  }

  if (payload.code) {
    const code = sanitizeText(payload.code, 12).toUpperCase();
    return Array.from(parties.values()).find((party) => party.code === code) || null;
  }

  return null;
}

function handleChatCreate(session, payload, requestId) {
  const room = createRoom({
    roomId: payload.roomId,
    name: payload.name,
    ownerId: session.id,
    isPrivate: Boolean(payload.isPrivate),
  });

  joinRoom(session, room);
  sendToSession(session, 'chat.room_joined', { room: roomSnapshot(room) }, requestId);
}

function handleChatJoin(session, payload, requestId) {
  const roomId = sanitizeId(payload.roomId);
  const room = rooms.get(roomId);

  if (!room) {
    sendError(session, 'room_not_found', 'Stanza chat non trovata', requestId, { roomId });
    return;
  }

  joinRoom(session, room);
  sendToSession(session, 'chat.room_joined', { room: roomSnapshot(room) }, requestId);
}

function handleChatLeave(session, payload, requestId) {
  const roomId = sanitizeId(payload.roomId);
  leaveRoom(session, roomId);
  sendToSession(session, 'chat.room_left', { roomId }, requestId);
}

function handleChatMessage(session, payload, requestId) {
  const roomId = sanitizeId(payload.roomId);
  const room = rooms.get(roomId);
  const text = sanitizeText(payload.text, MAX_CHAT_LENGTH);

  if (!room || !room.members.has(session.id)) {
    sendError(session, 'room_access_denied', 'Devi entrare nella stanza prima di inviare messaggi', requestId, { roomId });
    return;
  }

  if (!text) {
    sendError(session, 'invalid_message', 'Messaggio vuoto', requestId);
    return;
  }

  broadcastRoom(room.id, 'chat.message', {
    roomId: room.id,
    message: {
      id: createId('msg'),
      clientId: session.id,
      playerId: session.playerId,
      name: session.name,
      text,
      createdAt: nowIso(),
    },
  });
}

function handlePartyCreate(session, payload, requestId) {
  if (session.partyId) {
    sendError(session, 'party_conflict', 'Il client e gia in un party', requestId, { partyId: session.partyId });
    return;
  }

  const party = createParty(session, payload);
  joinParty(session, party, payload.member || {});
  sendToSession(session, 'party.joined', { party: partySnapshot(party) }, requestId);
}

function handlePartyJoin(session, payload, requestId) {
  const party = resolveParty(payload);
  if (!party) {
    sendError(session, 'party_not_found', 'Party non trovato', requestId);
    return;
  }

  if (!party.isOpen && !party.members.has(session.id)) {
    sendError(session, 'party_closed', 'Questo party e chiuso a nuovi ingressi', requestId, { partyId: party.id });
    return;
  }

  try {
    joinParty(session, party, payload.member || {});
  } catch (error) {
    sendError(session, 'party_conflict', error.message, requestId);
    return;
  }

  broadcastParty(party, 'party.updated', { party: partySnapshot(party) });
  sendToSession(session, 'party.joined', { party: partySnapshot(party) }, requestId);
}

function handlePartyLeave(session, requestId) {
  const previousPartyId = session.partyId;
  leaveParty(session);
  sendToSession(session, 'party.left', { partyId: previousPartyId }, requestId);
}

function handlePartyMemberState(session, payload, requestId) {
  const party = session.partyId ? parties.get(session.partyId) : null;
  if (!party) {
    sendError(session, 'party_required', 'Devi essere in un party', requestId);
    return;
  }

  upsertPartyMember(session, party, payload);
  broadcastParty(party, 'party.updated', { party: partySnapshot(party) });
  sendToSession(session, 'party.member_state_saved', { partyId: party.id }, requestId);
}

function handlePartyState(session, payload, requestId) {
  const party = session.partyId ? parties.get(session.partyId) : null;
  if (!party) {
    sendError(session, 'party_required', 'Devi essere in un party', requestId);
    return;
  }

  if (party.leaderId !== session.id) {
    sendError(session, 'party_leader_required', 'Solo il leader puo sincronizzare lo stato condiviso', requestId);
    return;
  }

  party.sharedState = {
    ...party.sharedState,
    ...safePayload(payload.state),
    updatedBy: session.id,
    updatedAt: nowIso(),
  };
  party.updatedAt = nowIso();

  broadcastParty(party, 'party.updated', {
    party: partySnapshot(party),
    patch: party.sharedState,
  });
  sendToSession(session, 'party.state_saved', { partyId: party.id }, requestId);
}

function handlePartyRelay(session, payload, requestId, relayType) {
  const party = session.partyId ? parties.get(session.partyId) : null;
  if (!party) {
    sendError(session, 'party_required', 'Devi essere in un party', requestId);
    return;
  }

  const eventName = sanitizeText(payload.event || relayType, 40, relayType);
  const data = safePayload(payload.data);
  party.updatedAt = nowIso();

  broadcastParty(party, relayType, {
    partyId: party.id,
    from: publicClient(session),
    event: eventName,
    data,
    createdAt: nowIso(),
  });

  sendToSession(session, `${relayType}.sent`, { partyId: party.id, event: eventName }, requestId);
}

function handlePartyKick(session, payload, requestId) {
  const party = session.partyId ? parties.get(session.partyId) : null;
  if (!party) {
    sendError(session, 'party_required', 'Devi essere in un party', requestId);
    return;
  }

  if (party.leaderId !== session.id) {
    sendError(session, 'party_leader_required', 'Solo il leader puo espellere un membro', requestId);
    return;
  }

  const memberId = sanitizeId(payload.memberId);
  if (!memberId || memberId === session.id || !party.members.has(memberId)) {
    sendError(session, 'invalid_member', 'Membro non valido', requestId, { memberId });
    return;
  }

  const memberSession = clients.get(memberId);
  if (memberSession) {
    leaveParty(memberSession, 'kicked');
    sendToSession(memberSession, 'party.kicked', { partyId: party.id, by: session.id });
  } else {
    party.members.delete(memberId);
    party.updatedAt = nowIso();
  }

  broadcastParty(party, 'party.updated', { party: partySnapshot(party) });
  sendToSession(session, 'party.member_kicked', { partyId: party.id, memberId }, requestId);
}

function handlePartyOpen(session, payload, requestId) {
  const party = session.partyId ? parties.get(session.partyId) : null;
  if (!party) {
    sendError(session, 'party_required', 'Devi essere in un party', requestId);
    return;
  }

  if (party.leaderId !== session.id) {
    sendError(session, 'party_leader_required', 'Solo il leader puo aprire o chiudere il party', requestId);
    return;
  }

  party.isOpen = Boolean(payload.isOpen);
  party.updatedAt = nowIso();
  broadcastParty(party, 'party.updated', { party: partySnapshot(party) });
  sendToSession(session, 'party.visibility_saved', { partyId: party.id, isOpen: party.isOpen }, requestId);
}

function cleanupSession(session, reason = 'disconnect') {
  if (!clients.has(session.id)) {
    return;
  }

  leaveParty(session, reason);

  for (const roomId of Array.from(session.rooms)) {
    leaveRoom(session, roomId, true);
  }

  clients.delete(session.id);
  console.log(`[disconnect] ${session.id} (${session.name}) reason=${reason}`);
}

function handleMessage(session, rawMessage) {
  if (rawMessage.length > MAX_MESSAGE_SIZE) {
    sendError(session, 'payload_too_large', 'Payload troppo grande');
    return;
  }

  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch (error) {
    sendError(session, 'invalid_json', 'Payload JSON non valido');
    return;
  }

  const type = sanitizeText(message.type, 50);
  const requestId = sanitizeText(message.requestId, 60, null);
  const payload = safePayload(message.payload);

  if (!type) {
    sendError(session, 'missing_type', 'Campo type mancante', requestId);
    return;
  }

  switch (type) {
    case 'ping':
      sendToSession(session, 'pong', { uptimeMs: Math.round(process.uptime() * 1000) }, requestId);
      break;

    case 'identify':
      session.playerId = sanitizeId(payload.playerId, session.playerId);
      session.saveId = sanitizeText(payload.saveId, 80, session.saveId);
      session.name = sanitizeText(payload.name, 32, session.name || 'Giocatore');
      session.avatar = sanitizeText(payload.avatar, 120, session.avatar);
      session.meta = {
        ...session.meta,
        ...safePayload(payload.meta),
      };

      if (session.partyId && parties.has(session.partyId)) {
        const party = parties.get(session.partyId);
        upsertPartyMember(session, party, {});
        broadcastParty(party, 'party.updated', { party: partySnapshot(party) });
      }

      sendToSession(session, 'identify.saved', { client: publicClient(session) }, requestId);
      break;

    case 'chat.list':
      sendToSession(session, 'chat.rooms', { rooms: listRooms() }, requestId);
      break;

    case 'chat.create':
      handleChatCreate(session, payload, requestId);
      break;

    case 'chat.join':
      handleChatJoin(session, payload, requestId);
      break;

    case 'chat.leave':
      handleChatLeave(session, payload, requestId);
      break;

    case 'chat.message':
      handleChatMessage(session, payload, requestId);
      break;

    case 'party.list':
      sendToSession(session, 'party.listed', { parties: listParties() }, requestId);
      break;

    case 'party.create':
      handlePartyCreate(session, payload, requestId);
      break;

    case 'party.join':
      handlePartyJoin(session, payload, requestId);
      break;

    case 'party.leave':
      handlePartyLeave(session, requestId);
      break;

    case 'party.member_state':
      handlePartyMemberState(session, payload, requestId);
      break;

    case 'party.state':
      handlePartyState(session, payload, requestId);
      break;

    case 'party.explore':
      handlePartyRelay(session, payload, requestId, 'party.explore');
      break;

    case 'party.action':
      handlePartyRelay(session, payload, requestId, 'party.action');
      break;

    case 'party.kick':
      handlePartyKick(session, payload, requestId);
      break;

    case 'party.open':
      handlePartyOpen(session, payload, requestId);
      break;

    default:
      sendError(session, 'unknown_type', `Tipo messaggio non gestito: ${type}`, requestId);
      break;
  }
}

const server = http.createServer((req, res) => {
  const payload = {
    ok: true,
    service: 'kronofantasyparty',
    uptimeSec: Math.round(process.uptime()),
    clients: clients.size,
    publicRooms: listRooms().length,
    openParties: listParties().length,
    now: nowIso(),
  };

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin || '';
  if (!originAllowed(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  const session = {
    id: createId('cli'),
    ws,
    playerId: null,
    saveId: null,
    name: 'Giocatore',
    avatar: null,
    joinedAt: nowIso(),
    partyId: null,
    rooms: new Set(),
    meta: {},
    isAlive: true,
  };

  clients.set(session.id, session);
  console.log(`[connect] ${session.id} origin=${req.headers.origin || 'unknown'}`);

  sendToSession(session, 'session.welcome', {
    clientId: session.id,
    heartbeatMs: HEARTBEAT_MS,
    maxChatLength: MAX_CHAT_LENGTH,
    allowedOrigins: ALLOWED_ORIGINS,
  });

  ws.on('pong', () => {
    session.isAlive = true;
  });

  ws.on('message', (rawMessage, isBinary) => {
    if (isBinary) {
      sendError(session, 'binary_not_supported', 'I payload binari non sono supportati');
      return;
    }

    handleMessage(session, rawMessage);
  });

  ws.on('close', () => {
    cleanupSession(session, 'closed');
  });

  ws.on('error', (error) => {
    console.error(`[socket-error] ${session.id}`, error);
  });
});

const heartbeat = setInterval(() => {
  for (const session of clients.values()) {
    if (!session.isAlive) {
      session.ws.terminate();
      cleanupSession(session, 'heartbeat_timeout');
      continue;
    }

    session.isAlive = false;
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.ping();
    }
  }
}, HEARTBEAT_MS);

heartbeat.unref();

function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  clearInterval(heartbeat);

  for (const session of clients.values()) {
    sendToSession(session, 'server.shutdown', { signal });
    session.ws.close(1001, 'server shutdown');
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`Krono Fantasy Party listening on ${HOST}:${PORT}`);
});
