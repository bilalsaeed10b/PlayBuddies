# PlayBuddies — Complete Product Requirements & Technical Architecture

**Author:** Bilal Saeed  
**Project Name:** PlayBuddies  
**Type:** Real-time Web Multiplayer Gaming Platform  
**Version:** 1.0  
**Last Updated:** March 22, 2026  

---

## 1. Project Overview

**PlayBuddies** is a premium web-based multiplayer gaming platform where users log in with their Google account, browse an arcade of 8–10 curated mini-games, invite friends via shareable room codes or links, and play together in real-time. The platform prioritizes low-latency gameplay, modular game architecture, and a stunning modern UI.

### 1.1 Core Value Proposition
- **Instant Play** — No downloads, no installs. Log in and play in seconds.
- **Social First** — Every game is built around playing with friends.
- **Curated Arcade** — 8-10 polished mini-games, each with multiplayer support.
- **Cross-Device** — Desktop + mobile responsive dashboard and lobbies.

### 1.2 Target Audience
- Casual gamers (ages 13–30) who want quick, fun games to play with friends.
- Groups of friends looking for browser-based party games.
- Users who want a "game night" platform without installing anything.

---

## 2. Technology Stack (Recommended Best-in-Class)

### 2.1 Frontend
| Layer | Technology | Rationale |
|---|---|---|
| **Framework** | **Next.js 14+ (App Router)** | Server-side rendering, file-based routing, optimized for Vercel deployment, excellent DX |
| **Language** | **TypeScript** | Type safety across the entire codebase, catches bugs at compile time |
| **State Management** | **Zustand** | Lightweight, minimal boilerplate, perfect for game state |
| **Styling** | **Tailwind CSS v4** | Rapid UI development, consistent design tokens, utility-first |
| **Animations** | **Framer Motion (motion/react)** | Smooth page transitions, micro-interactions, game-quality animations |
| **Icons** | **Lucide React** | Consistent, tree-shakeable icon set |
| **Real-time Client** | **Socket.IO Client** | Established WebSocket library with auto-reconnect, fallbacks |

### 2.2 Backend
| Layer | Technology | Rationale |
|---|---|---|
| **Runtime** | **Node.js 20+ (LTS)** | Async-first, massive ecosystem, perfect for real-time |
| **Framework** | **Express.js** | Minimal, battle-tested HTTP framework |
| **Real-time Engine** | **Socket.IO v4** | Room-based architecture, built-in reconnection, binary support |
| **Process Manager** | **PM2** | Zero-downtime restarts, clustering, log management |
| **Scaling** | **Redis Adapter for Socket.IO** | Horizontal scaling across multiple Node processes |

### 2.3 Authentication & Database
| Layer | Technology | Rationale |
|---|---|---|
| **Auth** | **Firebase Authentication** | Google OAuth out-of-the-box, free tier generous, battle-tested |
| **Database** | **Firebase Firestore** | Real-time listeners, offline support, flexible NoSQL schema |
| **Caching** | **Redis** | Session caching, rate limiting, Socket.IO adapter |

### 2.4 DevOps & Deployment
| Layer | Technology | Rationale |
|---|---|---|
| **Frontend Hosting** | **Vercel** | Native Next.js support, edge functions, global CDN |
| **Backend Hosting** | **Railway** or **Render** | Long-lived WebSocket support, easy scaling, auto-deploy |
| **CI/CD** | **GitHub Actions** | Automated testing, linting, deployment on push |
| **Monitoring** | **Sentry** | Error tracking, performance monitoring |
| **Analytics** | **Vercel Analytics** or **PostHog** | User behavior tracking, funnel analysis |

---

## 3. System Architecture

