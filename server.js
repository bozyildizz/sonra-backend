const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3002;

/* =========================
   IN-MEMORY STATE
========================= */

let waiting = {
  M: [],
  F: [],
};

const users = new Map();
// socketId -> {
//   socketId,
//   gender,
//   photoBase64,
//   currentRoomId,
//   dmRoomId,
//   inQueue,
//   blocked
// }

const rooms = new Map();
// roomId -> {
//   roomId,
//   players: [{ socketId, gender, photoBase64, alive }],
//   round,
//   roundDuration,
//   timeLeft,
//   timer,
//   phase,
//   finalDecisions
// }

const dmRooms = new Map();
// dmRoomId -> {
//   dmRoomId,
//   users: [socketIdA, socketIdB],
//   activeCallId: string | null
// }

const activeCalls = new Map();
// callId -> {
//   callId,
//   roomId,
//   callerId,
//   calleeId,
//   type: 'audio' | 'video',
//   status: 'ringing' | 'accepted' | 'ended'
// }

/* =========================
   HELPERS
========================= */

const profanityList = ['küfür1', 'küfür2', 'argo1'];

function sanitizeMessage(text) {
  let out = String(text || '');
  for (const bad of profanityList) {
    const re = new RegExp(bad, 'gi');
    out = out.replace(re, '****');
  }
  return out;
}

function queueStats() {
  return {
    waiting: waiting.M.length + waiting.F.length,
    target: 3,
  };
}

function emitQueueCount() {
  io.emit('queue_count', queueStats());
}

