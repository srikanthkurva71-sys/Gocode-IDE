from pathlib import Path
import struct
import zlib

# Generate dependency-free application icons for Tauri on Windows and Linux.
SIZE = 32
pixels = bytearray()
for y in range(SIZE - 1, -1, -1):
    for x in range(SIZE):
        border = (x < 2 or x > 29 or y < 2 or y > 29)
        b, g, r = (92, 48, 28) if border else (235, 125, 72)
        in_ring = 7 <= x <= 24 and 7 <= y <= 24 and (
            x <= 10 or x >= 21 or y <= 10 or y >= 21
        )
        crossbar = 16 <= x <= 24 and 15 <= y <= 18
        open_gap = x >= 19 and y < 15
        if (in_ring and not open_gap) or crossbar:
            b, g, r = 245, 248, 255
        pixels.extend((b, g, r, 255))

target_dir = Path("src-tauri/icons")
target_dir.mkdir(parents=True, exist_ok=True)

# Windows ICO (bottom-up BGRA DIB).
and_mask = bytes(((SIZE + 31) // 32) * 4 * SIZE)
dib = struct.pack("<IIIHHIIIIII",
    40, SIZE, SIZE * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0
) + pixels + and_mask
ico_header = struct.pack("<HHH", 0, 1, 1)
ico_entry = struct.pack("<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(dib), 22)
ico_path = target_dir / "icon.ico"
ico_path.write_bytes(ico_header + ico_entry + dib)

# Portable PNG (top-down RGBA scanlines).
rows = []
for row_index in range(SIZE):
    start = (SIZE - 1 - row_index) * SIZE * 4
    source_row = pixels[start:start + SIZE * 4]
    rgba = bytearray()
    for offset in range(0, len(source_row), 4):
        blue, green, red, alpha = source_row[offset:offset + 4]
        rgba.extend((red, green, blue, alpha))
    rows.append(b"\x00" + bytes(rgba))

def png_chunk(kind, data):
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    )

png = (
    b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    + png_chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + png_chunk(b"IEND", b"")
)
png_path = target_dir / "icon.png"
png_path.write_bytes(png)
print(f"Generated {ico_path} and {png_path}")
