import "@notionhq/custom-blocks/nds.css"
import {
  NotionCustomBlock,
  NotionTokenScope,
} from "@notionhq/custom-blocks/react"
import { createRoot } from "react-dom/client"
import { Demo } from "./Demo"
import "./demo.css"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Missing icon picker root")
}
createRoot(root).render(
  <NotionCustomBlock>
    <NotionTokenScope>
      <Demo />
    </NotionTokenScope>
  </NotionCustomBlock>
)