### 3.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐│
│  │  Next.js   │  │  Zustand   │  │  Socket.IO │  │  Firebase  ││
│  │  App Router│  │  Store     │  │  Client    │  │  Auth SDK  ││
│  └─────┬──────┘  └─────┬──────┘  └──────┬─────┘  └─────┬──────┘│
│        │               │                │               │       │
│  ┌─────┴───────────────┴────────────────┴───────────────┴──────┐│
│  │              Game Container (iframe / React Module)          ││
│  │              ↕ postMessage / props + socket events           ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTPS + WSS
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                      BACKEND SERVER (Node.js)                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐│
│  │  Express   │  │  Socket.IO │  │  Game      │  │  Auth      ││
│  │  REST API  │  │  Server    │  │  Managers  │  │  Middleware ││
│  └─────┬──────┘  └─────┬──────┘  └──────┬─────┘  └─────┬──────┘│
│        │               │                │               │       │
│  ┌─────┴───────────────┴────────────────┴───────────────┴──────┐│
│  │                     Redis (Pub/Sub + Cache)                  ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────┬───────────────┘
                           │                      │
                           ▼                      ▼
                    ┌─────────────┐        ┌─────────────┐
                    │  Firestore  │        │  Firebase   │
                    │  (Database) │        │  Auth       │
                    └─────────────┘        └─────────────┘
```

### 3.2 Directory Structure

```
PlayBuddies/
├── apps/
│   └── web/                        # Next.js frontend
│       ├── app/
│       │   ├── (auth)/
│       │   │   └── login/
│       │   │       └── page.tsx       # Login page
│       │   ├── (dashboard)/
│       │   │   ├── layout.tsx         # Protected layout
│       │   │   ├── page.tsx           # Game catalog dashboard
│       │   │   └── profile/
│       │   │       └── page.tsx       # User profile
│       │   ├── lobby/
│       │   │   └── [roomId]/
│       │   │       └── page.tsx       # Dynamic lobby page
│       │   ├── play/
│       │   │   └── [gameId]/
│       │   │       └── page.tsx       # Game container
│       │   ├── join/
│       │   │   └── [code]/
│       │   │       └── page.tsx       # Join via invite link
│       │   ├── layout.tsx             # Root layout
│       │   └── page.tsx               # Landing/hero page
│       ├── components/
│       │   ├── ui/                    # Design system components
│       │   ├── auth/                  # Auth-related components
│       │   ├── lobby/                 # Lobby UI components
│       │   ├── game/                  # Game container/overlay
│       │   └── shared/                # Shared components
│       ├── hooks/                     # Custom React hooks
│       ├── lib/                       # Utilities, configs
│       │   ├── firebase.ts            # Firebase init
│       │   ├── socket.ts              # Socket.IO client
│       │   └── api.ts                 # REST API client
│       ├── stores/                    # Zustand stores
│       │   ├── authStore.ts
│       │   ├── lobbyStore.ts
│       │   └── gameStore.ts
│       ├── public/
│       │   ├── logo.svg               # PlayBuddies logo
│       │   └── games/                 # Game thumbnails
│       ├── tailwind.config.ts
│       ├── next.config.ts
│       └── package.json
│
├── apps/
│   └── server/                     # Node.js backend
│       ├── src/
│       │   ├── index.ts               # Entry point
│       │   ├── config/
│       │   │   ├── firebase.ts        # Firebase Admin SDK
│       │   │   └── redis.ts           # Redis connection
│       │   ├── middleware/
│       │   │   ├── auth.ts            # JWT/Firebase token validation
│       │   │   └── rateLimit.ts       # Rate limiting
│       │   ├── routes/
│       │   │   ├── auth.ts            # Auth endpoints
│       │   │   ├── rooms.ts           # Room CRUD
│       │   │   └── users.ts           # User profile
│       │   ├── socket/
│       │   │   ├── index.ts           # Socket.IO initialization
│       │   │   ├── lobbyHandler.ts    # Lobby events
│       │   │   └── gameHandler.ts     # Game events
│       │   ├── managers/
│       │   │   ├── RoomManager.ts     # Room lifecycle
│       │   │   └── GameManager.ts     # Game state authority
│       │   └── types/
│       │       └── index.ts           # Shared types
│       ├── package.json
│       └── tsconfig.json
│
├── games/                          # Modular game modules
│   ├── fireboy-watergirl/             # Example: existing game
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   ├── game/
│   │   │   │   ├── engine.ts
│   │   │   │   ├── levels.ts
│   │   │   │   └── sounds.ts
│   │   │   ├── types.ts
│   │   │   └── firebase.ts
│   │   ├── metadata.json              # Game metadata
│   │   ├── server.ts                  # Game-specific server logic
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── tic-tac-toe/
│   ├── connect-four/
│   ├── snake-battle/
│   ├── pong-duel/
│   ├── trivia-showdown/
│   ├── drawing-guess/
│   ├── memory-match/
│   └── [game-name]/
│       └── metadata.json              # Standard metadata per game
│
├── packages/
│   └── shared/                     # Shared types & utilities
│       ├── types/
│       │   ├── game.ts                # IGameAdapter interface
│       │   ├── room.ts                # Room/Lobby types
│       │   └── user.ts                # User types
│       └── utils/
│           └── validation.ts
│
├── package.json                    # Root (monorepo)
├── turbo.json                      # Turborepo config (optional)
└── README.md
```

---

## 4. Authentication System 🔐

### 4.1 Flow

```
User opens PlayBuddies.com
        │
        ▼
  ┌──────────────┐         ┌──────────────┐
  │ Landing Page │──click──▶│ Google OAuth  │
  │ "Login with  │         │ Popup         │
  │  Google"     │         └──────┬────────┘
  └──────────────┘                │ success
                                  ▼
                         ┌────────────────┐
                         │ Firebase Auth   │
                         │ Creates Session │
                         └───────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
             ┌──────────┐            ┌──────────────┐
             │ NEW USER │            │ EXISTING USER│
             │ → Create │            │ → Load       │
             │   profile │            │   profile    │
             └────┬─────┘            └──────┬───────┘
                  │                         │
                  └─────────┬───────────────┘
                            ▼
                    ┌──────────────┐
                    │  Dashboard   │
                    │  (Game List) │
                    └──────────────┘
