"""Regenerate the Claude Code sidebar icon (template image, monochrome 'C').

Usage:
  python3 Scripts/gen-icon.py              # regenerate all 4 PNGs into Images/
  python3 Scripts/gen-icon.py <size> <out> # generate one PNG (debugging)

Nova convention: sidebar smallImage/largeImage references a *folder* under
Images/, containing <name>.png (@1x), <name>@2x.png, and metadata.json with
{"template": true}. Template images are tinted by Nova per-theme.

Shape parameters (tweak in render_c):
  outer = big * 0.44   # outer radius (larger = bigger C)
  inner = big * 0.28   # inner radius (gap with outer = stroke thickness)
  gap   = math.pi / 4  # right-side opening angle (pi/4 = 45 deg)
"""
import struct, zlib, math, sys, os


def make_png(rows):
    h = len(rows)
    w = len(rows[0])
    raw = b""
    for row in rows:
        raw += b"\x00"
        for y, a in row:
            raw += bytes([y, a])

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 4, 0, 0, 0)  # 8-bit grayscale+alpha
    idat = zlib.compress(raw)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def render_c(size, ss=8):
    big = size * ss
    cx = cy = big / 2 - 0.5
    outer = big * 0.44
    inner = big * 0.28
    gap = math.pi / 4
    mask = [[0] * big for _ in range(big)]
    for y in range(big):
        for x in range(big):
            dx = x - cx
            dy = y - cy
            d = math.sqrt(dx * dx + dy * dy)
            if inner <= d <= outer and abs(math.atan2(dy, dx)) > gap:
                mask[y][x] = 1
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            total = 0
            for ay in range(ss):
                for ax in range(ss):
                    total += mask[y * ss + ay][x * ss + ax]
            alpha = int(round(total / (ss * ss) * 255))
            row.append((0, alpha))
        rows.append(row)
    return rows


def write_png(size, path):
    with open(path, "wb") as f:
        f.write(make_png(render_c(size)))


def regenerate_all():
    here = os.path.dirname(os.path.abspath(__file__))
    images = os.path.normpath(os.path.join(here, "..", "Images"))
    targets = {
        "claude-icon-small": (16, 32),
        "claude-icon-large": (24, 48),
    }
    for name, (s1x, s2x) in targets.items():
        folder = os.path.join(images, name)
        os.makedirs(folder, exist_ok=True)
        write_png(s1x, os.path.join(folder, f"{name}.png"))
        write_png(s2x, os.path.join(folder, f"{name}@2x.png"))
        meta_path = os.path.join(folder, "metadata.json")
        if not os.path.exists(meta_path):
            with open(meta_path, "w") as f:
                f.write('{"template": true}\n')
        print(f"wrote {folder}/ ({s1x}x, {s2x}x)")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        write_png(int(sys.argv[1]), sys.argv[2])
        print(f"wrote {sys.argv[2]} ({sys.argv[1]}x{sys.argv[1]})")
    else:
        regenerate_all()
