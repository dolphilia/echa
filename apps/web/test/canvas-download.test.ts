import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canvasDownloadFilename,
  canvasPngBlob,
} from "../app/canvas-download";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canvas download filename", () => {
  const downloadedAt = new Date(2026, 6, 29, 17, 30, 5);

  it("uses the normalized room name and local timestamp", () => {
    expect(canvasDownloadFilename(" みんなで お絵描き ", downloadedAt))
      .toBe("koge_みんなで_お絵描き_20260729-173005.png");
  });

  it("removes unsafe filename characters", () => {
    expect(canvasDownloadFilename('a/b:c*?"<>|', downloadedAt))
      .toBe("koge_a_b_c_20260729-173005.png");
  });

  it("falls back when the room name has no safe characters", () => {
    expect(canvasDownloadFilename("///", downloadedAt))
      .toBe("koge_drawing_20260729-173005.png");
  });

  it("encodes the intrinsic canvas size over an explicit white background", async () => {
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const blob = new Blob(["png"], { type: "image/png" });
    const output = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        fillStyle: "",
        fillRect,
        drawImage,
      })),
      toBlob: vi.fn((callback: BlobCallback) => callback(blob)),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => output),
    });
    const source = {
      width: 1000,
      height: 1000,
    } as HTMLCanvasElement;

    await expect(canvasPngBlob(source)).resolves.toBe(blob);
    expect(output.width).toBe(1000);
    expect(output.height).toBe(1000);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1000, 1000);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(output.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/png",
    );
  });
});