```

### 4.2 Stored User Data
```typescript
interface User {
  uid: string;                    // Firebase Auth UID
  displayName: string;            // From Google
  email: string;                  // From Google
  photoURL: string;               // Google profile picture
  createdAt: Timestamp;           // Account creation
  lastLoginAt: Timestamp;         // Last active
  stats: {
    gamesPlayed: number;
    wins: number;
    totalPlayTime: number;         // In minutes
    favoriteGame: string | null;
  };
  preferences: {
    theme: 'dark' | 'light';
    soundEnabled: boolean;
    notificationsEnabled: boolean;
  };
}
```

### 4.3 Security Rules
- All API routes (except landing page) require a valid Firebase ID token.
- Token is verified server-side using Firebase Admin SDK.
- Socket.IO connection requires token in handshake auth.

---

## 5. Backend System 🧠

### 5.1 REST API Endpoints

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `POST` | `/api/auth/verify` | Verify Firebase token, create/update user | Yes |
| `GET` | `/api/users/me` | Get current user profile + stats | Yes |
| `PUT` | `/api/users/me` | Update preferences | Yes |
| `POST` | `/api/rooms/create` | Create a new game room | Yes |
| `GET` | `/api/rooms/:code` | Get room info (exists? players? game?) | Yes |
| `GET` | `/api/games` | List all available games | No |
| `GET` | `/api/leaderboard/:gameId` | Get leaderboard for a game | No |

### 5.2 Socket.IO Event Architecture

#### Namespace: `/lobby`

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `lobby:create` | Client → Server | `{ gameId, maxPlayers }` | Host creates a room |
| `lobby:created` | Server → Client | `{ roomCode, inviteLink }` | Room created confirmation |
| `lobby:join` | Client → Server | `{ roomCode }` | Player joins room |
| `lobby:player_joined` | Server → Room | `{ player: LobbyPlayer }` | Broadcast new player |
| `lobby:player_left` | Server → Room | `{ playerId }` | Broadcast player left |
| `lobby:ready` | Client → Server | `{ ready: boolean }` | Toggle ready status |
| `lobby:ready_update` | Server → Room | `{ playerId, ready }` | Broadcast ready state |
| `lobby:start` | Client → Server | `{}` | Host starts the game |
| `lobby:game_starting` | Server → Room | `{ gameId, config }` | All players load game |
| `lobby:kick` | Client → Server | `{ playerId }` | Host kicks a player |
| `lobby:chat` | Client → Server | `{ message }` | Chat message |
| `lobby:chat_msg` | Server → Room | `{ player, message, ts }` | Broadcast chat |

#### Namespace: `/game`

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `game:player_input` | Client → Server | `{ inputType, data }` | Raw player input |
| `game:state_update` | Server → Room | `{ state }` | Authoritative game state |
| `game:player_action` | Server → Room | `{ playerId, action }` | Specific player action event |
| `game:pause` | Client → Server | `{}` | Request pause |
| `game:resume` | Client → Server | `{}` | Request resume |
| `game:end` | Server → Room | `{ results, stats }` | Game over, show results |
| `game:player_disconnect` | Server → Room | `{ playerId }` | Player dropped |
| `game:player_reconnect` | Client → Server | `{ roomCode }` | Reconnect to game |

### 5.3 Server Authority Model

The server is the **single source of truth** for all game state. This prevents cheating:

```
Client Input Flow:
  Player presses "Jump"
      │
      ▼
  Client sends:  { type: "jump", timestamp: 123456 }
      │
      ▼
  Server receives → validates → applies to authoritative game state
      │
      ▼
  Server broadcasts new state to ALL clients in room
      │
      ▼
  All clients render the NEW state (no local prediction for turn-based)
