const FIXED_SCALE: i64 = 256;
const ANTIALIAS_HALF_WIDTH: i64 = FIXED_SCALE / 2;
const MAX_CANVAS_SIDE: u32 = 4096;
const MAX_STROKES: u32 = 100_000;
const MAX_POINTS_PER_STROKE: u32 = 4096;

#[derive(Clone, Copy, Debug)]
struct Point {
    x: i64,
    y: i64,
}

#[derive(Clone, Debug)]
struct Stroke {
    tool: u8,
    cancelled: bool,
    color: [u8; 3],
    opacity: u8,
    size: i64,
    points: Vec<Point>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.cursor.checked_add(N)?;
        let source = self.bytes.get(self.cursor..end)?;
        self.cursor = end;
        source.try_into().ok()
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take::<1>()?[0])
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take()?))
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take()?))
    }

    fn i32(&mut self) -> Option<i32> {
        Some(i32::from_le_bytes(self.take()?))
    }
}

fn parse_strokes(bytes: &[u8]) -> Option<Vec<Stroke>> {
    let mut reader = Reader::new(bytes);
    if reader.take::<4>()? != *b"KGR1" {
        return None;
    }
    let stroke_count = reader.u32()?;
    if stroke_count > MAX_STROKES {
        return None;
    }
    let mut strokes = Vec::with_capacity(stroke_count as usize);
    for _ in 0..stroke_count {
        let tool = reader.u8()?;
        let flags = reader.u8()?;
        let _reserved = reader.u16()?;
        let color = [reader.u8()?, reader.u8()?, reader.u8()?];
        let opacity = reader.u8()?;
        let size = i64::from(reader.u32()?);
        let point_count = reader.u32()?;
        if tool > 1
            || size < FIXED_SCALE
            || size > 60 * FIXED_SCALE
            || point_count == 0
            || point_count > MAX_POINTS_PER_STROKE
        {
            return None;
        }
        let mut points = Vec::with_capacity(point_count as usize);
        for _ in 0..point_count {
            points.push(Point {
                x: i64::from(reader.i32()?),
                y: i64::from(reader.i32()?),
            });
        }
        strokes.push(Stroke {
            tool,
            cancelled: flags & 1 == 1,
            color,
            opacity,
            size,
            points,
        });
    }
    if reader.cursor != bytes.len() {
        return None;
    }
    Some(strokes)
}

fn integer_sqrt(value: u128) -> u128 {
    if value < 2 {
        return value;
    }
    let mut low = 1_u128;
    let mut high = value.min(u128::from(u64::MAX));
    while low <= high {
        let middle = low + (high - low) / 2;
        if middle <= value / middle {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    high
}

fn distance_to_segment(point: Point, start: Point, end: Point) -> i64 {
    let dx = i128::from(end.x - start.x);
    let dy = i128::from(end.y - start.y);
    let px = i128::from(point.x - start.x);
    let py = i128::from(point.y - start.y);
    let length_squared = dx * dx + dy * dy;
    let nearest = if length_squared == 0 {
        start
    } else {
        let projection = (px * dx + py * dy).clamp(0, length_squared);
        Point {
            x: start.x + (dx * projection / length_squared) as i64,
            y: start.y + (dy * projection / length_squared) as i64,
        }
    };
    let offset_x = i128::from(point.x - nearest.x);
    let offset_y = i128::from(point.y - nearest.y);
    integer_sqrt((offset_x * offset_x + offset_y * offset_y) as u128) as i64
}

fn coverage(distance: i64, radius: i64) -> u8 {
    let inner = (radius - ANTIALIAS_HALF_WIDTH).max(0);
    let outer = radius + ANTIALIAS_HALF_WIDTH;
    if distance <= inner {
        return u8::MAX;
    }
    if distance >= outer {
        return 0;
    }
    (((outer - distance) * 255 + ANTIALIAS_HALF_WIDTH) / FIXED_SCALE).clamp(0, 255) as u8
}

fn pixel_bounds(
    start: Point,
    end: Point,
    radius: i64,
    width: u32,
    height: u32,
) -> (u32, u32, u32, u32) {
    let padding = radius + ANTIALIAS_HALF_WIDTH;
    let min_x = ((start.x.min(end.x) - padding).div_euclid(FIXED_SCALE))
        .clamp(0, i64::from(width.saturating_sub(1))) as u32;
    let min_y = ((start.y.min(end.y) - padding).div_euclid(FIXED_SCALE))
        .clamp(0, i64::from(height.saturating_sub(1))) as u32;
    let max_x = ((start.x.max(end.x) + padding).div_euclid(FIXED_SCALE))
        .clamp(0, i64::from(width.saturating_sub(1))) as u32;
    let max_y = ((start.y.max(end.y) + padding).div_euclid(FIXED_SCALE))
        .clamp(0, i64::from(height.saturating_sub(1))) as u32;
    (min_x, min_y, max_x, max_y)
}

fn rasterize_segment(
    mask: &mut [u8],
    width: u32,
    height: u32,
    start: Point,
    end: Point,
    radius: i64,
) {
    let (min_x, min_y, max_x, max_y) = pixel_bounds(start, end, radius, width, height);
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let sample = Point {
                x: i64::from(x) * FIXED_SCALE + ANTIALIAS_HALF_WIDTH,
                y: i64::from(y) * FIXED_SCALE + ANTIALIAS_HALF_WIDTH,
            };
            let amount = coverage(distance_to_segment(sample, start, end), radius);
            let index = y as usize * width as usize + x as usize;
            mask[index] = mask[index].max(amount);
        }
    }
}

