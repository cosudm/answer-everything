// Headless browser smoke test of the first vertical slice.
// Usage: node test/e2e-smoke.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/ae/shots";
mkdirSync(out, { recursive: true });
const base = process.env.WEB_URL ?? "http://localhost:3000";
const stamp = Date.now().toString(36);
const email = `smoke-${stamp}@example.com`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const step = async (name, fn) => {
  const started = Date.now();
  await fn();
  console.log(`✓ ${name} (${Date.now() - started} ms)`);
};

await step("register", async () => {
  await page.goto(`${base}/register`);
  await page.getByLabel("Name").fill("Smoke Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a long and sturdy passphrase");
  await page.screenshot({ path: `${out}/01-register.png` });
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(`${base}/`);
  await page.getByRole("heading", { name: "What do you want to know?" }).waitFor();
  await page.screenshot({ path: `${out}/02-home.png` });
});

await step("add knowledge note", async () => {
  await page.goto(`${base}/knowledge`);
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("Contractor policy memo");
  await page
    .getByLabel("Content")
    .fill(
      "# Contractor policy\n\nThe revised contractor policy took effect in March 2024 and applies to all independent contractors engaged by the company. Contractors must complete security awareness training within 30 days of onboarding.\n\n## Penalties\n\nPenalties for late training completion are assessed quarterly by the finance team and deducted from the next invoice.",
    );
  await page.getByRole("button", { name: "Save note" }).click();
  await page.getByText("Contractor policy memo", { exact: true }).waitFor();
  // Wait for the worker to index it (status pill turns "ready").
  await page.getByText("ready", { exact: true }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${out}/03-knowledge.png` });
});

await step("ask from home and stream an answer", async () => {
  await page.goto(`${base}/`);
  const box = page.getByLabel("Your question");
  await box.fill("When did the contractor policy take effect, and who assesses penalties?");
  await page.screenshot({ path: `${out}/04-home-composer.png` });
  await box.press("Enter");
  await page.waitForURL(/\/ask\//);
  await page.getByText("Local development model (stub)").first().waitFor({ timeout: 30_000 });
  await page.getByText(/source[s]? cited/).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${out}/05-answer.png` });
});

await step("inspect the context panel", async () => {
  await page.getByRole("tab", { name: /Evidence/ }).click();
  await page.getByText("sourced", { exact: true }).first().waitFor();
  await page.screenshot({ path: `${out}/06-evidence.png` });
  await page.getByRole("tab", { name: "Answer path" }).click();
  await page.getByText("Answer recorded").waitFor();
  await page.screenshot({ path: `${out}/07-answer-path.png` });
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByText("Estimated cost").waitFor();
  await page.getByRole("tab", { name: /Sources/ }).click();
  await page.locator("a.cite").first().click();
  await page.screenshot({ path: `${out}/08-sources.png` });
});

await step("follow-up question in the same conversation", async () => {
  const box = page.getByLabel("Your question");
  await box.fill("REFUSE_TEST");
  await box.press("Enter");
  await page.getByText("The selected provider declined this request.").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Try another approved model" }).waitFor();
  await page.screenshot({ path: `${out}/09-provider-restricted.png` });
});

await step("models page", async () => {
  await page.goto(`${base}/models`);
  await page.getByText("Local Development Model (stub)").waitFor();
  await page.screenshot({ path: `${out}/10-models.png` });
  await page.getByText("Local Development Model (stub)").click();
  await page.getByText("No evaluation runs recorded").waitFor();
  await page.screenshot({ path: `${out}/11-model-detail.png` });
});

await step("settings", async () => {
  await page.goto(`${base}/settings`);
  await page.getByText("Usage this month").waitFor();
  await page.screenshot({ path: `${out}/12-settings.png` });
});

await step("mobile layout", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "What do you want to know?" }).waitFor();
  await page.screenshot({ path: `${out}/13-mobile-home.png` });
});

await browser.close();
if (errors.length) {
  console.log("\nBrowser errors:");
  for (const e of errors) console.log("  " + e);
  process.exitCode = 1;
} else {
  console.log("\nNo browser errors.");
}
