const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Render's free-tier proxy (and most reverse proxies/load balancers) will
// close a connection it considers idle. Socket.IO's defaults (pingInterval
// 25s / pingTimeout 20s) are usually fine on a normal host, but on Render's
// free tier connections were dropping mid-chat — tightening the heartbeat
// keeps traffic flowing often enough that the proxy never sees the socket
// as idle, and detects a truly dead connection faster too.
const io = new Server(server, {
    pingInterval: 10000,  // ping every 10s instead of 25s
    pingTimeout: 5000,    // give up and mark disconnected after 5s of silence
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(express.static(path.join(__dirname, 'frontend')));

const users = new Map();           // socket.id -> { username, room }
const usernameToSocket = new Map(); // username -> socket.id (for DMs/lookups)
const rooms = new Set(['general', 'tech', 'random']);

const HISTORY_LIMIT = 20;
const roomHistory = new Map();     // room -> array of last N room messages
const dmHistory = new Map();       // dmKey -> array of last N DM messages
const reactions = new Map();       // messageId -> { emoji: Set(username) }

function getTime() {
    return new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function pushHistory(map, key, message) {
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    list.push(message);
    if (list.length > HISTORY_LIMIT) list.shift();
}

function dmKey(userA, userB) {
    return [userA, userB].sort().join('::');
}

function reactionSummary(messageId) {
    const data = reactions.get(messageId);
    if (!data) return {};
    const summary = {};
    for (const [emoji, userSet] of data.entries()) {
        if (userSet.size > 0) summary[emoji] = Array.from(userSet);
    }
    return summary;
}

function sendRoomUsers(room) {
    const roomUsers = Array.from(users.values())
        .filter(function(u) { return u.room === room; })
        .map(function(u) { return u.username; });

    io.to(room).emit('room_users', roomUsers);
}

io.on('connection', (socket) => {
    console.log('New connection: ' + socket.id);
    socket.emit('rooms_list', Array.from(rooms));

    socket.on('join', (data) => {
        const username = data.username;
        const room = data.room;

        // If this username already has an active connection (e.g. they just
        // reconnected after a dropped WebSocket — common on Render's free
        // tier), that old socket is stale. Clean it up instead of leaving a
        // ghost entry behind in the online-users list.
        const previousSocketId = usernameToSocket.get(username);
        const isReconnect = previousSocketId && previousSocketId !== socket.id;
        if (isReconnect) {
            users.delete(previousSocketId);
        }

        users.set(socket.id, { username, room });
        usernameToSocket.set(username, socket.id);
        socket.join(room);
        socket.join('user:' + username); // personal channel for DMs

        console.log(username + (isReconnect ? ' reconnected to room: ' : ' joined room: ') + room);

        // Only announce a genuine first-time join — not every reconnect,
        // or the chat would get spammed with "X joined" on every blip.
        if (!isReconnect) {
            io.to(room).emit('user_joined', {
                username: username,
                message: username + ' joined the chat',
                timestamp: getTime()
            });
        }

        // Send recent history for the room, with current reaction state attached
        const history = (roomHistory.get(room) || []).map(function(msg) {
            return Object.assign({}, msg, { reactions: reactionSummary(msg.id) });
        });
        socket.emit('room_history', { room: room, messages: history });

        sendRoomUsers(room);
    });

    socket.on('send_message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const messageData = {
            username: user.username,
            text: data.text,
            timestamp: getTime(),
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        };

        console.log('[' + user.room + '] ' + user.username + ': ' + data.text);

        pushHistory(roomHistory, user.room, messageData);
        io.to(user.room).emit('new_message', messageData);
    });

    // ── Private messaging ──
    socket.on('send_dm', (data) => {
        const sender = users.get(socket.id);
        if (!sender) return;

        const toUsername = data.to;
        if (!toUsername || toUsername === sender.username) return;

        const messageData = {
            from: sender.username,
            to: toUsername,
            text: data.text,
            timestamp: getTime(),
            id: 'dm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        };

        pushHistory(dmHistory, dmKey(sender.username, toUsername), messageData);

        // Deliver to recipient (if online) and echo back to sender
        io.to('user:' + toUsername).emit('new_dm', messageData);
        socket.emit('new_dm', messageData);
    });

    socket.on('get_dm_history', (data) => {
        const sender = users.get(socket.id);
        if (!sender) return;

        const withUsername = data.with;
        const key = dmKey(sender.username, withUsername);
        const history = (dmHistory.get(key) || []).map(function(msg) {
            return Object.assign({}, msg, { reactions: reactionSummary(msg.id) });
        });

        socket.emit('dm_history', { with: withUsername, messages: history });
    });

    // ── Emoji reactions ──
    socket.on('react_message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const messageId = data.messageId;
        const emoji = data.emoji;
        const scope = data.scope;          // 'room' or 'dm'
        const target = data.target;        // room name, or other username for dm

        if (!reactions.has(messageId)) reactions.set(messageId, new Map());
        const messageReactions = reactions.get(messageId);
        if (!messageReactions.has(emoji)) messageReactions.set(emoji, new Set());

        const userSet = messageReactions.get(emoji);
        if (userSet.has(user.username)) {
            userSet.delete(user.username); // toggle off
        } else {
            userSet.add(user.username);
        }

        const summary = reactionSummary(messageId);

        if (scope === 'dm') {
            const key = dmKey(user.username, target);
            const otherUser = key.split('::').find(function(u) { return u !== user.username; });
            io.to('user:' + user.username).emit('reaction_update', { messageId, reactions: summary });
            io.to('user:' + otherUser).emit('reaction_update', { messageId, reactions: summary });
        } else {
            io.to(target || user.room).emit('reaction_update', { messageId, reactions: summary });
        }
    });

    socket.on('typing', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        socket.to(user.room).emit('user_typing', {
            username: user.username,
            isTyping: data.isTyping
        });
    });

    socket.on('switch_room', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const oldRoom = user.room;
        const newRoom = data.newRoom;

        socket.leave(oldRoom);

        io.to(oldRoom).emit('user_left', {
            username: user.username,
            message: user.username + ' left the room',
            timestamp: getTime()
        });
        sendRoomUsers(oldRoom);

        user.room = newRoom;
        users.set(socket.id, user);
        socket.join(newRoom);

        io.to(newRoom).emit('user_joined', {
            username: user.username,
            message: user.username + ' joined the room',
            timestamp: getTime()
        });
        sendRoomUsers(newRoom);

        const history = (roomHistory.get(newRoom) || []).map(function(msg) {
            return Object.assign({}, msg, { reactions: reactionSummary(msg.id) });
        });
        socket.emit('room_history', { room: newRoom, messages: history });

        socket.emit('room_switched', { room: newRoom });
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);

        if (user) {
            console.log(user.username + ' disconnected');

            const disconnectedUsername = user.username;
            const disconnectedRoom = user.room;

            users.delete(socket.id);
            if (usernameToSocket.get(disconnectedUsername) === socket.id) {
                usernameToSocket.delete(disconnectedUsername);
            }
            sendRoomUsers(disconnectedRoom);

            // Wait a moment before announcing "left the chat" — if this was
            // just a brief connection drop (common on free-tier hosting),
            // the client will reconnect and re-join almost immediately, and
            // we don't want to spam the room with a false departure message.
            setTimeout(function() {
                const stillAway = usernameToSocket.get(disconnectedUsername) === undefined;
                if (stillAway) {
                    io.to(disconnectedRoom).emit('user_left', {
                        username: disconnectedUsername,
                        message: disconnectedUsername + ' left the chat',
                        timestamp: getTime()
                    });
                }
            }, 3000);
        }
    });

});

// Render (and most hosts) assign the port dynamically via process.env.PORT —
// hardcoding 3000 means the platform's router may not find the app at all,
// or only works by coincidence. Fall back to 3000 for local dev.
const PORT = process.env.PORT || 3000;

server.listen(PORT, function() {
    console.log('Chat Server running on port ' + PORT);
});
