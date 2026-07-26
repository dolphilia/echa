import {
  formatBytes,
  generateEventLog,
  summarizeEventLog,
  validateEventLog,
  validateRawFixture
} from "../src/core.mjs";

const canvas = document.getElementById("benchmarkCanvas");
const context = canvas.getContext("2d", { alpha: false });
const temporaryCanvas = document.createElement("canvas");
temporaryCanvas.width = canvas.width;
temporaryCanvas.height = canvas.height;
const temporaryContext = temporaryCanvas.getContext("2d");
const eventCountInput = document.getElementById("eventCount");
const actorCountInput = document.getElementById("actorCount");
const yieldBudgetInput = document.getElementById("yieldBudget");
const fixtureFileInput = document.getElementById("fixtureFile");
const runButton = document.getElementById("runButton");
const exportButton = document.getElementById("exportButton");
const status = document.getElementById("status");
const currentResult = document.getElementById("currentResult");
const resultsBody = document.getElementById("resultsBody");

let fixture = null;
let resultHistory = [];
let running = false;

function resetCanvas() {
  context.save();
  context.globalAlpha = 1;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function drawStrokePath(target, points, stroke) {
  if (points.length === 0) return;
  const lineWidth = stroke.tool === "eraser" ? stroke.size * 2.2 : stroke.size;
  target.lineCap = "round";
  target.lineJoin = "round";
  target.lineWidth = lineWidth;
  target.strokeStyle = stroke.tool === "eraser" ? "#fff" : stroke.color;
  target.fillStyle = target.strokeStyle;

  if (points.length === 1) {
    target.beginPath();
    target.arc(points[0].x, points[0].y, lineWidth / 2, 0, Math.PI * 2);
    target.fill();
    return;
  }

  target.beginPath();
  target.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    target.lineTo(points[1].x, points[1].y);
  } else {
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index];
      const next = points[index + 1];
      target.quadraticCurveTo(
        point.x,
        point.y,
        (point.x + next.x) / 2,
        (point.y + next.y) / 2
      );
    }
    const previous = points.at(-2);
    const last = points.at(-1);
    target.quadraticCurveTo(previous.x, previous.y, last.x, last.y);
  }
  target.stroke();
}

function finalizeStroke(stroke) {
  temporaryContext.clearRect(0, 0, canvas.width, canvas.height);
  temporaryContext.save();
  temporaryContext.globalAlpha = 1;
  drawStrokePath(temporaryContext, stroke.points, stroke);
  temporaryContext.restore();

  context.save();
  context.globalAlpha = stroke.tool === "eraser" ? 1 : stroke.opacity;
  context.drawImage(temporaryCanvas, 0, 0);
  context.restore();
}

function pointFromWire(point) {
  return { x: point[0], y: point[1], dt: point[2] };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function replayEventLog(log, { yieldBudgetMs }) {
  resetCanvas();
  const activeStrokes = new Map();
  let completedStrokes = 0;
  let processedPoints = 0;
  let firstDrawingMs = null;
  let maxSliceMs = 0;
  let sliceStartedAt = performance.now();
  const startedAt = sliceStartedAt;
  const longTasks = [];

  const observer = "PerformanceObserver" in window
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= startedAt) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        }
      })
    : null;
  try {
    observer?.observe({ type: "longtask", buffered: true });
  } catch {
    // Long Tasks API is not available in every browser.
  }

  for (const event of log.events) {
    if (event.op === "stroke.begin") {
      activeStrokes.set(event.id, {
        id: event.id,
        actor: event.actor,
        tool: event.tool,
        color: event.color,
        size: event.size,
        opacity: event.opacity,
        points: [pointFromWire(event.point)]
      });
      processedPoints += 1;
    } else if (event.op === "stroke.append") {
      const stroke = activeStrokes.get(event.id);
      if (stroke) {
        const points = event.points.map(pointFromWire);
        stroke.points.push(...points);
        processedPoints += points.length;
      }
    } else if (event.op === "stroke.end") {
      const stroke = activeStrokes.get(event.id);
      if (stroke) {
        finalizeStroke(stroke);
        activeStrokes.delete(event.id);
        completedStrokes += 1;
        if (firstDrawingMs === null) {
          firstDrawingMs = performance.now() - startedAt;
        }
      }
    } else if (event.op === "stroke.cancel") {
      activeStrokes.delete(event.id);
    }

    const now = performance.now();
    if (now - sliceStartedAt >= yieldBudgetMs) {
      maxSliceMs = Math.max(maxSliceMs, now - sliceStartedAt);
      await nextFrame();
      sliceStartedAt = performance.now();
    }
  }

  const finishedAt = performance.now();
  maxSliceMs = Math.max(maxSliceMs, finishedAt - sliceStartedAt);
  await nextFrame();
  observer?.disconnect();

  return {
    replayDurationMs: finishedAt - startedAt,
    firstDrawingMs,
    maxSliceMs,
    completedStrokes,
    processedPoints,
    unfinishedStrokes: activeStrokes.size,
    longTaskCount: longTasks.length,
    longestLongTaskMs: longTasks.reduce(
      (maximum, task) => Math.max(maximum, task.duration),
      0
    ),
    longTasks,
    usedJsHeapSize:
      performance.memory?.usedJSHeapSize ?? null
  };
}

