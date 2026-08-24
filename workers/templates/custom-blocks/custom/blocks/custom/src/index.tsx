import "@notionhq/custom-blocks/nds.css"
import {
  NotionCustomBlock,
  NotionTokenScope,
} from "@notionhq/custom-blocks/react"
import ReactDOM from "react-dom/client"
import "./index.css"

function App() {
  return (
    <main aria-labelledby="starter-title">
      <section className="starter-card">
        <div className="starter-status">
          <span className="status-dot" aria-hidden="true" />
          Custom block
        </div>

        <div className="starter-heading">
          <span className="wave" aria-hidden="true">
            👋
          </span>
          <div>
            <h1 id="starter-title">Hello world</h1>
            <p>Your custom block is ready to edit.</p>
          </div>
        </div>

        <div className="next-step">
          <span>Next step</span>
          <p>
            Edit <code>index.tsx</code>, then deploy with{" "}
            <code>ntn workers deploy</code>.
          </p>
        </div>
      </section>
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

ReactDOM.createRoot(root).render(
  <NotionCustomBlock autoResize>
    <NotionTokenScope>
      <App />
    </NotionTokenScope>
  </NotionCustomBlock>
)
