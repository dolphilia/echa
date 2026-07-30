import { expect, test, type Page } from "@playwright/test";

type VisualDifference = {
  affectedPixels: number;
  changedPixels: number;
  changedRatio: number;
  meanAbsoluteChannelDifference: number;
  maximumChannelDifference: number;
};
type DrawingMetrics = {
  provisionalMs: number[];
  canonicalMs: number[];
};

async function baseCanvasHash(page: Page): Promise<string> {
  return page.locator(".canvas-stage canvas").first().evaluate(async (canvas) => {
    const element = canvas as HTMLCanvasElement;
    const context = element.getContext("2d");
    if (!context) throw new Error("2D context is unavailable");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });
}

async function waitUntilConnected(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => (
      window as Window & {
        kogeBrowserRecoveryMetrics?: { status?: string };
      }
    ).kogeBrowserRecoveryMetrics?.status),
    { timeout: 15_000 },
  ).toBe("painted");
}

async function captureVisibleCanvas(page: Page): Promise<void> {
  await page.locator(".canvas-stage").evaluate((stage) => {
    const canvases = [...stage.querySelectorAll("canvas")];
    const snapshot = document.createElement("canvas");
    snapshot.width = 1000;
    snapshot.height = 1000;
    const context = snapshot.getContext("2d");
    if (!context) throw new Error("2D context is unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, snapshot.width, snapshot.height);
    for (const canvas of canvases) {
      context.save();
      context.globalAlpha = Number.parseFloat(getComputedStyle(canvas).opacity);
      context.drawImage(canvas, 0, 0);
      context.restore();
    }
    (window as Window & { kogeVisibleBeforeCanonical?: Uint8ClampedArray })
      .kogeVisibleBeforeCanonical = context.getImageData(
        0,
        0,
        snapshot.width,
        snapshot.height,
      ).data;
  });
}

async function canonicalVisualDifference(page: Page): Promise<VisualDifference> {
  return page.locator(".canvas-stage canvas").first().evaluate((canvas) => {
    const before = (
      window as Window & { kogeVisibleBeforeCanonical?: Uint8ClampedArray }
    ).kogeVisibleBeforeCanonical;
    const element = canvas as HTMLCanvasElement;
    const after = element.getContext("2d")?.getImageData(
      0,
      0,
      element.width,
      element.height,
    ).data;
    if (!before || !after) throw new Error("visual snapshots are unavailable");
    let affectedPixels = 0;
    let changedPixels = 0;
    let totalDifference = 0;
    let maximumChannelDifference = 0;
    for (let offset = 0; offset < after.length; offset += 4) {
      const affected = (
        before[offset] !== 255
        || before[offset + 1] !== 255
        || before[offset + 2] !== 255
        || after[offset] !== 255
        || after[offset + 1] !== 255
        || after[offset + 2] !== 255
      );
      if (!affected) continue;
      affectedPixels += 1;
      let changed = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(
          (before[offset + channel] ?? 0) - (after[offset + channel] ?? 0),
        );
        if (difference > 2) changed = true;
        totalDifference += difference;
        maximumChannelDifference = Math.max(maximumChannelDifference, difference);
      }
      if (changed) changedPixels += 1;
    }
    return {
      affectedPixels,
      changedPixels,
      changedRatio: changedPixels / affectedPixels,
      meanAbsoluteChannelDifference:
        totalDifference / Math.max(1, affectedPixels * 3),
      maximumChannelDifference,
    };
  });
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  )] ?? 0;
}

test("two clients converge and a reloaded client recovers the same canvas", async ({
  browser,
}) => {
  const roomId = `room-e2e-${Date.now()}`;
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const path = `/?sync=1&room=${roomId}`;

  await Promise.all([first.goto(path), second.goto(path)]);
  await Promise.all([waitUntilConnected(first), waitUntilConnected(second)]);
  const emptyHash = await baseCanvasHash(first);

  await first.locator(".brush-rail input[type=range]").nth(1).fill("35");
  const drawingSurface = first.locator(".canvas-stage canvas").last();
  await expect(drawingSurface).toHaveJSProperty("width", 1000);
  await expect(drawingSurface).toHaveJSProperty("height", 1000);
  const box = await drawingSurface.boundingBox();
  expect(box).not.toBeNull();
  await first.mouse.move(box!.x + 280, box!.y + 250);
  await first.mouse.down();
  await first.mouse.move(box!.x + 430, box!.y + 320, { steps: 12 });
  await first.mouse.move(box!.x + 560, box!.y + 260, { steps: 12 });
  await captureVisibleCanvas(first);
  await first.mouse.up();

  await expect.poll(() => baseCanvasHash(first), { timeout: 10_000 })
    .not.toBe(emptyHash);
  const acceptedHash = await baseCanvasHash(first);
  const visualDifference = await canonicalVisualDifference(first);
  expect(visualDifference.affectedPixels).toBeGreaterThan(0);
  expect(visualDifference.meanAbsoluteChannelDifference).toBeLessThan(40);
  await expect.poll(() => baseCanvasHash(second), { timeout: 10_000 })
    .toBe(acceptedHash);

  const metrics = await first.evaluate(() => (
    window as Window & { kogeDrawingMetrics?: DrawingMetrics }
  ).kogeDrawingMetrics);
  expect(metrics).toBeDefined();
  expect(metrics!.provisionalMs.length).toBeGreaterThan(0);
  expect(percentile(metrics!.provisionalMs, 0.95)).toBeLessThanOrEqual(32);
  expect(metrics!.canonicalMs.length).toBeGreaterThan(0);
  expect(percentile(metrics!.canonicalMs, 0.95)).toBeLessThanOrEqual(250);
  console.log(JSON.stringify({ visualDifference, metrics }));

  await second.reload();
  await waitUntilConnected(second);
  await expect.poll(() => baseCanvasHash(second), { timeout: 10_000 })
    .toBe(acceptedHash);

  await firstContext.close();
  await secondContext.close();
});
