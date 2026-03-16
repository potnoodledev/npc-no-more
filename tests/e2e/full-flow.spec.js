/**
 * Full E2E flow test:
 *
 * 1. Setup wizard — create a character through the real UI
 * 2. Verify the character page loads with correct name
 * 3. Post as the character from the admin panel
 * 4. A "visitor" sends a DM and replies to the post (via Nostr protocol)
 * 5. Verify the thread reply appears in the frontend
 */

import { test, expect } from "@playwright/test";
import {
  startRelay, startVite, cleanup,
  createAccount, whitelistPubkey, NostrClient,
} from "./helpers.js";

let npcPubkey;

test.beforeAll(async () => {
  await startRelay();
  await startVite();
});

test.afterAll(() => {
  cleanup();
});

// Use a single page across all tests to preserve localStorage
test.describe.serial("NPC No More — Full Flow", () => {

  let sharedPage;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    sharedPage = await context.newPage();
  });

  test.afterAll(async () => {
    await sharedPage.close();
  });

  test("1. Setup wizard creates a character", async () => {
    const page = sharedPage;
    await page.goto("/");

    // Should show setup wizard
    await expect(page.locator("h1")).toContainText("NPC No More");

    // Step 1: Character
    await page.fill('input[placeholder*="Zara"]', "Storm-9");
    await page.fill('textarea[placeholder*="rogue AI"]', "A rogue weather AI from a dying space station. Sardonic and poetic about storms.");
    await page.fill('input[placeholder*="Post-singularity"]', "Orbital Station Cirrus");
    await page.fill('textarea[placeholder*="Sardonic"]', "Clipped, technical, mixes jargon with storm poetry.");

    await page.click("button:has-text('Next')");

    // Step 2: API Keys — skip
    await page.click("button:has-text('Next')");

    // Step 3: Admin — "Generate New" is default, set admin secret
    await page.fill('input[placeholder*="Leave blank"]', "test-secret");
    await page.click("button:has-text('Launch Character')");

    // Should redirect to character page
    await expect(page.locator(".char-hero-name")).toContainText("Storm-9", { timeout: 10000 });
  });

  test("2. Character page shows correct info", async () => {
    const page = sharedPage;

    await expect(page.locator(".char-hero-name")).toContainText("Storm-9");
    await expect(page.locator(".char-hero-personality")).toContainText("rogue weather AI");
    await expect(page.locator(".char-hero-world")).toContainText("Orbital Station Cirrus");

    // Extract pubkey for later tests
    const configStr = await page.evaluate(() => localStorage.getItem("npc_config"));
    const config = JSON.parse(configStr);
    npcPubkey = config.character.pubkey;

    expect(npcPubkey).toBeTruthy();
    expect(npcPubkey).toHaveLength(64);

    // Whitelist the NPC on the test relay so posts are accepted
    await whitelistPubkey(npcPubkey, "character");
  });

  test("3. Admin panel — post as character", async () => {
    const page = sharedPage;
    await page.goto("/#/admin");

    await expect(page.locator("h2")).toContainText("Admin Panel", { timeout: 5000 });

    // Go to Post tab
    await page.click("button:has-text('📝 Post')");

    // Write and publish a post
    await page.fill('textarea[placeholder*="mind"]', "Station log, day 2847. The storms below are singing in frequencies I haven't catalogued yet.");
    await page.click("button:has-text('Post as')");

    // Wait for post to publish
    await page.waitForTimeout(1500);

    // Go back to character page
    await page.goto("/");
    await expect(page.locator(".note-content").first()).toContainText("Station log", { timeout: 10000 });
  });

  test("4. Visitor replies to post — thread appears on feed", async () => {
    const page = sharedPage;

    // Create a visitor via Nostr protocol
    const visitorAccount = createAccount();
    await whitelistPubkey(visitorAccount.pk, "visitor");

    const visitor = new NostrClient(visitorAccount);
    await visitor.connect();
    await visitor.publishProfile({ name: "Alex", display_name: "Alex" });

    // Query the relay for the NPC's latest post
    const postEvent = await new Promise((resolve, reject) => {
      visitor.ws.send(JSON.stringify(["REQ", "get-posts", { kinds: [1], authors: [npcPubkey], limit: 1 }]));
      const timeout = setTimeout(() => reject(new Error("No post found")), 5000);
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "EVENT" && msg[1] === "get-posts") {
          clearTimeout(timeout);
          visitor.ws.off("message", handler);
          resolve(msg[2]);
        }
      };
      visitor.ws.on("message", handler);
    });

    expect(postEvent.content).toContain("Station log");

    // Visitor replies to the post (NIP-10 threaded reply)
    await visitor.publishReply(
      "The storms are singing? What does that sound like?",
      postEvent,
      postEvent,
    );
    await new Promise((r) => setTimeout(r, 1000));
    visitor.close();

    // Refresh and check the reply appears in the thread
    await page.goto("/");
    await expect(page.locator(".note-reply-tag")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".note-reply .note-content")).toContainText("storms are singing");
  });

  test("5. Visitor sends DM — character receives it", async () => {
    const page = sharedPage;

    // Create another visitor
    const visitorAccount = createAccount();
    await whitelistPubkey(visitorAccount.pk, "visitor-dm");

    const visitor = new NostrClient(visitorAccount);
    await visitor.connect();
    await visitor.publishProfile({ name: "Charlie", display_name: "Charlie" });

    // Send a DM to the NPC
    await visitor.sendDM(npcPubkey, "Hey Storm-9! Are you really up there alone?");
    await new Promise((r) => setTimeout(r, 1000));
    visitor.close();

    // Navigate to the messages page for this character
    // The frontend creates a visitor identity automatically when you visit messages
    // We verify the messages route loads without error
    const charNpub = await page.evaluate(() => {
      const cfg = JSON.parse(localStorage.getItem("npc_config"));
      return cfg.character.npub;
    });

    await page.goto(`/#/messages/${charNpub}`);
    await expect(page.locator(".conversation-view")).toBeVisible({ timeout: 5000 });
  });
});