```

For real-time games (like Fireboy-Watergirl), the server:
1. Receives player inputs at ~60Hz
2. Runs the game physics tick (deterministic)
3. Broadcasts the authoritative state to all clients at 30-60 Hz
4. Clients interpolate between states for smooth rendering

---

## 6. Frontend System 🧩

### 6.1 Pages & Navigation

| Route | Page | Auth Required | Description |
|-------|------|---------------|-------------|
| `/` | Landing Page | No | Hero section, branding, CTA |
| `/login` | Login | No | Google OAuth button |
| `/dashboard` | Dashboard | Yes | Game catalog, online friends |
| `/lobby/[roomId]` | Lobby | Yes | Room management, player list |
| `/play/[gameId]` | Game | Yes | Game container + overlay HUD |
| `/join/[code]` | Join | Yes | Auto-join room from invite |
| `/profile` | Profile | Yes | Stats, match history, settings |
| `/leaderboard` | Leaderboard | No | Global rankings |

### 6.2 Landing Page Design
- **Hero Section**: Animated gradient background with floating game icons
- **Tagline**: "Your friends are waiting. Pick a game. Start playing."
- **CTA**: "Login with Google" — prominent, centered
- **Features Grid**: Quick highlights (Instant Play, 10 Games, Real-time, Free)
- **Game Preview Carousel**: Scrollable showcase of available games
- **Footer**: About, Privacy, Terms, Social links

### 6.3 Dashboard
- **Game Cards Grid** (3-4 columns on desktop, 1-2 on mobile)
  - Each card: Game thumbnail, name, description, player count, "Play" button
  - Hover: Subtle scale + glow effect
- **Sidebar**: Online friends list with status indicators
- **Top Bar**: User avatar, notifications bell, settings gear

### 6.4 Lobby System UI
- **Room Code Display** (large, copy-able): e.g. `A7X9BQ`
- **Shareable Invite Link**: `playbuddies.com/join/A7X9BQ`
- **Player Cards**: Avatar, name, ready status (green checkmark)
- **Chat Panel**: Real-time text chat within the lobby
- **Host Controls**: "Start Game" button (disabled until all ready), kick player
- **Game Settings**: Configurable options per game (e.g., rounds, difficulty)

---

## 7. Game Integration System 🎮

### 7.1 Game Module Architecture

Each game follows a **standardized adapter pattern**, inspired by the existing Fireboy-Watergirl structure:

```typescript

// packages/shared/types/game.ts

interface IGameAdapter {
  /** Unique game identifier */
  id: string;

  /** Initialize the game with socket connection and player data */
  init(config: GameInitConfig): void;

