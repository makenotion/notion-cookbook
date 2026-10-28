import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { chromium, expect } from "@playwright/test"

const receiptPath = process.env.LOCAL_NOTION_FIXTURE
if (!receiptPath)
	throw new Error(
		"Set LOCAL_NOTION_FIXTURE to a prepared local fixture receipt (see README)."
	)
const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
const origin = new URL(receipt.origin)
if (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1")
	throw new Error("Verification requires a local Notion origin")
const dir = process.env.EVIDENCE_DIR ?? "/tmp/collection-views-evidence"
await mkdir(dir, { recursive: true })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({
	viewport: { width: 1500, height: 1100 },
	recordVideo: { dir, size: { width: 1500, height: 1100 } },
})
const messages = []
await context.exposeBinding("observeSDK", (_source, message) =>
	messages.push(message)
)
await context.addInitScript(() => {
	window.addEventListener("message", (event) => {
		const message = event.data
		if (message && typeof message === "object")
			void window.observeSDK({
				type: message.type,
				status: message.status,
				mode: message.mode,
				pageId: message.pageId ?? message.page?.id,
				requestId: message.requestId,
			})
	})
})
const videoStart = Date.now()
const clips = []
let clipStart
function startClip(name) {
	clipStart = {
		name,
		start: Math.max(0, (Date.now() - videoStart) / 1000 - 0.1),
	}
}
function endClip() {
	if (!clipStart) throw new Error("No active video chapter")
	clips.push({ ...clipStart, end: (Date.now() - videoStart) / 1000 })
	clipStart = undefined
}
const page = await context.newPage()
page.setDefaultTimeout(60000)
const errors = []
const consoleErrors = []
page.on("console", (message) => {
	if (message.type() === "error")
		consoleErrors.push({ text: message.text(), url: message.location().url })
})
page.on("pageerror", (error) =>
	errors.push({ message: error.message, stack: error.stack })
)
const frame = page
	.frameLocator('iframe[title="Custom block"]')
	.frameLocator('iframe[title="Custom block bundle"]')
const report = {
	host: "Local Notion with deployed public SDK 0.2.24 through local custom-block relay",
	checks: [],
	persisted: [],
	peeks: [],
	virtualization: [],
	consoleErrors,
	errors,
}
async function go(view) {
	await page.goto(
		`${origin.origin}/${receipt.views[view].pageId.replaceAll("-", "")}`,
		{ waitUntil: "domcontentloaded" }
	)
	await expect(
		frame.getByRole("heading", { name: "Projects", exact: true })
	).toBeVisible({ timeout: 90000 })
	await expect(frame.locator("[data-item]").first()).toBeVisible({
		timeout: 90000,
	})
}
async function record(id) {
	return page.evaluate(
		async ({ id, spaceId }) => {
			const response = await fetch("/api/v3/syncRecordValuesMain", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requests: [{ pointer: { table: "block", id, spaceId }, version: -1 }],
				}),
			})
			if (!response.ok)
				throw new Error(`Record read failed: ${response.status}`)
			const data = await response.json()
			const record = data.recordMap.block[id].value
			if (record.role !== "editor" && record.role !== "reader")
				throw new Error("Record is not readable")
			return record.value
		},
		{ id, spaceId: receipt.spaceId }
	)
}
async function shot(name) {
	await page
		.locator('iframe[title="Custom block"]')
		.screenshot({ path: join(dir, name), animations: "disabled" })
}
async function menu(item) {
	await item.locator("summary[aria-label^='Actions for']").click()
}
async function edit(item, name) {
	await menu(item)
	await item.getByRole("button", { name: /^Edit / }).click()
	await frame.getByRole("textbox", { name: "Name", exact: true }).fill(name)
	await page.waitForTimeout(500)
	await frame.getByRole("button", { name: "Save project", exact: true }).click()
	await expect(frame.getByRole("dialog")).not.toBeVisible()
	await expect(item.locator(".item-title")).toHaveText(name, { timeout: 45000 })
	await page.waitForTimeout(400)
}
async function search(text) {
	if (!(await frame.getByRole("searchbox").count()))
		await frame
			.getByRole("button", { name: "Search projects", exact: true })
			.click()
	await frame.getByRole("searchbox").fill(text)
}
try {
	await page.goto(
		`${origin.origin}/__local/agent/login?email=${encodeURIComponent(receipt.email)}&redirect=%2F${receipt.views.table.pageId.replaceAll("-", "")}`,
		{ waitUntil: "domcontentloaded" }
	)
	await go("table")
	const first = frame.locator(".table-row").first()
	const id = await first.getAttribute("data-item")
	const original = await record(id)
	const name = (await first.locator(".item-title").innerText()).trim()
	startClip("Edit title through SDK")
	await edit(first, `${name} — verified`)
	await expect
		.poll(async () => (await record(id)).properties.title[0][0])
		.toBe(`${name} — verified`)
	const changed = await record(id)
	for (const [key, value] of Object.entries(original.properties))
		if (key !== "title")
			assert.deepEqual(
				changed.properties[key],
				value,
				`Editing title must preserve property ${key}`
			)
	report.persisted.push({
		kind: "edit",
		id,
		beforeVersion: original.version,
		afterVersion: changed.version,
	})
	await edit(frame.locator(`[data-item="${id}"]`), name)
	await expect
		.poll(async () => (await record(id)).properties.title[0][0])
		.toBe(name)

	endClip()
	startClip("Create project through SDK")
	await frame.getByRole("button", { name: "New project", exact: true }).click()
	const newName = `SDK verification ${Date.now()}`
	await frame.getByRole("textbox", { name: "Name", exact: true }).fill(newName)
	await frame
		.getByRole("dialog")
		.getByLabel("Stage", { exact: true })
		.selectOption("Done")
	await frame.getByRole("button", { name: "Save project", exact: true }).click()
	await expect(frame.getByRole("dialog")).not.toBeVisible()
	await search(newName)
	await expect(frame.locator("[data-item]")).toHaveCount(1)
	const createdId = await frame.locator("[data-item]").getAttribute("data-item")
	await expect
		.poll(async () => (await record(createdId)).properties.title[0][0])
		.toBe(newName)
	report.persisted.push({ kind: "create", id: createdId, name: newName })
	report.checks.push(
		"SDK create and title edit persist on server; untouched properties preserved"
	)
	console.log(
		"PASS create/edit and live subscription refresh",
		report.persisted
	)

	endClip()
	await go("board")
	startClip("Pointer drop and keyboard Move to")
	const backlog = frame.locator('[data-stage="Backlog"]')
	const progress = frame.locator('[data-stage="In progress"]')
	const card = backlog.locator("[data-item]").first()
	const movedId = await card.getAttribute("data-item")
	await card.hover()
	const from = await card.getByRole("button", { name: /^Drag / }).boundingBox()
	const to = await progress.boundingBox()
	assert(from && to)
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
	await page.mouse.down()
	await page.mouse.move(from.x + 16, from.y + 12, { steps: 8 })
	await page.waitForTimeout(300)
	await page.mouse.move(to.x + to.width / 2, to.y + 100, { steps: 25 })
	await page.waitForTimeout(300)
	const duringDragDOM = await frame.locator("[data-item]").count()
	assert(duringDragDOM < 60, "Board DOM remains bounded DURING drag")
	await page.mouse.up()
	await expect(progress.locator(`[data-item="${movedId}"]`)).toBeVisible()
	await expect
		.poll(
			async () =>
				(await record(movedId)).properties[receipt.propertyIds.stage][0][0]
		)
		.toBe("In progress")
	await page.waitForTimeout(700)
	await shot("board-after-pointer-move.png")
	await menu(progress.locator(`[data-item="${movedId}"]`))
	const move = progress
		.locator(`[data-item="${movedId}"]`)
		.getByRole("combobox")
	await move.focus()
	await move.press("d")
	await expect(
		frame.locator('[data-stage="Done"]').locator(`[data-item="${movedId}"]`)
	).toBeVisible()
	await expect
		.poll(
			async () =>
				(await record(movedId)).properties[receipt.propertyIds.stage][0][0]
		)
		.toBe("Done")
	await page.waitForTimeout(700)
	await shot("board-after-keyboard-move.png")
	endClip()
	await page.reload({ waitUntil: "domcontentloaded" })
	await expect(
		frame.locator('[data-stage="Done"]').locator(`[data-item="${movedId}"]`)
	).toBeVisible({ timeout: 90000 })
	await menu(frame.locator(`[data-item="${movedId}"]`))
	const restoreMove = frame
		.locator(`[data-item="${movedId}"]`)
		.getByRole("combobox")
	await restoreMove.focus()
	await restoreMove.press("b")
	await expect
		.poll(
			async () =>
				(await record(movedId)).properties[receipt.propertyIds.stage][0][0]
		)
		.toBe("Backlog")
	report.persisted.push({
		kind: "board pointer and keyboard moves",
		id: movedId,
		duringDragDOM,
		persistedAfterReload: true,
		restored: "Backlog",
	})
	report.checks.push(
		"Pointer drop and keyboard Move to persist through the SDK, server read, and page reload"
	)
	console.log("PASS pointer/keyboard Board moves and reload", {
		movedId,
		duringDragDOM,
	})

	await go("table")
	const separator = frame.getByRole("separator", {
		name: "Resize Name",
		exact: true,
	})
	await separator.focus()
	const oldWidth = Number(await separator.getAttribute("aria-valuenow"))
	await separator.press("ArrowRight")
	await expect(separator).toHaveAttribute(
		"aria-valuenow",
		String(oldWidth + 10)
	)
	await separator.press("ArrowLeft")
	await frame.locator('summary[aria-label="View options"]').click()
	await frame.getByRole("checkbox", { name: "Owner", exact: true }).uncheck()
	await expect(
		frame.getByRole("columnheader").filter({ hasText: "Owner" })
	).toHaveCount(0)
	await frame.getByRole("checkbox", { name: "Owner", exact: true }).check()
	await frame.locator('summary[aria-label="View options"]').click()
	report.checks.push("Keyboard column resize and property visibility controls")

	for (const mode of ["side_peek", "center_peek"]) {
		startClip(`Open ${mode} destination`)
		await frame.locator('summary[aria-label="View options"]').click()
		await frame
			.getByRole("combobox", { name: "Open pages in" })
			.selectOption(mode)
		await frame.locator('summary[aria-label="View options"]').click()
		await frame.locator(".item-title").first().click()
		const content = page
			.getByText(
				"This is seeded local page content for verifying that navigation reaches a real Notion page.",
				{ exact: true }
			)
			.first()
		await expect(content).toBeVisible({ timeout: 60000 })
		await page.waitForTimeout(900)
		await page.screenshot({ path: join(dir, `${mode}-destination.png`) })
		report.peeks.push({ mode, destinationLoaded: true })
		console.log("PASS real page destination", mode)
		endClip()
		await go("table")
		await expect(content).not.toBeVisible()
	}

	for (const view of ["table", "board", "gallery", "list", "feed"]) {
		await go(view)
		startClip(`${view}: scroll, appearance and responsive layout`)
		if (view === "feed") {
			await expect(frame.locator(".feed-byline").first()).not.toContainText(
				/Unknown author|Person [0-9a-f]{8}/
			)
			await expect(frame.locator(".feed-byline time").first()).toHaveAttribute(
				"datetime",
				/.+/
			)
		}
		await page.waitForTimeout(500)
		await shot(`custom-${view}.png`)
		await page.waitForTimeout(400)
		if (view === "table") {
			await frame.locator('summary[aria-label="Sort"]').click()
			await frame
				.getByRole("combobox", { name: "Sort property" })
				.selectOption("rating")
			await frame
				.getByRole("button", { name: "Sort descending", exact: true })
				.click()
			await expect(frame.locator(".table-row .rating").first()).toHaveText("5")
			await shot("table-sorted-rating.png")
			await frame
				.getByRole("combobox", { name: "Sort property" })
				.selectOption("name")
			await frame
				.getByRole("button", { name: "Sort ascending", exact: true })
				.click()
			await frame.locator('summary[aria-label="Sort"]').click()
			await expect(frame.locator(".table-row .item-title").first()).toHaveText(
				name
			)
		}
		const beforeIDs = await frame
			.locator("[data-item]")
			.evaluateAll((nodes) => nodes.map((node) => node.dataset.item))
		assert(
			beforeIDs.length > 0 && beforeIDs.length < 60,
			`${view}: initial virtual rows must be present and bounded`
		)
		const scroll = frame.locator(`[data-scroll="${view}"]`).first()
		await scroll.evaluate((node) => {
			node.scrollTop = node.scrollHeight
		})
		await expect
			.poll(() =>
				frame
					.locator("[data-item]")
					.evaluateAll((nodes) => nodes.map((node) => node.dataset.item))
			)
			.not.toEqual(beforeIDs)
		const afterDOM = await frame.locator("[data-item]").count()
		assert(afterDOM > 0 && afterDOM < 60)
		report.virtualization.push({ view, beforeDOM: beforeIDs.length, afterDOM })
		await page.waitForTimeout(300)
		await shot(`custom-${view}-scrolled.png`)
		await scroll.evaluate((node) => {
			node.scrollTop = 0
		})

		const light = await frame
			.locator(".nds")
			.evaluate((node) => getComputedStyle(node).backgroundColor)
		await page.emulateMedia({ colorScheme: "dark" })
		await expect(frame.locator(".nds")).toHaveAttribute(
			"data-display-mode",
			"dark",
			{ timeout: 10000 }
		)
		await expect
			.poll(() =>
				frame
					.locator(".nds")
					.evaluate((node) => getComputedStyle(node).backgroundColor)
			)
			.not.toBe(light)
		await page.waitForTimeout(400)
		await shot(`custom-${view}-dark.png`)
		await page.emulateMedia({ colorScheme: "light" })
		await expect(frame.locator(".nds")).toHaveAttribute(
			"data-display-mode",
			"light"
		)
		await page.setViewportSize({ width: 900, height: 1100 })
		await page.waitForTimeout(500)
		await shot(`custom-${view}-narrow.png`)
		if (view === "table") {
			const table = frame.getByRole("table", { name: "table projects" })
			await table.evaluate((node) => {
				node.scrollLeft = 450
			})
			const headerX = await frame
				.getByRole("columnheader")
				.filter({ hasText: "Due" })
				.evaluate((node) => node.getBoundingClientRect().x)
			const cellX = await frame
				.locator('.table-row [data-property="due"]')
				.first()
				.evaluate((node) => node.getBoundingClientRect().x)
			assert(
				Math.abs(headerX - cellX) < 1,
				"Narrow Table headers and cells share horizontal scrolling"
			)
			await shot("table-narrow-scrolled.png")
			await table.evaluate((node) => {
				node.scrollLeft = 0
			})
		}
		await page.waitForTimeout(400)
		await page.setViewportSize({ width: 1500, height: 1100 })
		endClip()
	}
	await writeFile(
		join(dir, "local-sdk-messages.json"),
		JSON.stringify(messages, null, 2)
	)
	report.checks.push(
		"All five local-Notion views captured in light, dark, and narrow layouts"
	)
	report.hostBaselineErrors = errors.filter(
		(error) =>
			error.message.startsWith(
				"Failed to load a required record: user_root,"
			) && error.stack?.includes("client-offline/helpers/offlineHelpers")
	)
	const unexpected = errors.filter(
		(error) => !report.hostBaselineErrors.includes(error)
	)
	assert.deepEqual(unexpected, [], "No unexpected browser exceptions")
	assert.deepEqual(
		consoleErrors.filter((error) =>
			error.url.includes("notion-custom.localhost")
		),
		[],
		"No custom-block console errors"
	)
	report.success = true
} catch (error) {
	report.success = false
	report.failure = String(error)
	await page.screenshot({
		path: join(dir, "local-verification-failure.png"),
		fullPage: true,
	})
	throw error
} finally {
	const webm = await page.video().path()
	await context.close()
	await browser.close()
	let videoFailure
	const result = spawnSync(
		"ffmpeg",
		[
			"-y",
			"-i",
			webm,
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			join(dir, "interactions-full.mp4"),
		],
		{ encoding: "utf8" }
	)
	await writeFile(join(dir, "local-ffmpeg.log"), result.stderr ?? "")
	await writeFile(
		join(dir, "video-chapters.json"),
		JSON.stringify(clips, null, 2)
	)
	if (result.status !== 0) videoFailure = "Full video transcode failed"
	if (report.success && !videoFailure) {
		const select = clips
			.map(
				(clip) => `between(t,${clip.start.toFixed(3)},${clip.end.toFixed(3)})`
			)
			.join("+")
		const cut = spawnSync(
			"ffmpeg",
			[
				"-y",
				"-i",
				webm,
				"-vf",
				`select='${select}',setpts=N/25/TB`,
				"-r",
				"25",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
				join(dir, "interactions.mp4"),
			],
			{ encoding: "utf8" }
		)
		await writeFile(join(dir, "video-cut.log"), cut.stderr ?? "")
		if (cut.status !== 0) videoFailure = "Video chapter edit failed"
	}
	report.video = {
		webm,
		mp4: join(dir, "interactions.mp4"),
		fullMp4: join(dir, "interactions-full.mp4"),
		transcoded: !videoFailure,
	}
	if (videoFailure) {
		report.success = false
		report.failure = videoFailure
	}
	await writeFile(
		join(dir, "local-results.json"),
		JSON.stringify(report, null, 2)
	)
	if (videoFailure) throw new Error(videoFailure)
}
console.log(JSON.stringify(report, null, 2))
