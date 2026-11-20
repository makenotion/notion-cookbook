import { getNotionIconUrl } from "@notionhq/custom-blocks"
import { colors, type IconSelection } from "./selection"
import { CheckGlyph } from "./Glyphs"

type SelectionPreviewProps = {
  choice: IconSelection
  saved: IconSelection | undefined
  saving: boolean
  restoring: boolean
  error: string | undefined
  onApply: () => void
  onReset: () => void
}
export function SelectionPreview({
  choice,
  saved,
  saving,
  restoring,
  error,
  onApply,
  onReset,
}: SelectionPreviewProps) {
  return (
    <aside className="selection-card" aria-label="Current selection">
      <p className="eyebrow">YOUR SELECTION</p>
      <div className="selection-preview" data-color={choice.color}>
        <img
          src={getNotionIconUrl(choice)}
          width={88}
          height={88}
          alt={`${choice.name} in ${choice.color}`}
        />
      </div>
      <h2>{choice.name.replaceAll("-", " ")}</h2>
      <p className="selection-color">
        {colors.find((color) => color.value === choice.color)?.label}
      </p>
      <div className="page-preview">
        <img src={getNotionIconUrl(choice)} width={20} height={20} alt="" />
        <span>My next great idea</span>
      </div>
      <button
        type="button"
        className="apply"
        disabled={saving || restoring}
        onClick={onApply}
      >
        {saving
          ? "Saving…"
          : restoring
            ? "Reading saved icon…"
            : "Apply to this page"}
        <span aria-hidden="true">↗</span>
      </button>
      <button type="button" className="reset" onClick={onReset}>
        Reset selection to blue token
      </button>
      <p className="scope-note">
        Updates this block’s containing page.
        <br />
        This is a page icon, not a property icon.
      </p>
      <div className="save-status" role="status" aria-live="polite">
        {error ? (
          <span className="error">{error}</span>
        ) : saved ? (
          <>
            <CheckGlyph />
            <span>
              Saved{" "}
              <strong>
                {saved.name} · {saved.color}
              </strong>
              <small>Confirmed by reading the page from Notion</small>
            </span>
          </>
        ) : (
          <span>Previewing a native page icon</span>
        )}
      </div>
    </aside>
  )
}
