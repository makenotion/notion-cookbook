import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { notionCustomBlock } from "@notionhq/custom-blocks/vite"

export default defineConfig({
  plugins: [react(), notionCustomBlock()],
})
