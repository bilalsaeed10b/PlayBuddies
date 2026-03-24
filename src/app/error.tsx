// Bilal Saeed 123
"use client";

import { useEffect } from "react";
import { Gamepad2, AlertTriangle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // Log the error to an error reporting service
    console.error("App Error Boundary Caught:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-grid animate-grid-pulse opacity-20" />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full mix-blend-screen pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(239, 68, 68, 0.15) 0%, transparent 70%)",
        }}
      />

      <div className="relative z-10 glass p-8 md:p-12 rounded-3xl max-w-lg w-full text-center border border-error/20 shadow-2xl shadow-error/10">
        <div className="w-20 h-20 rounded-2xl bg-error/10 flex items-center justify-center mx-auto mb-6">
          <AlertTriangle size={40} className="text-error" />
        </div>
        
        <h1 className="text-3xl font-black text-white mb-2 font-[family-name:var(--font-display)]">
          Game Over <span className="text-error">(Glitch)</span>
        </h1>
        <p className="text-text-secondary mb-8 text-sm md:text-base">
          Something went wrong under the hood. Our server hamsters have been notified.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button
            onClick={() => reset()}
            className="btn-glow flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-error to-red-500 rounded-xl text-white font-bold transition-transform hover:scale-105 active:scale-95 shadow-xl shadow-error/20"
          >
            <RefreshCw size={18} /> Retry Connection
          </button>
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center justify-center gap-2 px-6 py-3 glass hover:bg-white/10 rounded-xl text-white font-bold transition-colors border border-white/10"
          >
            <Gamepad2 size={18} /> Return to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
// Bilal Saeed 123
