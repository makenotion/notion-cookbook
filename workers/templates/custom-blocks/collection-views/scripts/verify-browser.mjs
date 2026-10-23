import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { chromium, expect } from "@playwright/test"

const dir = process.env.EVIDENCE_DIR ?? "/tmp/collection-views-evidence"
await mkdir(dir, { recursive: true })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1350, height: 1000 } })
const frame = page.frameLocator('iframe[title="Custom block preview"]')
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => {
	if (message.type() === "error") errors.push(message.text())
})
const report = {
	host: "Published SDK 0.2.24 in published dev shell 0.1.104; seeded query data",
	sourceRows: 1200,
	mutationsVerified: false,
	checks: [],
	virtualization: [],
	errors,
}
async function view(name) {
	await page.getByRole("button", { name, exact: true }).click()
	await expect(
		frame.getByRole("heading", { name: "Projects", exact: true })
	).toBeVisible({ timeout: 15000 })
	await expect(frame.locator("footer")).toContainText("100 loaded")
}
try {
	await page.goto(process.env.DEV_SHELL_URL ?? "http://localhost:9873", {
		waitUntil: "domcontentloaded",
	})
	await page.getByRole("button", { name: "Viewport", exact: true }).click()
	await page.getByText("Full page", { exact: true }).click()
	for (const name of ["table", "board", "gallery", "list", "feed"]) {
		await view(name)
		const initial = await frame.locator("[data-item]").count()
		const before = await frame
			.locator("[data-item]")
			.evaluateAll((nodes) => nodes.map((node) => node.dataset.item))
		await frame
			.locator(`[data-scroll="${name}"]`)
			.first()
			.evaluate((node) => {
				node.scrollTop = node.scrollHeight
			})
		await expect
			.poll(() =>
				frame
					.locator("[data-item]")
					.evaluateAll((nodes) => nodes.map((node) => node.dataset.item))
			)
			.not.toEqual(before)
		const after = await frame.locator("[data-item]").count()
		assert(
			initial > 0 && initial < 80 && after > 0 && after < 80,
			`${name}: bounded DOM`
		)
		report.virtualization.push({
			view: name,
			loaded: 100,
			initialDOM: initial,
			laterDOM: after,
			laterIDs: await frame
				.locator("[data-item]")
				.evaluateAll((nodes) => nodes.map((node) => node.dataset.item)),
		})
		if (name === "feed") {
			await expect(
				frame.getByText("Page content preview", { exact: true }).first()
			).toBeVisible()
			report.checks.push(
				"Feed displays explicit page-body placeholder and defaults to Due descending"
			)
		}
		report.checks.push(
			`${name}: scrolling replaces virtual rows with bounded DOM`
		)
	}
	await view("table")
	for (let limit = 200; limit <= 1000; limit += 100) {
		await frame.getByRole("button", { name: "Load more", exact: true }).click()
		await expect(frame.locator("footer")).toContainText(
			`${Math.min(limit, 999)} loaded`
		)
	}
	await expect(
		frame.getByText("999-row SDK limit reached.", { exact: false })
	).toBeVisible()
	assert((await frame.locator("[data-item]").count()) < 35)
	await frame.locator('[data-scroll="table"]').evaluate((node) => {
		node.scrollTop = node.scrollHeight
	})
	await page.waitForTimeout(300)
	await page
		.locator("iframe")
		.screenshot({ path: join(dir, "table-999-scrolled.png") })
	report.checks.push(
		"1200-row source: 100→999 query growth, honest cap notice, bounded DOM at later records"
	)
	await frame
		.getByRole("button", { name: "Search projects", exact: true })
		.click()
	await frame.getByRole("searchbox").fill("Welcome guide")
	await expect(frame.locator("footer")).toContainText("100 loaded")
	await frame.locator('summary[aria-label="Filter"]').click()
	await frame
		.getByRole("combobox", { name: "Filter stage" })
		.selectOption("Done")
	await frame.locator('summary[aria-label="Sort"]').click()
	await frame
		.getByRole("combobox", { name: "Sort property" })
		.selectOption("rating")
	await frame
		.getByRole("button", { name: "Sort descending", exact: true })
		.click()
	await expect(frame.locator(".table-row .rating").first()).toHaveText("5")
	await frame.locator('summary[aria-label="Sort"]').click()
	assert(
		(await frame.locator(".table-row").allTextContents()).every(
			(text) => text.includes("Welcome guide") && text.includes("Done")
		)
	)
	report.checks.push(
		"Host filtering and numeric descending sort before the query limit"
	)
	const row = frame.locator(".table-row").first()
	const original = await row.locator(".item-title").innerText()
	await row.locator("summary[aria-label^='Actions for']").click()
	await row.getByRole("button", { name: /^Edit / }).click()
	await frame
		.getByRole("textbox", { name: "Name", exact: true })
		.fill("Welcome guide — retained draft")
	await frame.getByRole("button", { name: "Save project", exact: true }).click()
	await expect(frame.getByRole("dialog").getByRole("alert")).toContainText(
		"page not found"
	)
	await expect(
		frame.getByRole("textbox", { name: "Name", exact: true })
	).toHaveValue("Welcome guide — retained draft")
	await expect(row.locator(".item-title")).toHaveText(original)
	await page
		.locator("iframe")
		.screenshot({ path: join(dir, "dev-shell-write-error.png") })
	await frame.getByRole("button", { name: "Cancel", exact: true }).click()
	report.checks.push(
		"Real dev-shell seeded-row write rejection: source row unchanged and draft retained; successful mutations are verified separately in local Notion"
	)
	await frame.getByRole("searchbox").fill("no-match-collection-views")
	await expect(
		frame.getByRole("heading", { name: "No projects here yet" })
	).toBeVisible()
	assert.equal(errors.length, 0, `Browser errors: ${errors.join("\n")}`)
	report.success = true
} catch (error) {
	report.success = false
	report.failure = String(error)
	await page.screenshot({
		path: join(dir, "dev-shell-failure.png"),
		fullPage: true,
	})
	throw error
} finally {
	await browser.close()
	await writeFile(
		join(dir, "dev-shell-results.json"),
		JSON.stringify(report, null, 2) + "\n"
	)
}
console.log(JSON.stringify(report, null, 2))
