# -*- coding: utf-8 -*-
"""生成安卓 App 图标与启动图，风格与 PWA 的 icon.svg 保持一致
（蓝色渐变圆角方块 + 白色「客」字）。

输出：
  resources/icon.png    1024x1024  —— @capacitor/assets 生成各尺寸 mipmap 的源图
  resources/splash.png  2732x2732  —— 启动图（居中图标，白底）
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources")
os.makedirs(OUT, exist_ok=True)

C_TOP = (47, 134, 246)    # #2F86F6
C_BOTTOM = (31, 111, 235)  # #1F6FEB

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def pick_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def diagonal_gradient(size):
    """左上 -> 右下 线性渐变，对应 svg 里的 linearGradient(0,0 -> 1,1)"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2.0 * (size - 1))
            px[x, y] = (
                int(C_TOP[0] + (C_BOTTOM[0] - C_TOP[0]) * t),
                int(C_TOP[1] + (C_BOTTOM[1] - C_TOP[1]) * t),
                int(C_TOP[2] + (C_BOTTOM[2] - C_TOP[2]) * t),
            )
    return img


def make_icon(size=1024, rounded=True):
    ss = 2  # 超采样，边缘更干净
    S = size * ss
    base = diagonal_gradient(S).convert("RGBA")

    if rounded:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, S - 1, S - 1], radius=int(S * 104 / 512), fill=255
        )
        base.putalpha(mask)

    d = ImageDraw.Draw(base)
    # 内描边（对应 svg 里 40/512 边距、80/512 圆角、8/512 线宽的半透明白框）
    inset = int(S * 40 / 512)
    d.rounded_rectangle(
        [inset, inset, S - 1 - inset, S - 1 - inset],
        radius=int(S * 80 / 512),
        outline=(255, 255, 255, 46),
        width=max(2, int(S * 8 / 512)),
    )

    # 「客」字
    font = pick_font(int(S * 300 / 512))
    text = "客"
    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(
        ((S - tw) / 2 - box[0], (S - th) / 2 - box[1]),
        text, font=font, fill=(255, 255, 255, 255),
    )

    return base.resize((size, size), Image.LANCZOS)


# 1) 应用图标
icon = make_icon(1024, rounded=True)
icon.save(os.path.join(OUT, "icon.png"))
print("resources/icon.png  1024x1024")

# 2) 前景图（自适应图标用，圆角由系统裁剪，这里给方形满幅）
make_icon(1024, rounded=False).save(os.path.join(OUT, "icon-foreground.png"))
print("resources/icon-foreground.png  1024x1024")

# 3) 纯色背景图（自适应图标背景层）
Image.new("RGB", (1024, 1024), C_BOTTOM).save(os.path.join(OUT, "icon-background.png"))
print("resources/icon-background.png  1024x1024")

# 4) 启动图：白底 + 居中图标
SP = 2732
splash = Image.new("RGB", (SP, SP), (255, 255, 255))
logo = icon.resize((820, 820), Image.LANCZOS)
splash.paste(logo, ((SP - 820) // 2, (SP - 820) // 2), logo)
splash.save(os.path.join(OUT, "splash.png"))
print("resources/splash.png  2732x2732")

# 5) 深色启动图
splash_dark = Image.new("RGB", (SP, SP), (17, 24, 39))
splash_dark.paste(logo, ((SP - 820) // 2, (SP - 820) // 2), logo)
splash_dark.save(os.path.join(OUT, "splash-dark.png"))
print("resources/splash-dark.png  2732x2732")
