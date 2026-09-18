import {
  createSocialImageResponse,
  socialImageContentType as contentType,
  socialImageSize as size,
} from "@hraness/web-discovery/social-image";

export const alt = "xcb — Excalibur. Your agents. Your terminal. Your edge.";
export { contentType, size };

function XcbMark() {
  return (
    <svg aria-label="xcb mark" fill="none" height="42" role="img" viewBox="0 0 42 42" width="42">
      <path d="M8 8l26 26M34 8 8 34" stroke="currentColor" strokeLinecap="round" strokeWidth="4" />
      <circle cx="21" cy="21" fill="none" r="17" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export default function OpengraphImage() {
  return createSocialImageResponse({
    description: "A local, composable workspace for coding agents.",
    domain: "xcb.dev",
    eyebrow: "xcb / Excalibur",
    mark: <XcbMark />,
    theme: {
      accent: "#8A5A28",
      background: "#F8F7F4",
      foreground: "#1C1A18",
      muted: "#6A655E",
    },
    title: "Your agents. Your terminal. Your edge.",
  });
}
