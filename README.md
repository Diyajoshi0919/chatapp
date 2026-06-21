# ChatApp

A real-time chat application built with Express and Socket.IO — rooms, private messaging, emoji reactions, typing indicators, and automatic reconnection handling.

## Features

- **Room-based chat** — join `general`, `tech`, or `random`, with switching between rooms on the fly
- **Message history** — last 20 messages per room (and per DM thread) are kept in memory and replayed when you join or reconnect
- **Private messaging (DMs)** — click any online user to open a 1:1 conversation panel
- **Emoji reactions** — react to any message, toggle on/off, with live updates pushed to everyone viewing that message
- **Typing indicators** — see when someone else in your room is typing
- **Online users list** — live-updated per room
- **Resilient reconnection** — handles dropped connections gracefully (common on free-tier hosts): silently rejoins on reconnect, avoids spamming "user left" messages for brief blips, and replaces stale sessions if the same username reconnects

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Frontend:** Vanilla HTML/CSS/JS (no build step required)

## Project Structure

```
chatapp/
├── server.js              # Express + Socket.IO server, all chat logic
├── package.json
├── package-lock.json
└── frontend/
    └── index.html          # Single-page chat client
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- npm

### Installation

```bash
git clone https://github.com/<your-username>/<repo-name>.git
cd <repo-name>
npm install
```

### Running locally

```bash
npm start
```

The app will be available at **http://localhost:3000**

### Running in development

```bash
node server.js
```

By default the server listens on port `3000`, or the value of the `PORT` environment variable if set (useful for hosting platforms like Render, Railway, etc.).

## How It Works

- On joining, the client picks a username and a room. The server tracks each connected socket's username/room in memory.
- Messages sent to a room are broadcast to everyone in that room via Socket.IO's room feature, and the last 20 are kept for history.
- DMs are delivered to a personal Socket.IO channel (`user:<username>`) so they reach a user regardless of which room they're currently in.
- Reactions are stored per message ID and summarized (emoji → list of usernames) before being pushed to clients.

> **Note:** All state (messages, reactions, online users) lives in memory and resets when the server restarts. There is currently no database — see [Future Improvements](#future-improvements) below.


