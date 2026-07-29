import { encodeRendererFixture } from "./wire.mjs";

function rendererExports(instance) {
  const exports = instance.exports;
  if (
    !(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.renderer_version !== "function"
    || typeof exports.renderer_alloc !== "function"
    || typeof exports.renderer_canvas_new !== "function"
    || typeof exports.renderer_dealloc !== "function"
    || typeof exports.renderer_apply !== "function"
    || typeof exports.renderer_render !== "function"
  ) {
    throw new TypeError("invalid koge renderer WASM exports");
  }
  return exports;
}

export async function instantiateRenderer(source) {
  const module = source instanceof WebAssembly.Module
    ? source
    : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = rendererExports(instance);
  if (exports.renderer_version() !== 1) {
    throw new RangeError("unsupported koge renderer version");
  }
  return instance;
}

export function renderFixture(instance, fixture) {
  const exports = rendererExports(instance);
  const input = encodeRendererFixture(fixture);
  const width = fixture.canvas?.width;
  const height = fixture.canvas?.height;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    throw new RangeError("invalid renderer canvas");
  }
  const outputLength = width * height * 4;
  const inputPointer = exports.renderer_alloc(input.byteLength);
  if (inputPointer === 0) throw new Error("renderer input allocation failed");
  try {
    new Uint8Array(exports.memory.buffer, inputPointer, input.byteLength).set(input);
    const outputPointer = exports.renderer_render(
      inputPointer,
      input.byteLength,
      width,
      height
    );
    if (outputPointer === 0) throw new Error("renderer rejected the fixture");
    try {
      return new Uint8Array(
        new Uint8Array(exports.memory.buffer, outputPointer, outputLength)
      );
    } finally {
      exports.renderer_dealloc(outputPointer, outputLength);
    }
  } finally {
    exports.renderer_dealloc(inputPointer, input.byteLength);
  }
}

export class RendererSession {
  #exports;
  #pointer;
  #length;
  #width;
  #height;

  constructor(instance, width, height) {
    this.#exports = rendererExports(instance);
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
    ) {
      throw new RangeError("invalid renderer canvas");
    }
    this.#width = width;
    this.#height = height;
    this.#length = width * height * 4;
    this.#pointer = this.#exports.renderer_canvas_new(width, height);
    if (this.#pointer === 0) throw new Error("renderer canvas allocation failed");
  }

  apply(strokes) {
    if (this.#pointer === 0) throw new Error("renderer session is disposed");
    const input = encodeRendererFixture({
      canvas: { width: this.#width, height: this.#height },
      strokes
    });
    const inputPointer = this.#exports.renderer_alloc(input.byteLength);
    if (inputPointer === 0) throw new Error("renderer input allocation failed");
    try {
      new Uint8Array(
        this.#exports.memory.buffer,
        inputPointer,
        input.byteLength
      ).set(input);
      if (
        this.#exports.renderer_apply(
          inputPointer,
          input.byteLength,
          this.#width,
          this.#height,
          this.#pointer
        ) !== 1
      ) {
        throw new Error("renderer rejected incremental strokes");
      }
    } finally {
      this.#exports.renderer_dealloc(inputPointer, input.byteLength);
    }
  }

  pixels() {
    if (this.#pointer === 0) throw new Error("renderer session is disposed");
    return new Uint8Array(
      new Uint8Array(
        this.#exports.memory.buffer,
        this.#pointer,
        this.#length
      )
    );
  }

  loadPixels(rgba) {
    if (this.#pointer === 0) throw new Error("renderer session is disposed");
    if (!(rgba instanceof Uint8Array) || rgba.byteLength !== this.#length) {
      throw new RangeError("snapshot pixels do not match renderer canvas");
    }
    new Uint8Array(
      this.#exports.memory.buffer,
      this.#pointer,
      this.#length
    ).set(rgba);
  }

  dispose() {
    if (this.#pointer === 0) return;
    this.#exports.renderer_dealloc(this.#pointer, this.#length);
    this.#pointer = 0;
  }
}

export { encodeRendererFixture } from "./wire.mjs";
