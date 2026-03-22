// Bilal Saeed xxxxx
"use client";

// IMPORTANT: This file uses JSX so it must stay as .tsx
// It also uses "use client" because icon JSX will be rendered in client components

export const GAMES = [
  {
    id: "fireboy-watergirl",
    name: "Neon Elements",
    subtitle: "Fire & Water",
    description:
      "A neon-styled cooperative platformer. Work with your partner to solve puzzles, avoid hazards, and reach the exit together.",
    category: "Co-op Puzzle",
    players: "2",
    color: "from-orange-500 to-cyan-500",
    bgColor: "rgba(249, 115, 22, 0.08)",
    borderColor: "rgba(249, 115, 22, 0.4)",
    icon: (
      <div className="w-full h-full flex items-center justify-center">
        <img
          src="/games/fireboy-watergirl/icon.png" 
          alt="Neon Elements"
          className="w-full h-full object-cover shadow-2xl"
        />
      </div>
    ),
    featured: true,
    available: true,
  },
];
// Bilal Saeed xxxxx