  /** Called when the server sends a state update */
  onStateUpdate(state: GameState): void;

  /** Called when a player joins/leaves mid-game */
  onPlayerChange(players: Player[]): void;

  /** Cleanup when game ends or player navigates away */
  destroy(): void;
}

interface GameInitConfig {
  socket: Socket;
  players: Player[];
  roomId: string;
  isHost: boolean;
  containerId: string;   // DOM element ID to render into
}

interface GameMetadata {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
  minPlayers: number;
  maxPlayers: number;
  category: 'puzzle' | 'action' | 'strategy' | 'trivia' | 'party';
  estimatedDuration: string;   // e.g., "5-10 min"
  controls: string;            // e.g., "WASD + Arrow Keys"
}

```

### 7.2 Game Loading Strategies

**Option A — React Component Module (Recommended)**
- Games are React components bundled into the main app
- Loaded via dynamic `import()` / `next/dynamic`
- Full access to shared state (Zustand), Socket.IO, and theme
- Example: The existing Fireboy-Watergirl game uses this approach (React + Canvas)

**Option B — Iframe Isolation**
- Games run in isolated `<iframe>` sandboxes
- Communication via `window.postMessage()` API
- Better for third-party or externally-sourced games
- Slightly higher latency, but better security isolation

**Hybrid Approach**: First-party games use Option A. Community/third-party games use Option B.

### 7.3 Game Metadata Standard (`metadata.json`)

Every game directory must contain a `metadata.json`:

```json
{
  "id": "fireboy-watergirl",
  "name": "Neon Elements: Fire & Water",
  "description": "A neon-styled cooperative multiplayer platformer.",
  "thumbnail": "/games/fireboy-watergirl/thumbnail.png",
  "minPlayers": 2,
  "maxPlayers": 2,
  "category": "puzzle",
  "estimatedDuration": "10-20 min",
  "controls": "Player 1: WASD | Player 2: Arrow Keys",
  "version": "1.0.0",
  "requestFramePermissions": []
}
```

### 7.4 Planned Game Roster (8-10 Games)

| # | Game | Category | Players | Description |
|---|------|----------|---------|-------------|
| 1 | **Neon Elements** (Fireboy & Watergirl) | Puzzle/Co-op | 2 | Cooperative platformer — solve puzzles together |
| 2 | **Tic-Tac-Toe** | Strategy | 2 | Classic grid battle with power-ups |
| 3 | **Connect Four** | Strategy | 2 | Drop pieces, connect 4 to win |
| 4 | **Snake Battle** | Action | 2-4 | Competitive snake arena |
| 5 | **Pong Duel** | Action | 2 | Modern neon pong with abilities |
| 6 | **Trivia Showdown** | Trivia | 2-8 | Fast-paced quiz battles |
| 7 | **Drawing & Guess** | Party | 3-8 | One draws, others guess (like Pictionary) |
| 8 | **Memory Match** | Puzzle | 2-4 | Competitive card-flipping memory game |
| 9 | **Word Scramble** | Trivia | 2-6 | Unscramble words faster than opponents |
| 10 | **Tank Wars** | Action | 2-4 | Turn-based artillery shooting game |

---

## 8. Multiplayer Lobby System 👥

### 8.1 Room Lifecycle

```
  CREATE                    LOBBY                     PLAYING                    ENDED
    │                        │                          │                         │
    │  Host creates room     │  Players join            │  Game in progress       │  Results shown
    │  Room code generated   │  Ready up                │  Real-time sync         │  XP awarded
    │  Invite link created   │  Host configures         │  Server authoritative   │  Return to lobby
    │                        │  Host clicks "Start"     │                         │  or dashboard
    │                        │                          │                         │
    ▼                        ▼                          ▼                         ▼
  [CREATED] ──────────▶ [WAITING] ──────────▶ [IN_GAME] ──────────▶ [COMPLETED]
                                                    │
                                                    │ disconnect?
                                                    ▼
                                              [PAUSED] (if co-op)
                                              [FORFEIT] (if competitive)