function removeFromQueue(socketId) {
  waiting.M = waiting.M.filter((id) => id !== socketId);
  waiting.F = waiting.F.filter((id) => id !== socketId);

  const user = users.get(socketId);
  if (user) user.inQueue = false;
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function aliveMales(room) {
  return alivePlayers(room).filter((p) => p.gender === 'M');
}

function aliveFemale(room) {
  return alivePlayers(room).find((p) => p.gender === 'F');
}

function anonLabelFor(room, socketId) {
  const index = room.players.findIndex((p) => p.socketId === socketId);
  if (index === -1) return 'Anonim';
  return `Anonim ${String.fromCharCode(65 + index)}`;
}

function stopRoundTimer(room) {
  if (room?.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function getDMOtherUser(dmRoomId, socketId) {
  const dm = dmRooms.get(dmRoomId);
  if (!dm) return null;
  return dm.users.find((id) => id !== socketId) || null;
}

function cleanupCall(callId, reason = 'cleanup') {
  const call = activeCalls.get(callId);
  if (!call) return;

  const dm = dmRooms.get(call.roomId);
  if (dm && dm.activeCallId === callId) {
    dm.activeCallId = null;
  }

  activeCalls.delete(callId);
  console.log(`[CALL] cleaned: ${callId} (${reason})`);
}

function endCallAndNotify(callId, endedBySocketId = null, reason = 'ended') {
  const call = activeCalls.get(callId);
  if (!call) return;

  const { roomId, callerId, calleeId } = call;
  const targets = [callerId, calleeId].filter((id) => id && id !== endedBySocketId);

  for (const targetId of targets) {
    io.to(targetId).emit('call_ended', {
      roomId,
      callId,
      reason,
    });
  }

  cleanupCall(callId, reason);
}

function isSocketInRoom(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  return room.players.some((p) => p.socketId === socketId && p.alive);
}

function isSocketInDM(roomId, socketId) {
  const dm = dmRooms.get(roomId);
  if (!dm) return false;
  return dm.users.includes(socketId);
}

function sendPlayerHome(socketId, roomId, autoRequeue) {
  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.leave(roomId);
    socket.emit('return_home', {
      roomId,
      autoRequeue,
    });
  }

  const user = users.get(socketId);
  if (user) {
    user.currentRoomId = null;
  }
}

/* =========================
   MATCH / ROOM LOGIC
========================= */

function tryCreateRoom() {
  while (waiting.F.length >= 1 && waiting.M.length >= 2) {
    const femaleId = waiting.F.shift();
    const male1 = waiting.M.shift();
    const male2 = waiting.M.shift();

    const ids = [femaleId, male1, male2].filter(Boolean);
    if (ids.length !== 3) break;

    const players = ids
      .map((id) => users.get(id))
      .filter(Boolean)
      .map((u) => ({
        socketId: u.socketId,
        gender: u.gender,
        photoBase64: u.photoBase64 || '',
        alive: true,
      }));

    if (players.length !== 3) {
      emitQueueCount();
      continue;
    }

    const roomId = uuidv4();

    const room = {
      roomId,
      players,
      round: 1,
      roundDuration: 180,
      timeLeft: 180,
      timer: null,
      phase: 'chat',
      finalDecisions: {},
    };

    rooms.set(roomId, room);

    for (const p of players) {
      const user = users.get(p.socketId);
      if (!user) continue;
      user.currentRoomId = roomId;
      user.dmRoomId = null;
      user.inQueue = false;
      io.sockets.sockets.get(p.socketId)?.join(roomId);
    }

    console.log(`[ROOM] started: ${roomId} players=${players.map((p) => p.socketId).join(',')}`);

    io.to(roomId).emit('room_started', {
      roomId,
      playerCount: players.length,
      eliminationWait: 12,
      roundDuration: room.roundDuration,
    });

    startRoundTimer(roomId);
  }

  emitQueueCount();
}

function startRoundTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  stopRoundTimer(room);

  room.phase = 'chat';
  room.timeLeft = room.roundDuration;

  io.to(roomId).emit('timer', {
    roomId,
    round: room.round,
    time: room.timeLeft,
    duration: room.roundDuration,
  });

  room.timer = setInterval(() => {
    const current = rooms.get(roomId);
    if (!current) return;

    current.timeLeft -= 1;

    io.to(roomId).emit('timer', {
      roomId,
      round: current.round,
      time: current.timeLeft,
      duration: current.roundDuration,
    });

    if (current.timeLeft <= 0) {
      stopRoundTimer(current);
      beginElimination(roomId);
    }
  }, 1000);
}

function beginElimination(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const alive = alivePlayers(room);
  if (alive.length <= 2) {
    goFinal(roomId);
    return;
  }

  room.phase = 'choosing';

  const female = aliveFemale(room);
  if (!female) {
    randomEliminateMale(roomId);
    return;
  }

  const options = aliveMales(room).map((p) => ({
    id: p.socketId,
    gender: p.gender,
    anonLabel: anonLabelFor(room, p.socketId),
  }));

  io.to(female.socketId).emit('female_choose', {
    roomId,
    players: options,
  });

  setTimeout(() => {
    const current = rooms.get(roomId);
    if (!current || current.phase !== 'choosing') return;
    randomEliminateMale(roomId);
  }, 12000);
}

function eliminatePlayer(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const target = room.players.find((p) => p.socketId === socketId && p.alive);
  if (!target) return;

  const label = anonLabelFor(room, socketId);
  target.alive = false;
  room.phase = 'chat';

  const aliveCount = alivePlayers(room).length;

  io.to(roomId).emit('player_eliminated', {
    roomId,
    socketId,
    anonLabel: label,
    playerCount: aliveCount,
  });

  sendPlayerHome(socketId, roomId, true);

  if (aliveCount <= 2) {
    goFinal(roomId);
  } else {
    room.round += 1;
    startRoundTimer(roomId);
  }
}

function randomEliminateMale(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const males = aliveMales(room);
  if (!males.length) {
    goFinal(roomId);
    return;
  }

  const random = males[Math.floor(Math.random() * males.length)];
  eliminatePlayer(roomId, random.socketId);
}

function goFinal(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  stopRoundTimer(room);
  room.phase = 'final';

  const alive = alivePlayers(room);

  if (alive.length < 2) {
    io.to(roomId).emit('return_home', {
      roomId,
      autoRequeue: true,
    });

    for (const p of alive) {
      const user = users.get(p.socketId);
      if (user) user.currentRoomId = null;
    }

    rooms.delete(roomId);
    return;
  }

  if (alive.length > 2) {
    return;
  }

  const male = alive.find((p) => p.gender === 'M');
  const female = alive.find((p) => p.gender === 'F');

  if (!male || !female) {
    io.to(roomId).emit('return_home', {
      roomId,
      autoRequeue: true,
    });

    for (const p of alive) {
      const user = users.get(p.socketId);
      if (user) user.currentRoomId = null;
    }

    rooms.delete(roomId);
    return;
  }

  room.finalDecisions = {};

  console.log(`[FINAL] room=${roomId}`);

  io.to(roomId).emit('final_pair', {
    roomId,
    malePhoto: male.photoBase64,
    femalePhoto: female.photoBase64,
    maleName: 'Eşleşme',
    femaleName: 'Eşleşme',
  });
}

function startDM(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const alive = alivePlayers(room);
  if (alive.length !== 2) return;

  const dmRoomId = uuidv4();

  dmRooms.set(dmRoomId, {
    dmRoomId,
    users: alive.map((p) => p.socketId),
    activeCallId: null,
  });

  for (const p of alive) {
    const socket = io.sockets.sockets.get(p.socketId);
    socket?.leave(roomId);
    socket?.join(dmRoomId);

    const user = users.get(p.socketId);
    if (user) {
      user.dmRoomId = dmRoomId;
      user.currentRoomId = null;
    }
  }

  console.log(`[DM] started dmRoomId=${dmRoomId} users=${alive.map((p) => p.socketId).join(',')}`);

  io.to(roomId).emit('dm_started', {
    roomId: dmRoomId,
  });

  rooms.delete(roomId);
}

/* =========================
   SOCKET
========================= */

io.on('connection', (socket) => {
  console.log(`[SOCKET] connected ${socket.id}`);

  users.set(socket.id, {
    socketId: socket.id,
    gender: null,
    photoBase64: null,
    currentRoomId: null,
    dmRoomId: null,
    inQueue: false,
    blocked: false,
  });

  emitQueueCount();

  socket.on('join_queue', (payload = {}) => {
    const user = users.get(socket.id);
    if (!user) return;

    const gender = payload.gender;
    if (gender !== 'M' && gender !== 'F') return;

    removeFromQueue(socket.id);

    user.gender = gender;
    user.photoBase64 = payload.photoBase64 || '';
    user.inQueue = true;

    if (gender === 'F') waiting.F.push(socket.id);
    else waiting.M.push(socket.id);

    console.log(`[QUEUE] join ${socket.id} gender=${user.gender}`);

    emitQueueCount();
    tryCreateRoom();
  });

  socket.on('leave_queue', () => {
    console.log(`[QUEUE] leave ${socket.id}`);
    removeFromQueue(socket.id);
    emitQueueCount();
  });

  socket.on('chat_message', (payload = {}) => {
    const roomId = payload.roomId;
    const text = sanitizeMessage(payload.text || '').trim();
    if (!roomId || !text) return;

    const inClassicRoom = isSocketInRoom(roomId, socket.id);
    const inDM = isSocketInDM(roomId, socket.id);

    if (!inClassicRoom && !inDM) {
      return;
    }

    io.to(roomId).emit('chat_message', {
      roomId,
      socketId: socket.id,
      senderLabel: inDM ? 'Karşı taraf' : 'Anonim',
      text,
    });
  });

  socket.on('early_eliminate_request', (payload = {}) => {
    const room = rooms.get(payload.roomId);
    if (!room) return;

    const female = aliveFemale(room);
    if (!female || female.socketId !== socket.id) return;
    if (room.phase !== 'chat') return;

    console.log(`[ROOM] early eliminate requested room=${room.roomId} by=${socket.id}`);

    stopRoundTimer(room);
    beginElimination(room.roomId);
  });

  socket.on('female_eliminate', (payload = {}) => {
    const room = rooms.get(payload.roomId);
    if (!room) return;

    const female = aliveFemale(room);
    if (!female || female.socketId !== socket.id) return;
    if (room.phase !== 'choosing') return;

    console.log(`[ROOM] eliminate room=${room.roomId} target=${payload.target}`);

    eliminatePlayer(room.roomId, payload.target);
  });

  socket.on('final_choice', (payload = {}) => {
    const room = rooms.get(payload.roomId);
    if (!room) return;

    const alive = alivePlayers(room);
    if (!alive.some((p) => p.socketId === socket.id)) return;
    if (room.phase !== 'final') return;

    room.finalDecisions[socket.id] = !!payload.accept;

    const allAnswered = alive.every((p) => room.finalDecisions[p.socketId] !== undefined);
    if (!allAnswered) return;

    const accepted = alive.every((p) => room.finalDecisions[p.socketId] === true);

    console.log(`[FINAL] decisions room=${room.roomId} accepted=${accepted}`);

    if (accepted) {
      startDM(room.roomId);
    } else {
      io.to(room.roomId).emit('return_home', {
        roomId: room.roomId,
        autoRequeue: true,
      });

      for (const p of alive) {
        const user = users.get(p.socketId);
        if (user) user.currentRoomId = null;
      }

      rooms.delete(room.roomId);
    }
  });

  socket.on('leave_dm', (payload = {}) => {
    const dmRoomId = payload.roomId;
    const dm = dmRooms.get(dmRoomId);
    if (!dm) return;
    if (!dm.users.includes(socket.id)) return;

    console.log(`[DM] leave dmRoomId=${dmRoomId} by=${socket.id}`);

    if (dm.activeCallId) {
      endCallAndNotify(dm.activeCallId, socket.id, 'dm_left');
    }

    io.to(dmRoomId).emit('return_home', {
      roomId: dmRoomId,
      autoRequeue: false,
    });

    for (const sid of dm.users) {
      io.sockets.sockets.get(sid)?.leave(dmRoomId);
      const user = users.get(sid);
      if (user) user.dmRoomId = null;
    }

    dmRooms.delete(dmRoomId);
  });

  /* =========================
     CALL SIGNALING
  ========================= */

  socket.on('start_call', (payload = {}) => {
    const roomId = payload.roomId;
    const callId = payload.callId || uuidv4();
    const type = payload.type === 'video' ? 'video' : 'audio';

    const dm = dmRooms.get(roomId);
    if (!dm) {
      console.log(`[CALL] start rejected: no dm room roomId=${roomId}`);
      socket.emit('call_rejected', {
        roomId,
        callId,
        reason: 'dm_not_found',
      });
      return;
    }

    if (!dm.users.includes(socket.id)) {
      console.log(`[CALL] start rejected: socket not in dm room socket=${socket.id} roomId=${roomId}`);
      socket.emit('call_rejected', {
        roomId,
        callId,
        reason: 'not_in_dm',
      });
      return;
    }

    if (dm.activeCallId) {
      console.log(`[CALL] start rejected: room busy roomId=${roomId} activeCallId=${dm.activeCallId}`);
      socket.emit('call_rejected', {
        roomId,
        callId,
        reason: 'busy',
      });
      return;
    }

    const otherId = getDMOtherUser(roomId, socket.id);
    if (!otherId) {
      console.log(`[CALL] start rejected: other user not found roomId=${roomId}`);
      socket.emit('call_rejected', {
        roomId,
        callId,
        reason: 'peer_not_found',
      });
      return;
    }

    dm.activeCallId = callId;
    activeCalls.set(callId, {
      callId,
      roomId,
      callerId: socket.id,
      calleeId: otherId,
      type,
      status: 'ringing',
    });

    console.log(`[CALL] start roomId=${roomId} callId=${callId} from=${socket.id} to=${otherId} type=${type}`);

    io.to(otherId).emit('incoming_call', {
      roomId,
      callId,
      callerId: socket.id,
      callerLabel: 'Karşı taraf',
      type,
    });
  });

  socket.on('accept_call', (payload = {}) => {
    const { roomId, callId } = payload;
    const call = activeCalls.get(callId);
    if (!call || call.roomId !== roomId) return;
    if (call.calleeId !== socket.id) return;
    if (call.status !== 'ringing') return;

    call.status = 'accepted';

    console.log(`[CALL] accepted callId=${callId} by=${socket.id}`);

    io.to(call.callerId).emit('call_accepted', {
      roomId,
      callId,
    });
  });

  socket.on('reject_call', (payload = {}) => {
    const { roomId, callId } = payload;
    const call = activeCalls.get(callId);
    if (!call || call.roomId !== roomId) return;
    if (call.calleeId !== socket.id) return;

    console.log(`[CALL] rejected callId=${callId} by=${socket.id}`);

    io.to(call.callerId).emit('call_rejected', {
      roomId,
      callId,
      reason: 'rejected',
    });

    cleanupCall(callId, 'rejected');
  });

  socket.on('end_call', (payload = {}) => {
    const { roomId, callId } = payload;
    const call = activeCalls.get(callId);
    if (!call || call.roomId !== roomId) return;
    if (call.callerId !== socket.id && call.calleeId !== socket.id) return;

    console.log(`[CALL] ended callId=${callId} by=${socket.id}`);

    endCallAndNotify(callId, socket.id, 'manual_end');
  });

  socket.on('webrtc_offer', (payload = {}) => {
    const { roomId, callId } = payload;
    const call = activeCalls.get(callId);
    if (!call || call.roomId !== roomId) return;
    if (call.callerId !== socket.id) return;

    console.log(`[WEBRTC] offer callId=${callId} ${socket.id} -> ${call.calleeId}`);

    io.to(call.calleeId).emit('webrtc_offer', payload);
  });

  socket.on('webrtc_answer', (payload = {}) => {
    const { roomId, callId } = payload;
    const call = activeCalls.get(callId);
    if (!call || call.roomId !== roomId) return;
    if (call.calleeId !== socket.id) return;

    console.log(`[WEBRTC] answer callId=${callId} ${socket.id} -> ${call.callerId}`);

    io.to(call.callerId).emit('webrtc_answer', payload);
  });

  socket.on('webrtc_ice_candidate', (payload = {}) => {
    const { roomId, callId } = payload;
    const call = activeCalls.get(callId);
    if (!call || call.roomId !== roomId) return;
    if (call.callerId !== socket.id && call.calleeId !== socket.id) return;

    const targetId = call.callerId === socket.id ? call.calleeId : call.callerId;
    io.to(targetId).emit('webrtc_ice_candidate', payload);
  });

  socket.on('report_user', (payload = {}) => {
    console.log('[REPORT]', {
      by: socket.id,
      roomId: payload.roomId,
      target: payload.target,
      reason: payload.reason,
    });
  });

  socket.on('disconnect', () => {
    console.log(`[SOCKET] disconnected ${socket.id}`);

    removeFromQueue(socket.id);

    const user = users.get(socket.id);

    if (user?.currentRoomId) {
      const room = rooms.get(user.currentRoomId);
      if (room) {
        const player = room.players.find((p) => p.socketId === socket.id);
        if (player && player.alive) {
          const label = anonLabelFor(room, socket.id);
          player.alive = false;

          const aliveCount = alivePlayers(room).length;

          io.to(room.roomId).emit('player_eliminated', {
            roomId: room.roomId,
            socketId: socket.id,
            anonLabel: `${label} ayrıldı`,
            playerCount: aliveCount,
          });

          if (aliveCount <= 2) {
            goFinal(room.roomId);
          }
        }
      }
    }

    if (user?.dmRoomId) {
      const dm = dmRooms.get(user.dmRoomId);
      if (dm) {
        if (dm.activeCallId) {
          endCallAndNotify(dm.activeCallId, socket.id, 'disconnect');
        }

        io.to(user.dmRoomId).emit('return_home', {
          roomId: user.dmRoomId,
          autoRequeue: false,
        });

        for (const sid of dm.users) {
          const peerUser = users.get(sid);
          if (peerUser) peerUser.dmRoomId = null;
        }

        dmRooms.delete(user.dmRoomId);
      }
    }

    for (const [callId, call] of activeCalls.entries()) {
      if (call.callerId === socket.id || call.calleeId === socket.id) {
        endCallAndNotify(callId, socket.id, 'disconnect_cleanup');
      }
    }

    users.delete(socket.id);
    emitQueueCount();
  });
});

/* =========================
   HTTP
========================= */

app.get('/', (_, res) => {
  res.json({
    ok: true,
    app: 'SONRA backend running',
  });
});

app.get('/debug/state', (_, res) => {
  res.json({
    waiting,
    users: [...users.values()].map((u) => ({
      socketId: u.socketId,
      gender: u.gender,
      currentRoomId: u.currentRoomId,
      dmRoomId: u.dmRoomId,
      inQueue: u.inQueue,
    })),
    rooms: [...rooms.values()].map((r) => ({
      roomId: r.roomId,
      phase: r.phase,
      round: r.round,
      timeLeft: r.timeLeft,
      players: r.players.map((p) => ({
        socketId: p.socketId,
        gender: p.gender,
        alive: p.alive,
      })),
    })),
    dmRooms: [...dmRooms.values()],
    activeCalls: [...activeCalls.values()],
  });
});

server.listen(PORT, () => {
  console.log(`SONRA backend running on http://localhost:${PORT}`);
});