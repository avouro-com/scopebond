//! The tray icon, drawn in code so the repository holds no image files: the "S" tile with a status badge. The geometry is
//! a 32-unit grid (the one the agent's PowerShell tray draws on): a navy tile, slate when disconnected, the "S" in cream,
//! and a badge in the corner whose shape and colour both say the state, so it reads without colour too.
//!
//! This file uses only the standard library: `build.rs` includes it to write the program's own icon (an .ico), and the
//! tray uses it at run time for the six state icons.

/// The six states of the icon. Protected has no badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IconState {
    Protected,
    Working,
    Offline,
    Attention,
    Problem,
    Disconnected,
}

impl IconState {
    pub const ALL: [IconState; 6] = [
        IconState::Protected,
        IconState::Working,
        IconState::Offline,
        IconState::Attention,
        IconState::Problem,
        IconState::Disconnected,
    ];

    /// The agent's name for a state. A name this tray does not know (from a newer agent) shows as needing attention.
    pub fn parse(name: &str) -> IconState {
        match name {
            "protected" => IconState::Protected,
            "working" => IconState::Working,
            "offline" => IconState::Offline,
            "attention" => IconState::Attention,
            "problem" => IconState::Problem,
            "disconnected" => IconState::Disconnected,
            _ => IconState::Attention,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            IconState::Protected => "protected",
            IconState::Working => "working",
            IconState::Offline => "offline",
            IconState::Attention => "attention",
            IconState::Problem => "problem",
            IconState::Disconnected => "disconnected",
        }
    }
}

/// The palette. The agent's PowerShell tray uses the same values, and so do the panel's CSS variables.
pub mod palette {
    pub const NAVY: u32 = 0x1B3A5C;
    pub const SLATE: u32 = 0x57606A;
    pub const CREAM: u32 = 0xF7F4EE;
    pub const WHITE: u32 = 0xFFFFFF;
    pub const GREY: u32 = 0x6E7781;
    pub const AMBER: u32 = 0xDB9A04;
    pub const RED: u32 = 0xCF222E;
    pub const BLUE: u32 = 0x0969DA;
    pub const INK: u32 = 0x1F1A12;
}

fn rgb(hex: u32) -> [f32; 3] {
    [
        ((hex >> 16) & 0xFF) as f32 / 255.0,
        ((hex >> 8) & 0xFF) as f32 / 255.0,
        (hex & 0xFF) as f32 / 255.0,
    ]
}

/// A square canvas in premultiplied RGBA, painted with signed distances in grid units (negative inside a shape).
struct Canvas {
    size: u32,
    scale: f32,
    px: Vec<[f32; 4]>,
}

impl Canvas {
    fn new(size: u32) -> Canvas {
        Canvas { size, scale: size as f32 / 32.0, px: vec![[0.0; 4]; (size * size) as usize] }
    }

    fn paint(&mut self, color: u32, distance: impl Fn(f32, f32) -> f32) {
        let [r, g, b] = rgb(color);
        for y in 0..self.size {
            for x in 0..self.size {
                let u = (x as f32 + 0.5) / self.scale;
                let v = (y as f32 + 0.5) / self.scale;
                // Coverage from the distance in pixels: a one-pixel ramp across the edge.
                let a = (0.5 - distance(u, v) * self.scale).clamp(0.0, 1.0);
                if a <= 0.0 {
                    continue;
                }
                let p = &mut self.px[(y * self.size + x) as usize];
                p[0] = r * a + p[0] * (1.0 - a);
                p[1] = g * a + p[1] * (1.0 - a);
                p[2] = b * a + p[2] * (1.0 - a);
                p[3] = a + p[3] * (1.0 - a);
            }
        }
    }

    /// Straight (not premultiplied) RGBA bytes, row by row from the top.
    fn rgba(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.px.len() * 4);
        for p in &self.px {
            let a = p[3];
            let un = |c: f32| if a > 0.0 { (c / a).clamp(0.0, 1.0) } else { 0.0 };
            out.extend_from_slice(&[
                (un(p[0]) * 255.0).round() as u8,
                (un(p[1]) * 255.0).round() as u8,
                (un(p[2]) * 255.0).round() as u8,
                (a * 255.0).round() as u8,
            ]);
        }
        out
    }
}

fn length(x: f32, y: f32) -> f32 {
    (x * x + y * y).sqrt()
}

fn rounded_box(u: f32, v: f32, cx: f32, cy: f32, half: f32, radius: f32) -> f32 {
    let qx = (u - cx).abs() - (half - radius);
    let qy = (v - cy).abs() - (half - radius);
    length(qx.max(0.0), qy.max(0.0)) + qx.max(qy).min(0.0) - radius
}

