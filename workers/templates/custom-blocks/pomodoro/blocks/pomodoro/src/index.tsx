import "@notionhq/custom-blocks/nds.css"
import {
  NotionCustomBlock,
  NotionTokenScope,
} from "@notionhq/custom-blocks/react"
import { createRoot } from "react-dom/client"
import { Pomodoro } from "./Pomodoro"
import "./pomodoro.css"

const root = document.getElementById("root")
if (root === null) {
  throw new Error("Missing root")
}
createRoot(root).render(
  <NotionCustomBlock>
    <NotionTokenScope>
      <Pomodoro />
    </NotionTokenScope>
  </NotionCustomBlock>
)
