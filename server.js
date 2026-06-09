const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Serve the frontend interface file automatically when accessing the web link
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7, // Increases transfer limits to 10MB to accept photo snaps smoothly
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// MEMORY STORAGE (Acts as your local database)
let users = {};       // User files: { id: { name, pass, profilePic, convos: {} } }
let messages = { global: [] };    // Log logs: { roomId: [ { sid, sname, txt, img, time } ] }
let friendRequests = {};          // Map logs: { targetId: { senderId: { name } } }

io.on('connection', (socket) => {
    let authenticatedUser = null;

    // AUTHENTICATION LOOP
    socket.on('auth', ({ id, name, pass }) => {
        const userId = id.trim().toLowerCase();
        
        if (users[userId]) {
            if (users[userId].pass !== pass) {
                return socket.emit('auth-failure', 'Incorrect password for this Public ID.');
            }
        } else {
            // Register new user file
            users[userId] = { id: userId, name, pass, profilePic: '', convos: {} };
            friendRequests[userId] = {};
        }

        authenticatedUser = users[userId];
        socket.join('global'); // Everyone starts in Global Chat
        
        // Return profile configuration data and history back to client
        socket.emit('auth-success', {
            user: authenticatedUser,
            globalMessages: messages['global']
        });
        
        console.log(`👤 ${authenticatedUser.name} (@${userId}) is Online.`);
        updateUserLists(userId, socket);
    });

    // UPDATE PROFILE PICTURE
    socket.on('update-avatar', (base64Img) => {
        if (!authenticatedUser) return;
        users[authenticatedUser.id].profilePic = base64Img;
        socket.emit('avatar-updated', base64Img);
    });

    // SEND MESSAGES / PICTURE SNAPS
    socket.on('send-msg', ({ roomId, txt, img }) => {
        if (!authenticatedUser) return;

        const msgPacket = {
            sid: authenticatedUser.id,
            sname: authenticatedUser.name,
            txt: txt || null,
            img: img || null,
            time: Date.now()
        };

        if (!messages[roomId]) messages[roomId] = [];
        messages[roomId].push(msgPacket);

        // Broadcast directly to anyone listening in that chat channel
        io.to(roomId).listen ? io.to(roomId).emit('new-msg', msgPacket) : io.to(roomId).emit('new-msg', msgPacket);
    });

    // FRIEND REQUEST SYSTEM
    socket.on('friend-request', (targetId) => {
        if (!authenticatedUser) return;
        const tid = targetId.trim().toLowerCase();

        if (!users[tid]) return socket.emit('alert', 'User ID not found!');
        if (tid === authenticatedUser.id) return socket.emit('alert', 'You cannot add yourself!');

        friendRequests[tid][authenticatedUser.id] = { name: authenticatedUser.name };
        socket.emit('alert', 'Friend request sent!');
        
        // Notify target user if they are currently online
        io.to(tid).emit('sync-requests', friendRequests[tid]);
    });

    socket.on('accept-friend', ({ fid, fname }) => {
        if (!authenticatedUser) return;
        const myId = authenticatedUser.id;

        // Generate a standard room handle connecting both IDs together alphabetically
        const privateRoomId = [myId, fid].sort().join('_');

        users[myId].convos[privateRoomId] = { name: fname, type: 'private' };
        users[fid].convos[privateRoomId] = { name: authenticatedUser.name, type: 'private' };

        // Clean up request cache
        delete friendRequests[myId][fid];

        socket.join(privateRoomId);
        
        socket.emit('sync-all', { convos: users[myId].convos, requests: friendRequests[myId] });
        io.to(fid).emit('sync-remote-convo', { id: fid, convos: users[fid].convos });
    });

    // GROUP CREATION Mechanics
    socket.on('create-group', ({ gName, members }) => {
        if (!authenticatedUser) return;
        const groupId = 'group_' + Date.now();
        
        const allMembers = [authenticatedUser.id, ...members];
        allMembers.forEach(uid => {
            if (users[uid]) {
                users[uid].convos[groupId] = { name: gName, type: 'group' };
                io.to(uid).emit('sync-remote-convo', { id: uid, convos: users[uid].convos });
            }
        });
    });

    // REQUEST HISTORIC PACKAGE FOR A CHAT ROOM
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        if (!messages[roomId]) messages[roomId] = [];
        socket.emit('room-history', messages[roomId]);
    });

    socket.on('disconnect', () => {
        if (authenticatedUser) console.log(`❌ ${authenticatedUser.name} went offline.`);
    });
});

function updateUserLists(userId, socket) {
    socket.join(userId); // Personal room channel for receiving background requests
    socket.emit('sync-all', { convos: users[userId].convos, requests: friendRequests[userId] });
}

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 SNAPCHAT LOCAL ENGINE RUNNING: http://localhost:${PORT}`));
