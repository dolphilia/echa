export type RendererFixture = {
  readonly canvas: {
    readonly width: number;
    readonly height: number;
  };
  readonly strokes: readonly {
    readonly tool: "brush" | "eraser";
    readonly color: string;
    readonly size: number;
    readonly opacity: number;
    readonly cancelled?: boolean;
    readonly points: readonly {
      readonly x: number;
      readonly y: number;
      readonly dt: number;
    }[];
  }[];
};

export type RendererExports = WebAssembly.Exports & {
  readonly memory: WebAssembly.Memory;
  readonly renderer_version: () => number;
  readonly renderer_alloc: (length: number) => number;
  readonly renderer_canvas_new: (width: number, height: number) => number;
  readonly renderer_dealloc: (pointer: number, length: number) => void;
  readonly renderer_apply: (
    inputPointer: number,
    inputLength: number,
    width: number,
    height: number,
    canvasPointer: number
  ) => number;
  readonly renderer_render: (
    inputPointer: number,
    inputLength: number,
    width: number,
    height: number
  ) => number;
};

export type RendererInstance = WebAssembly.Instance & {
  readonly exports: RendererExports;
};

export function instantiateRenderer(
  source: BufferSource | WebAssembly.Module
): Promise<RendererInstance>;

export function encodeRendererFixture(fixture: RendererFixture): Uint8Array;

export function renderFixture(
  instance: RendererInstance,
  fixture: RendererFixture
): Uint8Array;

export class RendererSession {
  constructor(instance: RendererInstance, width: number, height: number);
  apply(strokes: RendererFixture["strokes"]): void;
  pixels(): Uint8Array;
  loadPixels(rgba: Uint8Array): void;
  dispose(): void;
}