```

### 8.2 Room Data Model

```typescript
interface Room {
  code: string;               // 6-char alphanumeric (e.g., "A7X9BQ")
  gameId: string;             // Which game is selected
  hostId: string;             // UID of the room creator
  status: 'waiting' | 'in_game' | 'completed';
  players: Map<string, LobbyPlayer>;
  maxPlayers: number;         // Determined by game metadata
  settings: GameSettings;     // Game-specific configuration
  createdAt: Timestamp;
  expiresAt: Timestamp;       // Auto-cleanup after 2 hours
}

interface LobbyPlayer {
  uid: string;
  displayName: string;
  photoURL: string;
  ready: boolean;
  isHost: boolean;
  role?: string;              // Game-specific (e.g., "fire" | "water")
  joinedAt: Timestamp;
}
```

### 8.3 Invite System
- **Room Code**: 6-character alphanumeric (excluded ambiguous chars like O/0, I/1)
- **Invite Link**: `https://playbuddies.com/join/A7X9BQ`
- **Deep Link Flow**: If user is not logged in, redirect to login → then auto-join the room

---

## 9. Database Schema 💾

### 9.1 Firestore Collections

```
Firestore Root
│
├── users/{uid}
│   ├── displayName: string
│   ├── email: string
│   ├── photoURL: string
│   ├── createdAt: timestamp
│   ├── lastLoginAt: timestamp
│   ├── stats: {
│   │     gamesPlayed: number
│   │     wins: number
│   │     totalPlayTime: number
│   │     favoriteGame: string
│   │   }
│   └── preferences: {
│         theme: 'dark' | 'light'
│         soundEnabled: boolean
│       }
│
├── rooms/{roomCode}
│   ├── code: string
│   ├── gameId: string
│   ├── hostId: string
│   ├── status: string
│   ├── maxPlayers: number
│   ├── settings: map
│   ├── createdAt: timestamp
│   ├── expiresAt: timestamp
│   └── players/{uid}
│       ├── displayName: string
│       ├── photoURL: string
│       ├── ready: boolean
│       ├── isHost: boolean
│       └── role: string
│
├── matches/{matchId}
│   ├── gameId: string
│   ├── roomCode: string
│   ├── players: array<{ uid, displayName, score, placement }>
│   ├── winnerId: string | null
│   ├── duration: number (seconds)
│   ├── startedAt: timestamp
│   └── completedAt: timestamp
│
├── leaderboards/{gameId}
│   └── entries/{uid}
│       ├── displayName: string
│       ├── photoURL: string
│       ├── highScore: number
│       ├── wins: number
│       └── updatedAt: timestamp
│
└── games/{gameId}
    ├── name: string
    ├── description: string
    ├── thumbnail: string
    ├── minPlayers: number
    ├── maxPlayers: number
    ├── category: string
    └── featured: boolean
```

