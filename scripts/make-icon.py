#!/usr/bin/env python3
"""芷湘启动图标生成（全新写）。

做法（用户定稿）：
- 整张白猫照片放背景层，不当前景、不抠图、不做单色层；
- 重构图：把照片放大到脸宽约 600px（108dp 画布上的中央 66dp 安全区一带），
  脸中心移到画布正中；画布边缘露出的部分用同一张照片的高斯模糊延伸补满；
- API 26+：自适应图标（背景层 = 重构图，前景层 = 全透明）；
- API 26 以下：预合成 ic_launcher.png（方形全幅）与 ic_launcher_round.png（圆形裁切）。

源图脸部估计（1080 坐标，目视）：脸中心 (410, 300)，脸宽约 420px。
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = Path.home() / 'workspace/goals/app/hidden_files/zhixiang-icon-source.jpg'
RES = ROOT / 'android/app/src/main/res'

# 108dp 画布按 10px/dp 绘制
CANVAS = 1080
# 锚点 = 双眼中心（蓝眼睛像素实测：源图 x=0.333、y=0.379），目标落在画布 (540, 515)，
# 即眼睛略高于正中，整张脸落在中央 66dp 安全区内。
EYES = (360, 409)
EYES_TARGET = (540, 515)
FACE_WIDTH = 420
TARGET_FACE = 600

img = Image.open(SRC).convert('RGB')
assert img.size == (1080, 1080), img.size

scale = TARGET_FACE / FACE_WIDTH
sharp = img.resize((round(1080 * scale), round(1080 * scale)), Image.LANCZOS)
ox = EYES_TARGET[0] - round(EYES[0] * scale)
oy = EYES_TARGET[1] - round(EYES[1] * scale)

# 模糊底：先裁掉源图顶部黑条（0-30 行），再拉伸回方形后高斯模糊
base_src = img.crop((0, 30, 1080, 1080)).resize((CANVAS, CANVAS), Image.LANCZOS)
base = base_src.filter(ImageFilter.GaussianBlur(60))
master = base.copy()
master.paste(sharp, (ox, oy))

# 自适应背景层（108dp）：mdpi 108 / hdpi 162 / xhdpi 216 / xxhdpi 324 / xxxhdpi 432
bg_densities = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
for density, size in bg_densities.items():
    d = RES / f'mipmap-{density}'
    d.mkdir(parents=True, exist_ok=True)
    master.resize((size, size), Image.LANCZOS).save(d / 'ic_launcher_background.png')
    Image.new('RGBA', (size, size), (0, 0, 0, 0)).save(d / 'ic_launcher_foreground.png')

# 预合成（48dp）：mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192
launcher_densities = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for density, size in launcher_densities.items():
    d = RES / f'mipmap-{density}'
    small = master.resize((size, size), Image.LANCZOS)
    small.save(d / 'ic_launcher.png')
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    rounded = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    rounded.paste(small.convert('RGBA'), (0, 0), mask)
    rounded.save(d / 'ic_launcher_round.png')

# 自适应 XML（API 26+）
anydpi = RES / 'mipmap-anydpi-v26'
anydpi.mkdir(parents=True, exist_ok=True)
for name, fg in (('ic_launcher', 'ic_launcher_foreground'), ('ic_launcher_round', 'ic_launcher_foreground')):
    (anydpi / f'{name}.xml').write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@mipmap/ic_launcher_background" />\n'
        f'    <foreground android:drawable="@mipmap/{fg}" />\n'
        '</adaptive-icon>\n'
    )

print('icon done')