fn composite_stroke(canvas: &mut [u8], mask: &[u8], stroke: &Stroke) {
    let source = if stroke.tool == 1 {
        [255, 255, 255]
    } else {
        stroke.color
    };
    for (index, amount) in mask.iter().copied().enumerate() {
        if amount == 0 {
            continue;
        }
        let alpha = (u32::from(amount) * u32::from(stroke.opacity) + 127) / 255;
        let inverse = 255 - alpha;
        let offset = index * 4;
        for channel in 0..3 {
            canvas[offset + channel] = ((u32::from(source[channel]) * alpha
                + u32::from(canvas[offset + channel]) * inverse
                + 127)
                / 255) as u8;
        }
    }
}

fn canvas_length(width: u32, height: u32) -> Option<usize> {
    if width == 0 || height == 0 || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE {
        return None;
    }
    let pixel_count = (width as usize).checked_mul(height as usize)?;
    pixel_count.checked_mul(4)
}

fn apply_strokes(canvas: &mut [u8], width: u32, height: u32, strokes: &[Stroke]) -> Option<()> {
    let expected_length = canvas_length(width, height)?;
    if canvas.len() != expected_length {
        return None;
    }
    let pixel_count = expected_length / 4;
    for stroke in strokes {
        if stroke.cancelled {
            continue;
        }
        let mut mask = vec![0_u8; pixel_count];
        let radius = stroke.size / 2;
        if stroke.points.len() == 1 {
            rasterize_segment(
                &mut mask,
                width,
                height,
                stroke.points[0],
                stroke.points[0],
                radius,
            );
        } else {
            for pair in stroke.points.windows(2) {
                rasterize_segment(&mut mask, width, height, pair[0], pair[1], radius);
            }
        }
        composite_stroke(canvas, &mask, stroke);
    }
    Some(())
}

fn render(width: u32, height: u32, strokes: &[Stroke]) -> Option<Vec<u8>> {
    let mut canvas = vec![255_u8; canvas_length(width, height)?];
    apply_strokes(&mut canvas, width, height, strokes)?;
    Some(canvas)
}

#[no_mangle]
pub extern "C" fn renderer_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn renderer_alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub extern "C" fn renderer_canvas_new(width: u32, height: u32) -> *mut u8 {
    let Some(length) = canvas_length(width, height) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(vec![255_u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn renderer_dealloc(pointer: *mut u8, length: usize) {
    if pointer.is_null() || length == 0 {
        return;
    }
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        pointer, length,
    )));
}

#[no_mangle]
pub unsafe extern "C" fn renderer_render(
    input_pointer: *const u8,
    input_length: usize,
    width: u32,
    height: u32,
) -> *mut u8 {
    if input_pointer.is_null() || input_length == 0 {
        return std::ptr::null_mut();
    }
    let input = std::slice::from_raw_parts(input_pointer, input_length);
    let Some(strokes) = parse_strokes(input) else {
        return std::ptr::null_mut();
    };
    let Some(output) = render(width, height, &strokes) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(output.into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn renderer_apply(
    input_pointer: *const u8,
    input_length: usize,
    width: u32,
    height: u32,
    canvas_pointer: *mut u8,
) -> u32 {
    if input_pointer.is_null() || input_length == 0 || canvas_pointer.is_null() {
        return 0;
    }
    let Some(output_length) = canvas_length(width, height) else {
        return 0;
    };
    let input = std::slice::from_raw_parts(input_pointer, input_length);
    let Some(strokes) = parse_strokes(input) else {
        return 0;
    };
    let canvas = std::slice::from_raw_parts_mut(canvas_pointer, output_length);
    u32::from(apply_strokes(canvas, width, height, &strokes).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(opacity: u8, points: Vec<Point>) -> Stroke {
        Stroke {
            tool: 0,
            cancelled: false,
            color: [0, 0, 0],
            opacity,
            size: 8 * FIXED_SCALE,
            points,
        }
    }

    #[test]
    fn one_stroke_is_composited_once_at_self_overlaps() {
        let center = Point {
            x: 10 * FIXED_SCALE + ANTIALIAS_HALF_WIDTH,
            y: 10 * FIXED_SCALE + ANTIALIAS_HALF_WIDTH,
        };
        let once = render(24, 24, &[stroke(128, vec![center])]).unwrap();
        let overlap = render(24, 24, &[stroke(128, vec![center, center, center])]).unwrap();
        assert_eq!(once, overlap);
    }

    #[test]
    fn cancelled_strokes_do_not_change_the_canvas() {
        let mut cancelled = stroke(
            255,
            vec![Point {
                x: 4 * FIXED_SCALE,
                y: 4 * FIXED_SCALE,
            }],
        );
        cancelled.cancelled = true;
        assert!(render(8, 8, &[cancelled])
            .unwrap()
            .chunks_exact(4)
            .all(|pixel| pixel == [255, 255, 255, 255]));
    }

    #[test]
    fn incremental_application_matches_full_render() {
        let first = stroke(
            128,
            vec![Point {
                x: 4 * FIXED_SCALE,
                y: 4 * FIXED_SCALE,
            }],
        );
        let second = stroke(
            255,
            vec![
                Point {
                    x: 8 * FIXED_SCALE,
                    y: 8 * FIXED_SCALE,
                },
                Point {
                    x: 16 * FIXED_SCALE,
                    y: 12 * FIXED_SCALE,
                },
            ],
        );
        let full = render(24, 24, &[first.clone(), second.clone()]).unwrap();
        let mut incremental = vec![255_u8; canvas_length(24, 24).unwrap()];
        apply_strokes(&mut incremental, 24, 24, &[first]).unwrap();
        apply_strokes(&mut incremental, 24, 24, &[second]).unwrap();
        assert_eq!(incremental, full);
    }
}
