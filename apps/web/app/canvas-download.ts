const INVALID_FILENAME_CHARACTERS = /[/\\?%*:|"<>]/g;
const MAX_ROOM_NAME_CODE_POINTS = 48;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function canvasDownloadFilename(
  roomName: string,
  downloadedAt = new Date(),
): string {
  const normalizedRoomName = roomName
    .normalize("NFKC")
    .split("")
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(INVALID_FILENAME_CHARACTERS, " ")
    .replace(/\s+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  const safeRoomName = [...normalizedRoomName]
    .slice(0, MAX_ROOM_NAME_CODE_POINTS)
    .join("") || "drawing";
  const timestamp = [
    downloadedAt.getFullYear(),
    pad(downloadedAt.getMonth() + 1),
    pad(downloadedAt.getDate()),
    "-",
    pad(downloadedAt.getHours()),
    pad(downloadedAt.getMinutes()),
    pad(downloadedAt.getSeconds()),
  ].join("");
  return `koge_${safeRoomName}_${timestamp}.png`;
}

export function canvasPngBlob(
  source: HTMLCanvasElement,
): Promise<Blob> {
  const output = document.createElement("canvas");
  output.width = source.width;
  output.height = source.height;
  const context = output.getContext("2d", { alpha: false });
  if (!context) {
    return Promise.reject(new Error("PNG canvas context is unavailable"));
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, 0, 0);
  return new Promise((resolve, reject) => {
    output.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PNG encoding failed"));
      }
    }, "image/png");
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari may still be reading the object URL immediately after click().
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
