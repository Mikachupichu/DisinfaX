import os
from PIL import Image

ARTIFACT_DIR = '/Users/michaelpouget/.gemini/antigravity/brain/120409ed-dc7a-46bb-9dfb-cecf73c722ae'
img_path = os.path.join(ARTIFACT_DIR, 'multi-claim-rendered-settled.png')
img = Image.open(img_path)
w, h = img.size
pixels = img.load()

# 1. crop-multi-claim-passage.png is the whole rendered passage image
img.save(os.path.join(ARTIFACT_DIR, 'crop-multi-claim-passage.png'))
print('Saved crop-multi-claim-passage.png')

# 2. Find white badge text '100% False'
# There are two badges: one around line 4 (top half), one around line 9 (bottom half)
whites_top = []
whites_bottom = []
mid_y = h // 2

for y in range(h):
    for x in range(w):
        r, g, b = pixels[x, y][:3]
        if r > 240 and g > 240 and b > 240:
            if y < mid_y:
                whites_top.append((x, y))
            else:
                whites_bottom.append((x, y))

# Badge 0 crop
if whites_top:
    min_x = min(p[0] for p in whites_top)
    max_x = max(p[0] for p in whites_top)
    min_y = min(p[1] for p in whites_top)
    max_y = max(p[1] for p in whites_top)
    b0_crop = img.crop((min_x - 160, min_y - 20, max_x + 30, max_y + 20))
    b0_crop.save(os.path.join(ARTIFACT_DIR, 'crop-multi-badge-claim0.png'))
    print('Saved crop-multi-badge-claim0.png')

# Badge 1 crop
if whites_bottom:
    min_x = min(p[0] for p in whites_bottom)
    max_x = max(p[0] for p in whites_bottom)
    min_y = min(p[1] for p in whites_bottom)
    max_y = max(p[1] for p in whites_bottom)
    b1_crop = img.crop((min_x - 160, min_y - 20, max_x + 30, max_y + 20))
    b1_crop.save(os.path.join(ARTIFACT_DIR, 'crop-multi-badge-claim1.png'))
    print('Saved crop-multi-badge-claim1.png')

# 3. Strike 0 crop (lines 1 & 2): top section of passage
s0_crop = img.crop((10, 40, w - 10, int(h * 0.38)))
s0_crop.save(os.path.join(ARTIFACT_DIR, 'crop-multi-strike-claim0.png'))
print('Saved crop-multi-strike-claim0.png')

# 4. Strike 1 crop (lines 6 & 7): middle/lower section of passage
s1_crop = img.crop((10, int(h * 0.48), w - 10, int(h * 0.78)))
s1_crop.save(os.path.join(ARTIFACT_DIR, 'crop-multi-strike-claim1.png'))
print('Saved crop-multi-strike-claim1.png')
