import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
const siteUrl = process.env.FOSSA_TEST_BASE_URL ?? "";
const browserTest = test.skipIf(!siteUrl);
const catalog = { ready: true, slot: 100, programId: "11111111111111111111111111111111", market: "11111111111111111111111111111111", models: [] };
const member = { id: "opencode-ui-fixture", name: "Test", email: "", role: "user", loginMethod: "Wallet", chain: "evm", address: "0x1111111111111111111111111111111111111111", walletAddress: "11111111111111111111111111111111" };

browserTest("approval modal handles loading, retry and signed approval across screen sizes and themes", async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [320, 390, 768, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } }), failures: string[] = [];
      page.on("pageerror", error => failures.push(error.message));
      await page.emulateMedia({ colorScheme: width === 390 || width === 1440 ? "dark" : "light", reducedMotion: width === 320 ? "reduce" : "no-preference" });
      await page.addInitScript(address => { Object.assign(window, { ethereum: { isMetaMask: true, request: async ({ method }: { method: string }) => method === "eth_requestAccounts" || method === "eth_accounts" ? [address] : method === "personal_sign" ? "0xfixture-signature" : "0x1" } }); }, member.address);
      let challenged = false, approved = false, attempts = 0, loaded!: () => void, finish!: () => void;
      const loading = new Promise<void>(resolve => { loaded = resolve; }), approving = new Promise<void>(resolve => { finish = resolve; });
      const id = "c6cf3da8-65b3-4946-a4c9-1e6573d54b7f", fingerprint = "f".repeat(64);
      await page.routeWebSocket("**/api/v1/live", socket => socket.send(JSON.stringify({ type: "catalog", data: catalog })));
      await page.route("**/api/v1/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/me")) return route.fulfill({ json: { user: member, preferences: {}, csrfToken: "fixture-csrf" } });
        if (path.endsWith("/config")) return route.fulfill({ json: { browserSigning: false, walletConnectProjectId: "", solanaRpc: "https://rpc.test" } });
        if (path.endsWith(`/opencode/device/${id}`)) { if (width === 320) await loading; return route.fulfill({ json: { label: "OpenCode on this computer", fingerprint, code: "ABCDEF12", approved: false } }); }
        if (path.endsWith("/auth/challenge")) { const body = route.request().postDataJSON(); challenged = body.purpose === "opencode" && body.resource === fingerprint; return route.fulfill({ json: { id: "approval-fixture", message: "Install local wallet on this device" } }); }
        if (path.endsWith("/auth/verify")) return route.fulfill({ json: { authorization: "fixture-authorization" } });
        if (path.endsWith(`/opencode/device/${id}/approve`)) {
          attempts++;
          if (width === 768 && attempts === 1) return route.fulfill({ status: 503, json: { error: "Approval unavailable. Try again." } });
          if (width === 1024) await approving;
          approved = route.request().headers()["x-csrf-token"] === "fixture-csrf" && route.request().postDataJSON().authorization === "fixture-authorization"; return route.fulfill({ json: { ok: true } });
        }
        if (path.endsWith("/market/catalog")) return route.fulfill({ json: catalog });
        if (path.endsWith("/wallet")) return route.fulfill({ json: { balance: "0", walletAddress: member.walletAddress } });
        if (path.endsWith("/transfers")) return route.fulfill({ json: { transfers: [] } });
        if (path.endsWith("/market/funds")) return route.fulfill({ json: { free: "0", expired: "0", expiredBookings: 0 } });
        return route.fulfill({ json: {} });
      });
      await page.goto(`${siteUrl}/opencode?device=${id}`);
      const dialog = page.getByRole("dialog", { name: "Connect OpenCode" });
      await dialog.waitFor();
      if (width === 320) { await page.getByText("Loading connection", { exact: true }).waitFor(); expect(await dialog.locator(".deposit-footer-button").last().isDisabled()).toBe(true); loaded(); }
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      expect(await page.getByText("ABCDEF12", { exact: true }).isVisible()).toBe(true);
      await page.waitForFunction(() => { const rect = document.querySelector('[role="dialog"]')?.getBoundingClientRect(); return rect && Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 1 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 1; });
      expect(await dialog.locator(".deposit-methods-surface").count()).toBe(1);
      expect(await dialog.locator(".deposit-footer").count()).toBe(1);
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      if (width === 768) {
        await page.getByRole("alert").filter({ hasText: "Approval unavailable. Try again." }).waitFor();
        expect(await page.getByText("ABCDEF12", { exact: true }).isVisible()).toBe(true);
        await page.getByRole("button", { name: "Approve", exact: true }).click();
      }
      if (width === 1024) { await page.getByRole("button", { name: "Approving", exact: true }).waitFor(); expect(await page.getByRole("button", { name: "Approving", exact: true }).isDisabled()).toBe(true); finish(); }
      try { await page.getByRole("heading", { name: "OpenCode approved" }).waitFor({ timeout: 5000 }); }
      catch { throw Error(`Approval UI failed: ${await page.getByRole("alert").allTextContents()}; challenged=${challenged}; approved=${approved}`); }
      expect(challenged).toBe(true); expect(approved).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByRole("button", { name: "Done", exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForURL(`${siteUrl}/`);
      expect(failures).toEqual([]); await page.close();
    }
  } finally { await browser.close(); }
}, 45_000);

browserTest("expired approval stays safely disabled and signed-out approval returns through sign-in", async () => {
  const browser = await chromium.launch(), id = "c6cf3da8-65b3-4946-a4c9-1e6573d54b7f";
  try {
    for (const expired of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
      let submitted = false;
      await page.routeWebSocket("**/api/v1/live", socket => socket.send(JSON.stringify({ type: "catalog", data: catalog })));
      await page.route("**/api/v1/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/me")) return route.fulfill({ status: 401, json: { error: "Sign in required" } });
        if (path.endsWith("/config")) return route.fulfill({ json: { browserSigning: false, walletConnectProjectId: "", solanaRpc: "https://rpc.test" } });
        if (path.endsWith(`/opencode/device/${id}`)) return route.fulfill(expired ? { status: 404, json: { error: "Connection expired. Start again in OpenCode." } } : { json: { label: "OpenCode", code: "ABCDEF12", fingerprint: "f".repeat(64), approved: false } });
        if (path.endsWith("/approve")) submitted = true;
        if (path.endsWith("/market/catalog")) return route.fulfill({ json: catalog });
        return route.fulfill({ json: {} });
      });
      await page.goto(`${siteUrl}/opencode?device=${id}`);
      if (expired) {
        await page.getByRole("alert").filter({ hasText: "Connection expired." }).waitFor();
        expect(await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).isDisabled()).toBe(true);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.waitForURL(`${siteUrl}/`);
      } else {
        await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
        await page.waitForURL(url => url.pathname === "/auth");
        expect(new URL(page.url()).searchParams.get("next")).toBe(`/opencode?device=${id}`);
      }
      expect(submitted).toBe(false); await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);