### 9.2 Firestore Security Rules (Abridged)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users can only read/write their own profile
    match /users/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == uid;
    }

    // Rooms are readable by anyone logged in
    match /rooms/{roomCode} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
      allow update: if request.auth != null
                    && request.auth.uid in resource.data.players;
    }

    // Matches are read-only for participants
    match /matches/{matchId} {
      allow read: if request.auth != null;
      allow write: if false;  // Server-only writes
    }

    // Leaderboards are public read, server-only write
    match /leaderboards/{gameId}/entries/{uid} {
      allow read: if true;
      allow write: if false;  // Server-only writes
    }
  }
}
```

---

## 10. Real-Time Sync & Networking ⚡

### 10.1 Latency Targets
| Metric | Target | Strategy |
|--------|--------|----------|
| **Input-to-screen delay** | < 100ms | Client-side prediction for movement games |
| **Server tick rate** | 30-60 Hz | Configurable per game type |
| **Reconnect time** | < 3 seconds | Socket.IO auto-reconnect with exponential backoff |
| **State sync** | < 50ms | Delta compression, only send changed state |

### 10.2 Optimization Techniques

1. **Delta State Updates** — Only send properties that changed since last tick.
2. **Client-Side Prediction** — For action games, predict movement locally, reconcile with server.
3. **Input Buffering** — Batch multiple inputs per frame before sending.
4. **Binary Protocol** — Use Socket.IO binary transport for game state (not JSON) in high-frequency games.
5. **Interpolation** — Smooth rendering between server ticks using linear interpolation.

### 10.3 Disconnect Handling

| Scenario | Action |
|----------|--------|
| Player disconnects (co-op game) | Pause game, wait 30s for reconnect |
| Player disconnects (competitive) | Continue with AI or forfeit after 15s |
| Host disconnects | Migrate host to next player |
| All players disconnect | Save state, destroy room after 5 min |
| Reconnection within timeout | Restore full game state |

---

## 11. Performance & Scalability Specifications 🚀

### 11.1 Performance Targets

| Metric | Launch Target | Scale Target |
|--------|---------------|--------------|
| **Concurrent Users** | 50-200 | 1,000+ |
| **Active Rooms** | 20-50 | 200+ |
| **Server Response Time** | < 50ms (p95) | < 100ms (p99) |
| **Page Load (LCP)** | < 2.5s | < 1.5s |
| **Bundle Size** | < 500KB (initial) | < 300KB (code-split) |
| **WebSocket Messages/sec** | 5,000 | 50,000 |

### 11.2 Scaling Strategy

1. **Phase 1 (Launch)**: Single Node.js instance on Railway (handles ~200 concurrent)
2. **Phase 2 (Growth)**: Redis adapter + 2-3 Node instances (handles ~1,000)
3. **Phase 3 (Scale)**: Kubernetes cluster + dedicated game servers + CDN edge caching

---

## 12. Security Requirements 🔒

### 12.1 Authentication Security
- Firebase ID tokens validated on **every** request (REST + WebSocket)
- Tokens expire after 1 hour; auto-refresh on client
- No sensitive data stored in localStorage (tokens only in memory/httpOnly cookies)

### 12.2 Game Security (Anti-Cheat)
- **Server is the authority**: Clients send inputs, NOT results
- **Input validation**: Server validates all player inputs (bounds checking, rate limiting)
- **State validation**: Server rejects impossible actions (e.g., teleporting)
- **Rate limiting**: Max 60 inputs/second per player per socket connection

### 12.3 Infrastructure Security
- **HTTPS everywhere** — SSL certificates via Vercel + Railway
- **WSS only** — No unencrypted WebSocket connections
- **CORS configured** — Only `playbuddies.com` origin allowed
- **Rate limiting** — Express rate-limiter on all REST endpoints
- **Helmet.js** — HTTP security headers
- **Input sanitization** — All user-generated content (chat, names) sanitized

---

## 13. UI/UX Design Guidelines 🎨

### 13.1 Design System

| Token | Value | Usage |
|-------|-------|-------|
| **Primary** | `#8B5CF6` (Purple) | Buttons, active states, accents |
| **Secondary** | `#3B82F6` (Blue) | Links, secondary actions |
| **Accent** | `#EC4899` (Pink) | Highlights, notifications |
| **Success** | `#10B981` (Green) | Ready status, online indicators |
| **Warning** | `#F59E0B` (Amber) | Alerts, pending states |
| **Error** | `#EF4444` (Red) | Error states, disconnect |
| **Background** | `#0F0F1A` (Dark Navy) | Main background |
| **Surface** | `#1A1A2E` (Dark Surface) | Cards, panels |
| **Text Primary** | `#F8FAFC` (White) | Headings |
| **Text Secondary** | `#94A3B8` (Gray) | Body text, labels |

### 13.2 Typography
- **Headings**: `Inter` or `Outfit` (from Google Fonts) — Bold, tight tracking
- **Body**: `Inter` — Clean, readable
- **Mono**: `JetBrains Mono` — Codes, room IDs, stats

### 13.3 Animations
- **Page transitions**: Framer Motion `AnimatePresence` with slide/fade (as used in Fireboy-Watergirl)
- **Hover effects**: Scale 1.02-1.05 + subtle glow
- **Loading states**: Skeleton screens with shimmer
- **Game cards**: 3D tilt effect on hover
- **Notifications**: Slide-in from top-right with spring physics

