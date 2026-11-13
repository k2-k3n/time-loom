#!/usr/bin/env python3
"""Encode the approved visual into a real RGB565 screen asset and text masks.

Build output is checked in under src; Pillow/fonts are only needed to rebake art.
No font file is distributed. Baked UI glyphs are raster artwork.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
ROOT=Path(__file__).resolve().parents[1]
im=Image.open(ROOT/'art/reference.png').convert('RGB').resize((320,172),Image.Resampling.LANCZOS)
paper=(244,240,229)
d=ImageDraw.Draw(im)
d.rectangle((200,8,319,40),fill=paper)
d.rectangle((0,124,319,171),fill=paper)
pix=[((r&248)<<8)|((g&252)<<3)|(b>>3) for r,g,b in im.getdata()]
words=[pix[i]|(pix[i+1]<<16) for i in range(0,len(pix),2)]
out=['// Imagegen visual study, encoded to RGB565; SPDX-License-Identifier: MIT',
     '#pragma once','#include <stdint.h>', 'alignas(16) static const uint32_t loom_art_words[320*172/2]={']
out += [','.join(hex(v) for v in words[i:i+12])+',' for i in range(0,len(words),12)]
out += ['};']
small=ImageFont.truetype('/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf',13)
large=ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia.ttf',39)
for name,font,w,h,chars,y in [('small',small,10,16,''.join(chr(i) for i in range(32,91)),-3),('large',large,30,46,'0123456789/',-8)]:
    data=[]
    for ch in chars:
        glyph=Image.new('L',(w,h));ImageDraw.Draw(glyph).text((0,y),ch,font=font,fill=255)
        data.extend(glyph.tobytes())
    out += [f'static const uint8_t loom_{name}[{len(chars)}*{w}*{h}]={{']
    out += [','.join(str(v) for v in data[i:i+40])+',' for i in range(0,len(data),40)]
    out += ['};']
(ROOT/'src/art.h').write_text('\n'.join(out)+'\n')
im.save(ROOT/'art/background.png')
