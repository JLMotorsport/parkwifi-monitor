"""Generates the app, tray and favicon images. Run: python scripts/make-icons.py"""
from PIL import Image, ImageDraw

S = 1024
BLUE = (42, 120, 214, 255)
WHITE = (255, 255, 255, 255)

def glyph(size, bg=True, fg=WHITE):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bg:
        d.rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=BLUE)
    cx, cy = S // 2, int(S * 0.70)
    w = 78 if bg else 110
    for r in (380, 270, 160):
        d.arc([cx - r, cy - r, cx + r, cy + r], start=225, end=315, fill=fg, width=w)
    d.ellipse([cx - 62, cy - 62, cx + 62, cy + 62], fill=fg)
    return im.resize((size, size), Image.LANCZOS)

app = glyph(256)
app.save("assets/icon.png")
glyph(64).save("src/ui/public/favicon.png")
glyph(1024).save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

for name, col in {"good": (12, 163, 12, 255), "warning": (250, 178, 25, 255), "critical": (208, 59, 59, 255)}.items():
    big = glyph(1024)
    d = ImageDraw.Draw(big)
    d.ellipse([560, 40, 1000, 480], fill=col, outline=(255, 255, 255, 255), width=60)
    big.resize((32, 32), Image.LANCZOS).save(f"assets/tray-{name}.png")
    big.resize((64, 64), Image.LANCZOS).save(f"assets/tray-{name}@2x.png")
print("ok")
