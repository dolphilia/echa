const MAGIC = new Uint8Array([0x4b, 0x47, 0x52, 0x31]);
const FIXED_SCALE = 256;

function parseHexColor(value) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new TypeError(`invalid renderer color: ${value}`);
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
}

function fixed(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  const result = Math.round(value * FIXED_SCALE);
  if (result < -0x80000000 || result > 0x7fffffff) {
    throw new RangeError(`${label} is outside the fixed-point range`);
  }
  return result;
}

export function encodeRendererFixture(fixture) {
  if (!fixture || !Array.isArray(fixture.strokes)) {
    throw new TypeError("fixture strokes are required");
  }
  const byteLength = 8 + fixture.strokes.reduce(
    (total, stroke) => total + 16 + stroke.points.length * 8,
    0
  );
  const bytes = new Uint8Array(byteLength);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, fixture.strokes.length, true);
  let cursor = 8;
  for (const stroke of fixture.strokes) {
    const [red, green, blue] = parseHexColor(stroke.color);
    const size = fixed(stroke.size, "stroke.size");
    const opacity = Math.round(stroke.opacity * 255);
    if (
      !Array.isArray(stroke.points)
      || stroke.points.length === 0
      || stroke.points.length > 4096
      || size < FIXED_SCALE
      || size > 60 * FIXED_SCALE
      || opacity < 0
      || opacity > 255
    ) {
      throw new RangeError("invalid renderer stroke");
    }
    view.setUint8(cursor, stroke.tool === "eraser" ? 1 : 0);
    view.setUint8(cursor + 1, stroke.cancelled ? 1 : 0);
    view.setUint16(cursor + 2, 0, true);
    view.setUint8(cursor + 4, red);
    view.setUint8(cursor + 5, green);
    view.setUint8(cursor + 6, blue);
    view.setUint8(cursor + 7, opacity);
    view.setUint32(cursor + 8, size, true);
    view.setUint32(cursor + 12, stroke.points.length, true);
    cursor += 16;
    for (const point of stroke.points) {
      view.setInt32(cursor, fixed(point.x, "point.x"), true);
      view.setInt32(cursor + 4, fixed(point.y, "point.y"), true);
      cursor += 8;
    }
  }
  return bytes;
}