### 13.4 Responsive Breakpoints
| Device | Breakpoint | Layout |
|--------|-----------|--------|
| Mobile | < 768px | Single column, bottom nav |
| Tablet | 768-1024px | 2-column grid |
| Desktop | 1024-1440px | 3-column grid + sidebar |
| Wide | > 1440px | Max-width container centered |

---

## 14. Development Workflow

### 14.1 Monorepo Setup (Optional but Recommended)
```bash
# Using Turborepo
npx -y create-turbo@latest ./
```

Alternatively, a simpler two-package structure:
```bash
# Root package.json with workspaces
{
  "workspaces": ["apps/*", "packages/*", "games/*"]
}
```

### 14.2 Development Commands
```bash
npm run dev           # Start all services (frontend + backend + games)
npm run dev:web       # Start Next.js frontend only
npm run dev:server    # Start Node.js backend only
npm run build         # Build everything for production
npm run lint          # TypeScript + ESLint checks
npm run test          # Run test suite
```

### 14.3 Environment Variables

```env
# Firebase (Client)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase (Server - Admin SDK)
FIREBASE_SERVICE_ACCOUNT_KEY=

# Backend
BACKEND_URL=http://localhost:4000
SOCKET_URL=ws://localhost:4000

# Redis
REDIS_URL=redis://localhost:6379

# General
NODE_ENV=development
```

---

## 15. Testing Strategy

| Type | Tool | What to Test |
|------|------|-------------|
| **Unit Tests** | Jest / Vitest | Game logic, utility functions, state mutations |
| **Component Tests** | React Testing Library | UI components, auth flows |
| **Integration Tests** | Supertest + Socket.IO Client | API endpoints, socket events |
| **E2E Tests** | Playwright | Full user flows (login → play → results) |
| **Load Tests** | Artillery.io | WebSocket concurrency, server limits |

---

## 16. Future Roadmap 🚀

### Phase 2 (Post-Launch)
- 🎙️ **WebRTC Voice Chat** — In-lobby and in-game voice comms
- 🏆 **Global Leaderboards** — Cross-user competitive rankings per game
- 👥 **Friend System** — Add, remove, direct invite without room codes
- 🎨 **Custom Avatars** — Profile customization, banners, colors
- 📱 **PWA Support** — Install as app on mobile, push notifications

### Phase 3 (Growth)
- 🌐 **Game SDK** — Allow community developers to submit games
- 🎮 **Tournament Mode** — Bracket-style tournaments with prizes
- 💬 **In-game Chat** — Text chat overlay during gameplay
- 📊 **Analytics Dashboard** — Player engagement metrics, heatmaps
- 🌍 **i18n** — Multi-language support

---

## 17. Key Learnings from Existing Game (Fireboy-Watergirl)

From analyzing the existing codebase in `games/fireboy-watergirl/`:

### ✅ Patterns to Replicate Platform-Wide
1. **React + TypeScript + Vite** — Fast builds, type-safe, excellent DX
2. **Framer Motion animations** — Page transitions via `AnimatePresence`
3. **Socket.IO for multiplayer** — Room codes, join/create flows
4. **Canvas-based game rendering** — Performant, hardware-accelerated
5. **Modular game engine** — Separate `engine.ts`, `levels.ts`, `sounds.ts`
6. **Metadata file** — `metadata.json` describes the game
7. **Firebase integration** — Firestore for persistent state, Auth for identity
8. **Role-based multiplayer** — `fire` / `water` roles per player

### ⚠️ Platform Adjustments Needed
1. **Centralize auth** — Move from per-game Firebase init to platform-level
2. **Unified socket server** — One backend with game-specific namespaces
3. **Standardize game interface** — All games implement `IGameAdapter`
4. **Remove per-game servers** — Games should be pure client modules; server logic lives in the platform backend

---

*This document serves as the master blueprint for building PlayBuddies. Each section should be implemented incrementally, starting with auth → dashboard → lobby → game container → individual games.*
