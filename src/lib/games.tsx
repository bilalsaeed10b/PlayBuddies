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
          src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/games/fireboy-watergirl/icon.png`} 
          alt="Neon Elements"
          className="w-full h-full object-cover shadow-2xl"
        />
      </div>
    ),
    featured: true,
    available: true,
  },
  {
    id: "fish-eat-fish",
    name: "Fish Eat Fish",
    subtitle: "Survival of the Fittest",
    description:
      "Grow your fish by eating smaller ones and avoiding predators in this vibrant underwater 2D survival game.",
    category: "Survival / Arcade",
    players: "1-8",
    color: "from-blue-500 to-emerald-500",
    bgColor: "rgba(59, 130, 246, 0.08)",
    borderColor: "rgba(59, 130, 246, 0.4)",
    icon: (
      <div className="w-full h-full flex items-center justify-center">
        <img
          src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/games/fish-eat-fish/assets/player_fish_body.png`} 
          alt="Fish Eat Fish"
          className="w-full h-full object-contain scale-110 drop-shadow-2xl"
        />
      </div>
    ),
    featured: true,
    available: true,
  },
];
// Bilal Saeed xxxxx
