import { customBlock, pages } from "@notionhq/custom-blocks"
import { useEffect, useState } from "react"
import { IconPicker, type IconSelection } from "./IconPicker"
import { colors } from "./selection"
import { SelectionPreview } from "./SelectionPreview"
import "./demo.css"

export function Demo() {
  const parent = customBlock.getPage()
  const pageId = parent.type === "page" ? parent.id : undefined
  const [choice, setChoice] = useState<IconSelection>({
    name: "token",
    color: "blue",
  })
  const [saved, setSaved] = useState<IconSelection>()
  const [restoring, setRestoring] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  useEffect(() => {
    let current = true
    async function restore() {
      try {
        if (!pageId) {
          throw new Error("Place this example inside an editable page.")
        }
        const result = await pages.get(pageId)
        if (result.status === "error") {
          throw new Error(result.error.message)
        }
        const stored = result.page.icon
        if (stored?.type === "icon") {
          const color = colors.find(
            (color) => color.value === stored.icon.color
          )
          if (color && current) {
            const restored = { name: stored.icon.name, color: color.value }
            setChoice(restored)
            setSaved(restored)
          }
        }
      } catch (error) {
        console.error("Demo page read failed", error)
        if (current) {
          setSaveError(
            error instanceof Error
              ? error.message
              : "Couldn't reload the demo page."
          )
        }
      } finally {
        if (current) {
          setRestoring(false)
        }
      }
    }
    void restore()
    return () => {
      current = false
    }
  }, [pageId])
  async function apply() {
    const applied = choice
    setSaving(true)
    setSaveError(undefined)
    try {
      if (!pageId) {
        throw new Error("Place this example inside an editable page.")
      }
      const result = await pages.get(pageId)
      if (result.status === "error") {
        throw new Error(result.error.message)
      }
      const update = await result.page.updateById({
        icon: { type: "icon", icon: applied },
      })
      if (update.status === "error") {
        throw new Error(update.error.message)
      }
      const read = await pages.get(pageId)
      if (read.status === "error") {
        throw new Error(read.error.message)
      }
      if (
        read.page.icon?.type !== "icon" ||
        read.page.icon.icon.name !== applied.name ||
        read.page.icon.icon.color !== applied.color
      ) {
        throw new Error("Saved icon did not match the selection")
      }
      setSaved(applied)
    } catch (error) {
      console.error("Demo page icon update failed", error)
      setSaveError(
        error instanceof Error
          ? error.message
          : "Couldn't save the icon. Try again."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <main className="studio">
      <header className="studio-heading">
        <p className="eyebrow">A LITTLE DETAIL. A LOT OF CHARACTER.</p>
        <h1>Make it your own.</h1>
        <p>
          Find a Notion icon, pick a color, and give your page a fresh look.
        </p>
      </header>
      <div className="workbench">
        <div className="picker-space">
          {restoring ? (
            <p role="status">Reading saved icon…</p>
          ) : (
            <IconPicker value={choice} onChange={setChoice} />
          )}
        </div>
        <SelectionPreview
          choice={choice}
          saved={saved}
          saving={saving}
          restoring={restoring}
          error={saveError}
          onApply={() => {
            void apply()
          }}
          onReset={() => setChoice({ name: "token", color: "blue" })}
        />
      </div>
      <footer className="studio-footer">
        <span className="live-dot" />
        Icon catalog, straight from Notion<span>Page icons · Live preview</span>
      </footer>
    </main>
  )
}