function formatMilliseconds(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} ms`;
}

function setCurrentResult(result) {
  const values = [
    formatMilliseconds(result.replayDurationMs),
    formatMilliseconds(result.firstDrawingMs),
    formatMilliseconds(result.maxSliceMs),
    `${result.longTaskCount} / ${formatMilliseconds(result.longestLongTaskMs)}`
  ];
  currentResult.querySelectorAll("dd").forEach((element, index) => {
    element.textContent = values[index];
  });
}

function renderHistory() {
  resultsBody.replaceChildren();
  for (const result of resultHistory) {
    const row = document.createElement("tr");
    const values = [
      result.eventCount.toLocaleString(),
      result.strokeCount.toLocaleString(),
      result.pointCount.toLocaleString(),
      formatMilliseconds(result.replayDurationMs),
      formatMilliseconds(result.firstDrawingMs),
      formatMilliseconds(result.maxSliceMs),
      String(result.longTaskCount),
      formatBytes(result.estimatedMessagePackBytes)
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    resultsBody.appendChild(row);
  }
}

async function loadDefaultFixture() {
  const response = await fetch("../fixtures/sample-raw-strokes.json");
  if (!response.ok) throw new Error(`Fixture load failed: ${response.status}`);
  return response.json();
}

async function runBenchmark() {
  if (running) return;
  running = true;
  runButton.disabled = true;
  exportButton.disabled = true;
  try {
    fixture ??= await loadDefaultFixture();
    const fixtureErrors = validateRawFixture(fixture);
    if (fixtureErrors.length > 0) {
      throw new Error(fixtureErrors.join(", "));
    }
    const targetEvents = Number.parseInt(eventCountInput.value, 10);
    const actors = Number.parseInt(actorCountInput.value, 10);
    const yieldBudgetMs = Number.parseFloat(yieldBudgetInput.value);
    status.textContent = `${targetEvents.toLocaleString()} eventsを生成しています…`;
    await nextFrame();

    const log = generateEventLog(fixture, { targetEvents, actors });
    const validationErrors = validateEventLog(log);
    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(", "));
    }
    const summary = summarizeEventLog(log);
    status.textContent = `${summary.eventCount.toLocaleString()} eventsを再生しています…`;
    await nextFrame();

    const replay = await replayEventLog(log, { yieldBudgetMs });
    const result = {
      measuredAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      yieldBudgetMs,
      ...summary,
      ...replay
    };
    resultHistory.unshift(result);
    setCurrentResult(result);
    renderHistory();
    exportButton.disabled = false;
    status.textContent =
      `完了: ${summary.eventCount.toLocaleString()} events / `
      + `${formatMilliseconds(replay.replayDurationMs)}`;
    window.__lastBenchmarkResult = result;
  } catch (error) {
    console.error(error);
    status.textContent = `エラー: ${error.message}`;
    window.__lastBenchmarkError = error.message;
  } finally {
    running = false;
    runButton.disabled = false;
  }
}

function exportResults() {
  const blob = new Blob([JSON.stringify({
    schema: "echa.renderer-benchmark-results.v1",
    exportedAt: new Date().toISOString(),
    results: resultHistory
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `echa-renderer-benchmark-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

fixtureFileInput.addEventListener("change", async () => {
  const [file] = fixtureFileInput.files;
  if (!file) return;
  try {
    fixture = JSON.parse(await file.text());
    const errors = validateRawFixture(fixture);
    if (errors.length > 0) throw new Error(errors.join(", "));
    status.textContent = `${file.name}を読み込みました。`;
  } catch (error) {
    fixture = null;
    status.textContent = `Fixtureエラー: ${error.message}`;
  }
});

document.querySelectorAll("[data-events]").forEach((button) => {
  button.addEventListener("click", () => {
    eventCountInput.value = button.dataset.events;
  });
});
runButton.addEventListener("click", runBenchmark);
exportButton.addEventListener("click", exportResults);

resetCanvas();
window.__benchmarkReady = true;

const parameters = new URLSearchParams(location.search);
if (parameters.has("events")) eventCountInput.value = parameters.get("events");
if (parameters.has("actors")) actorCountInput.value = parameters.get("actors");
if (parameters.has("yield")) yieldBudgetInput.value = parameters.get("yield");
if (parameters.has("autorun")) runBenchmark();
