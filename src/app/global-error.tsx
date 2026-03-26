// Bilal Saeed 123
"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error caught:", error);
  }, [error]);

  return (
    <html>
      <body
        style={{
          background: "#0a0a0f",
          color: "#fff",
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          margin: 0,
          padding: "2rem",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div
            style={{
              fontSize: "4rem",
              marginBottom: "1rem",
              filter: "drop-shadow(0 0 20px rgba(255,68,0,0.5))",
            }}
          >
            ⚡
          </div>
          <h1
            style={{
              fontSize: "2rem",
              fontWeight: 900,
              marginBottom: "0.5rem",
              background: "linear-gradient(135deg, #ff4400, #00ccff)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Connection Lost
          </h1>
          <p
            style={{
              color: "#888",
              fontSize: "0.9rem",
              lineHeight: 1.6,
              marginBottom: "2rem",
            }}
          >
            Something unexpected happened. This could be a network issue or a
            temporary glitch.
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: "14px 36px",
              background: "linear-gradient(135deg, #ff4400, #ff6600)",
              border: "none",
              borderRadius: "12px",
              color: "#fff",
              fontWeight: 700,
              fontSize: "1rem",
              cursor: "pointer",
              boxShadow: "0 4px 20px rgba(255,68,0,0.3)",
              transition: "transform 0.2s",
            }}
            onMouseOver={(e) =>
              ((e.target as HTMLElement).style.transform = "scale(1.05)")
            }
            onMouseOut={(e) =>
              ((e.target as HTMLElement).style.transform = "scale(1)")
            }
          >
            Retry Connection
          </button>
        </div>
      </body>
    </html>
  );
}
// Bilal Saeed 123
