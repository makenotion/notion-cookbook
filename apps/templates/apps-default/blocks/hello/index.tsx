import React from "react";
import { createRoot } from "react-dom/client";
import { NotionCustomBlock } from "@notionhq/apps/react";
import "@notionhq/apps/nds.css";

function Hello() {
  const [count, setCount] = React.useState(0);
  return <main style={{ padding: 16 }}><h2>Hello from your app</h2><button onClick={() => setCount(count + 1)}>Clicked {count} times</button></main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<NotionCustomBlock><Hello /></NotionCustomBlock>);
