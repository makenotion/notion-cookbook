import { defineConfig } from "vite"

// Discover all runtime dependencies before the iframe connects. A later
// dependency optimization reload would invalidate the dev shell's handshake.
export default defineConfig({
  base: "./",
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "@notionhq/custom-blocks",
      "@notionhq/custom-blocks/react",
      "@tanstack/react-virtual",
      "@dnd-kit/react",
    ],
  },
})
