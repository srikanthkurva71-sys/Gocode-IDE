from pathlib import Path
import struct

# Generate a small, dependency-free Windows ICO for Tauri's resource compiler.
# The icon is a blue tile with a simple white, pixel-style G mark.
SIZE = 32
pixels = bytearray()
for y in range(SIZE - 1, -1, -1):
    for x in range(SIZE):
        # B, G, R, A (bottom-up DIB pixel order)
        border = (x < 2 or x > 29 or y < 2 or y > 29)
        # BGR values for a saturated blue tile and a deep-blue border.
        b, g, r = (92, 48, 28) if border else (235, 125, 72)
        # A blocky G: white outer ring with a right-side opening and crossbar.
        in_ring = 7 <= x <= 24 and 7 <= y <= 24 and (
            x <= 10 or x >= 21 or y <= 10 or y >= 21
        )
        crossbar = 16 <= x <= 24 and 15 <= y <= 18
        open_gap = x >= 19 and y < 15
        if (in_ring and not open_gap) or crossbar:
            b, g, r = 245, 248, 255
        pixels.extend((b, g, r, 255))

and_mask = bytes(((SIZE + 31) // 32) * 4 * SIZE)
dib = struct.pack("<IIIHHIIIIII",
    40, SIZE, SIZE * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0
) + pixels + and_mask
ico_header = struct.pack("<HHH", 0, 1, 1)
ico_entry = struct.pack("<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(dib), 22)
target = Path("src-tauri/icons/icon.ico")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(ico_header + ico_entry + dib)
print(f"Generated {target}")
