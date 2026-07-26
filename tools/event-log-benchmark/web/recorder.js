(function attachMeasurementRecorder(global) {
  "use strict";

  const SCHEMA = "echa.raw-strokes.v1";

  function rounded(value) {
    return Math.round(value * 100) / 100;
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function installStyles() {
    if (document.getElementById("measurement-recorder-styles")) return;
    const style = document.createElement("style");
    style.id = "measurement-recorder-styles";
    style.textContent = `
      .measurement-recorder {
        position: fixed;
        z-index: 10000;
        right: 16px;
        bottom: 16px;
        width: 220px;
        padding: 12px;
        border: 1px solid rgba(30, 30, 26, 0.14);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 8px 28px rgba(30, 30, 26, 0.16);
        color: #4e4c46;
        font: 12px/1.45 system-ui, sans-serif;
        backdrop-filter: blur(12px);
      }
      .measurement-recorder strong {
        display: block;
        margin-bottom: 8px;
        font-size: 13px;
      }
      .measurement-recorder-status {
        min-height: 34px;
        margin-bottom: 8px;
        color: #74716a;
      }
      .measurement-recorder-actions {
        display: flex;
        gap: 6px;
      }
      .measurement-recorder button {
        flex: 1;
        min-height: 30px;
        border: 1px solid #d6d4ce;
        border-radius: 9px;
        background: #fff;
        color: inherit;
        cursor: pointer;
      }
      .measurement-recorder button[data-recording="true"] {
        border-color: #d38b8b;
        background: #fff4f4;
        color: #a75555;
      }
      .measurement-recorder button:disabled {
        cursor: default;
        opacity: 0.45;
      }
    `;
    document.head.appendChild(style);
  }

  class MeasurementRecorder {
    constructor({ canvasWidth, canvasHeight, source = location.pathname }) {
      this.canvas = { width: canvasWidth, height: canvasHeight };
      this.source = source;
      this.recording = false;
      this.startedAt = 0;
      this.durationMs = 0;
      this.activeStroke = null;
      this.strokes = [];
      this.panel = null;
      this.status = null;
      this.recordButton = null;
      this.exportButton = null;

      if (new URLSearchParams(location.search).has("measure")) {
        this.mountPanel();
      }
    }

    mountPanel() {
      installStyles();
      const panel = document.createElement("section");
      panel.className = "measurement-recorder";
      panel.setAttribute("aria-label", "描画測定レコーダー");
      panel.innerHTML = `
        <strong>描画測定レコーダー</strong>
        <div class="measurement-recorder-status">停止中・0 strokes</div>
        <div class="measurement-recorder-actions">
          <button type="button" data-action="record">記録開始</button>
          <button type="button" data-action="export" disabled>書き出す</button>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;
      this.status = panel.querySelector(".measurement-recorder-status");
      this.recordButton = panel.querySelector('[data-action="record"]');
      this.exportButton = panel.querySelector('[data-action="export"]');
      this.recordButton.addEventListener("click", () => {
        if (this.recording) this.stop();
        else this.start();
      });
      this.exportButton.addEventListener("click", () => this.download());
      this.updatePanel();
    }

    start() {
      this.recording = true;
      this.startedAt = performance.now();
      this.durationMs = 0;
      this.activeStroke = null;
      this.strokes = [];
      this.updatePanel();
    }

    stop() {
      if (this.activeStroke) this.cancelStroke();
      this.durationMs = Math.max(0, performance.now() - this.startedAt);
      this.recording = false;
      this.updatePanel();
    }

    beginStroke(stroke, point, now = performance.now()) {
      if (!this.recording) return;
      if (this.activeStroke) this.cancelStroke();
      this.activeStroke = {
        tool: stroke.tool,
        color: stroke.color,
        size: stroke.size,
        opacity: stroke.opacity,
        startedAt: now,
        points: []
      };
      this.appendPoints([point], now);
    }

    appendPoints(points, now = performance.now()) {
      if (!this.recording || !this.activeStroke) return;
      for (const point of points) {
        const capturedAt = Number.isFinite(point.capturedAt)
          ? point.capturedAt
          : now;
        const last = this.activeStroke.points.at(-1);
        const next = {
          x: rounded(point.x),
          y: rounded(point.y),
          dt: Math.max(
            0,
            Math.round(capturedAt - this.activeStroke.startedAt)
          )
        };
        if (
          last
          && Math.abs(last.x - next.x) < 0.01
          && Math.abs(last.y - next.y) < 0.01
        ) {
          continue;
        }
        this.activeStroke.points.push(next);
      }
    }

    endStroke(point, now = performance.now()) {
      if (!this.recording || !this.activeStroke) return;
      if (point) this.appendPoints([point], now);
      if (this.activeStroke.points.length > 0) {
        const { startedAt, ...stroke } = this.activeStroke;
        this.strokes.push(stroke);
      }
      this.activeStroke = null;
      this.updatePanel();
    }

    cancelStroke() {
      if (!this.recording || !this.activeStroke) return;
      if (this.activeStroke.points.length > 0) {
        const { startedAt, ...stroke } = this.activeStroke;
        this.strokes.push({ ...stroke, cancelled: true });
      }
      this.activeStroke = null;
      this.updatePanel();
    }

    exportFixture() {
      const durationMs = this.recording
        ? Math.max(0, performance.now() - this.startedAt)
        : this.durationMs;
      return {
        schema: SCHEMA,
        recordedAt: new Date().toISOString(),
        canvas: { ...this.canvas },
        session: {
          source: this.source,
          durationMs: Math.round(durationMs)
        },
        strokes: structuredClone(this.strokes)
      };
    }

    download() {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(`echa-raw-strokes-${timestamp}.json`, this.exportFixture());
    }

    updatePanel() {
      if (!this.panel) return;
      const pointCount = this.strokes.reduce(
        (total, stroke) => total + stroke.points.length,
        0
      );
      this.status.textContent = this.recording
        ? `記録中・${this.strokes.length} strokes・${pointCount} points`
        : `停止中・${this.strokes.length} strokes・${pointCount} points`;
      this.recordButton.textContent = this.recording ? "記録停止" : "記録開始";
      this.recordButton.dataset.recording = String(this.recording);
      this.exportButton.disabled = this.strokes.length === 0;
    }
  }

  global.EchaMeasurementRecorder = {
    create(options) {
      return new MeasurementRecorder(options);
    }
  };
})(window);