fn circle(u: f32, v: f32, cx: f32, cy: f32, radius: f32) -> f32 {
    length(u - cx, v - cy) - radius
}

/// A stroke along a segment, with round ends.
fn segment(u: f32, v: f32, a: (f32, f32), b: (f32, f32), width: f32) -> f32 {
    let (px, py) = (u - a.0, v - a.1);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let t = ((px * dx + py * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    length(px - dx * t, py - dy * t) - width / 2.0
}

/// A stroke along an arc, with round ends. Angles in degrees, clockwise from the right on screen (as GDI draws arcs).
fn arc(u: f32, v: f32, c: (f32, f32), radius: f32, start: f32, sweep: f32, width: f32) -> f32 {
    let angle = (v - c.1).atan2(u - c.0).to_degrees().rem_euclid(360.0);
    let along = (angle - start).rem_euclid(360.0);
    if along <= sweep {
        return (length(u - c.0, v - c.1) - radius).abs() - width / 2.0;
    }
    let end = |deg: f32| {
        let r = deg.to_radians();
        (c.0 + radius * r.cos(), c.1 + radius * r.sin())
    };
    let (e1, e2) = (end(start), end(start + sweep));
    length(u - e1.0, v - e1.1).min(length(u - e2.0, v - e2.1)) - width / 2.0
}

/// The icon for `state`, `size` pixels square, as straight RGBA bytes from the top row.
pub fn render(state: IconState, size: u32) -> Vec<u8> {
    use palette::*;
    let mut c = Canvas::new(size);
    let tile = if state == IconState::Disconnected { SLATE } else { NAVY };
    c.paint(tile, |u, v| rounded_box(u, v, 16.0, 16.0, 15.0, 8.0));
    // The "S": two bowls that meet in the middle, a little left of centre (room for the badge).
    let stroke = 2.8;
    c.paint(CREAM, |u, v| {
        arc(u, v, (15.0, 12.6), 3.4, 90.0, 230.0, stroke).min(arc(u, v, (15.0, 19.4), 3.4, 270.0, 230.0, stroke))
    });
    match state {
        IconState::Protected => {}
        IconState::Disconnected => c.paint(CREAM, |u, v| segment(u, v, (6.0, 26.0), (26.0, 6.0), 2.0)),
        _ => {
            let fill = match state {
                IconState::Offline => GREY,
                IconState::Attention => AMBER,
                IconState::Problem => RED,
                _ => BLUE,
            };
            c.paint(CREAM, |u, v| circle(u, v, 24.0, 24.0, 7.75));
            c.paint(fill, |u, v| circle(u, v, 24.0, 24.0, 6.25));
            let w = 2.2;
            match state {
                // Offline: a dash. Attention: "!" in dark ink on amber. Problem: a cross. Working: an open circle.
                IconState::Offline => c.paint(WHITE, |u, v| segment(u, v, (21.0, 24.0), (27.0, 24.0), w)),
                IconState::Attention => c.paint(INK, |u, v| {
                    segment(u, v, (24.0, 20.0), (24.0, 24.6), w).min(circle(u, v, 24.0, 27.6, 1.2))
                }),
                IconState::Problem => c.paint(WHITE, |u, v| {
                    segment(u, v, (21.5, 21.5), (26.5, 26.5), w).min(segment(u, v, (26.5, 21.5), (21.5, 26.5), w))
                }),
                _ => c.paint(WHITE, |u, v| arc(u, v, (24.0, 24.0), 3.5, 300.0, 280.0, w)),
            }
        }
    }
    c.rgba()
}

/// A PNG file of the icon at `size` (8-bit RGBA, deflate's stored blocks: no compression library), as macOS and Tauri
/// read for an app's icon.
pub fn png(state: IconState, size: u32) -> Vec<u8> {
    let rgba = render(state, size);
    // Each row starts with filter type 0 (none).
    let mut raw = Vec::with_capacity(rgba.len() + size as usize);
    for row in rgba.chunks(size as usize * 4) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    // zlib: header, stored blocks of at most 65535 bytes, Adler-32.
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, block) in blocks.iter().enumerate() {
        z.push(u8::from(i + 1 == blocks.len()));
        let len = block.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in &raw {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    for (kind, data) in [(b"IHDR", ihdr.as_slice()), (b"IDAT", z.as_slice()), (b"IEND", &[][..])] {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }
    out
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// An .ico file with one 32-bit image per size (uncompressed, with alpha), as Windows reads for a program's icon.
pub fn ico(state: IconState, sizes: &[u32]) -> Vec<u8> {
    let images: Vec<Vec<u8>> = sizes.iter().map(|&s| bmp_entry(&render(state, s), s)).collect();
    let mut out = Vec::new();
    out.extend_from_slice(&[0, 0, 1, 0]);
    out.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * sizes.len() as u32;
    for (i, &s) in sizes.iter().enumerate() {
        let side = if s >= 256 { 0 } else { s as u8 };
        out.extend_from_slice(&[side, side, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(images[i].len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += images[i].len() as u32;
    }
    for image in images {
        out.extend_from_slice(&image);
    }
    out
}

fn bmp_entry(rgba: &[u8], size: u32) -> Vec<u8> {
    let mask_row = size.div_ceil(32) * 4;
    let mut out = Vec::new();
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(size as i32).to_le_bytes());
    out.extend_from_slice(&((size * 2) as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(size * size * 4 + mask_row * size).to_le_bytes());
    out.extend_from_slice(&[0; 16]);
    // Rows from the bottom, blue-green-red-alpha.
    for y in (0..size).rev() {
        for x in 0..size {
            let i = ((y * size + x) * 4) as usize;
            out.extend_from_slice(&[rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]]);
        }
    }
    // The AND mask: all zero; the alpha channel decides.
    out.resize(out.len() + (mask_row * size) as usize, 0);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_png_is_a_valid_rgba_image_of_its_size() {
        let png = super::png(super::IconState::Protected, 64);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 64);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 64);
        assert_eq!(&png[24..29], &[8, 6, 0, 0, 0], "8-bit RGBA");
        // Every chunk's CRC covers its type and data.
        let mut at = 8;
        let mut kinds = Vec::new();
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let crc = u32::from_be_bytes(png[at + 8 + len..at + 12 + len].try_into().unwrap());
            assert_eq!(crc, super::crc32(&png[at + 4..at + 8 + len]));
            kinds.push(String::from_utf8_lossy(&png[at + 4..at + 8]).into_owned());
            at += 12 + len;
        }
        assert_eq!(kinds, ["IHDR", "IDAT", "IEND"]);
        assert_eq!(super::crc32(b"123456789"), 0xcbf4_3926, "the standard CRC-32 check value");
    }

    use super::*;

    fn pixel(rgba: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * size + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    fn close(p: [u8; 4], hex: u32) -> bool {
        let want = [(hex >> 16) as u8, (hex >> 8) as u8, hex as u8];
        (0..3).all(|i| (p[i] as i32 - want[i] as i32).abs() <= 3) && p[3] == 255
    }

    #[test]
    fn every_state_draws_a_square_image_with_transparent_corners() {
        for state in IconState::ALL {
            for size in [16, 32, 64] {
                let image = render(state, size);
                assert_eq!(image.len(), (size * size * 4) as usize);
                assert_eq!(pixel(&image, size, 0, 0)[3], 0, "{state:?} corner at {size}");
                assert_eq!(pixel(&image, size, size - 1, 0)[3], 0);
            }
        }
    }

    #[test]
    fn the_tile_is_navy_and_slate_when_disconnected() {
        let at = |state| pixel(&render(state, 32), 32, 4, 16);
        assert!(close(at(IconState::Protected), palette::NAVY));
        assert!(close(at(IconState::Disconnected), palette::SLATE));
    }

    #[test]
    fn the_badge_says_the_state_and_protected_has_none() {
        // A point inside the badge, clear of every glyph.
        let badge = |state| pixel(&render(state, 64), 64, 38, 52);
        assert!(close(badge(IconState::Problem), palette::RED));
        assert!(close(badge(IconState::Attention), palette::AMBER));
        assert!(close(badge(IconState::Offline), palette::GREY));
        assert!(close(badge(IconState::Working), palette::BLUE));
        assert!(close(badge(IconState::Protected), palette::NAVY));
    }

    #[test]
    fn the_s_is_drawn() {
        let image = render(IconState::Protected, 64);
        // The middle of the "S", where its bowls meet, is cream.
        assert!(close(pixel(&image, 64, 30, 32), palette::CREAM));
    }

    #[test]
    fn unknown_state_names_need_attention() {
        assert_eq!(IconState::parse("protected"), IconState::Protected);
        assert_eq!(IconState::parse("something-new"), IconState::Attention);
        for state in IconState::ALL {
            assert_eq!(IconState::parse(state.as_str()), state);
        }
    }

    #[test]
    fn the_ico_file_lists_every_size() {
        let file = ico(IconState::Protected, &[16, 32, 256]);
        assert_eq!(&file[0..6], &[0, 0, 1, 0, 3, 0]);
        assert_eq!(file[6], 16);
        assert_eq!(file[6 + 16], 32);
        assert_eq!(file[6 + 32], 0, "256 is written as 0");
        let first = u32::from_le_bytes(file[18..22].try_into().unwrap()) as usize;
        assert_eq!(first, 6 + 16 * 3);
        assert_eq!(u32::from_le_bytes(file[first..first + 4].try_into().unwrap()), 40);
    }
}
