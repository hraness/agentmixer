import { ImageResponse } from "next/og";

export const alt = "xcb — Excalibur. Your agents. Your terminal. Your edge.";
export const size = { height: 630, width: 1200 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#f8f7f4",
          color: "#1c1a18",
          display: "flex",
          flexDirection: "column",
          fontFamily: "serif",
          height: "100%",
          justifyContent: "space-between",
          padding: "72px 80px",
          width: "100%",
        }}
      >
        <div style={{ color: "#8a857e", fontSize: 28, letterSpacing: 2, textTransform: "uppercase" }}>
          xcb / Excalibur
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.1 }}>
            Your agents. Your terminal. Your edge.
          </div>
          <div style={{ color: "#4a463f", fontSize: 30, lineHeight: 1.35 }}>
            A local, composable workspace for coding agents.
          </div>
        </div>
        <div style={{ color: "#8a857e", fontSize: 26 }}>xcb.dev</div>
      </div>
    ),
    size,
  );
}
