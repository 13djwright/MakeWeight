"""Annotate a 2x screenshot with numbered callouts.

python3 annotate.py in.png out.png spec.json
spec: {"scale":2, "crop":[x,y,w,h] (css px, optional), "callouts":[{"n":1,"box":[x,y,w,h],"text":"…","at":"right|left|top|bottom","dx":0,"dy":0,"width":260}],
       "title": optional caption drawn on a band at the bottom}
All coordinates are CSS pixels (1x); the image is 2x.
"""
import json, sys, textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ACCENT = (217, 95, 27); INK = (34, 34, 34); INK2 = (95, 95, 95); RULE = (214, 209, 200); CARD = (255, 255, 255)
FONT = "/usr/share/fonts/truetype/google-fonts/Poppins-Regular.ttf"
FONT_B = "/usr/share/fonts/truetype/google-fonts/Poppins-Medium.ttf"


def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def shadow(im, box, r, blur=14, alpha=70, offset=(0, 6)):
    x0, y0, x1, y1 = box
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((x0 + offset[0], y0 + offset[1], x1 + offset[0], y1 + offset[1]), radius=r, fill=(0, 0, 0, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    im.alpha_composite(layer)


def main(src, dst, spec_path):
    spec = json.load(open(spec_path))
    s = spec.get("scale", 2)
    im = Image.open(src).convert("RGBA")
    if spec.get("crop"):
        x, y, w, h = spec["crop"]; im = im.crop((x * s, y * s, (x + w) * s, (y + h) * s))
    ox, oy = (spec["crop"][0], spec["crop"][1]) if spec.get("crop") else (0, 0)
    pad = spec.get("pad", 0) * s
    if pad:
        bg = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), (246, 245, 242, 255)); bg.paste(im, (pad, pad)); im = bg
    f = ImageFont.truetype(FONT, int(13.5 * s)); fb = ImageFont.truetype(FONT_B, int(13.5 * s)); fn = ImageFont.truetype(FONT_B, int(12 * s))
    d = ImageDraw.Draw(im)
    P = lambda v: v * s
    markers_only = spec.get("style") == "markers"
    fbig = ImageFont.truetype(FONT_B, int(14 * s))
    for c in spec["callouts"]:
        bx, by, bw, bh = c["box"]; bx -= ox; by -= oy
        x0, y0, x1, y1 = P(bx) - P(4) + pad, P(by) - P(4) + pad, P(bx + bw) + P(4) + pad, P(by + bh) + P(4) + pad
        # highlight ring
        glow = Image.new("RGBA", im.size, (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
        gd.rounded_rectangle((x0 - P(3), y0 - P(3), x1 + P(3), y1 + P(3)), radius=P(9), outline=ACCENT + (70 if markers_only else 90,), width=int(P(5)))
        im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(P(3))))
        d = ImageDraw.Draw(im)
        rrect(d, (x0, y0, x1, y1), P(7), outline=ACCENT, width=int(P(2.5)))
        if markers_only:
            # numbered badge only; the explanation is a numbered list next to the image
            pos = c.get("badge", "tl")
            bxc = {"l": x0, "r": x1, "c": (x0 + x1) / 2}[pos[1] if len(pos) > 1 else "l"] if pos not in ("l", "r") else {"l": x0, "r": x1}[pos]
            byc = {"t": y0, "b": y1, "m": (y0 + y1) / 2}[pos[0]] if pos not in ("l", "r") else (y0 + y1) / 2
            bxc += P(c.get("bdx", 0)); byc += P(c.get("bdy", 0))
            br = P(13)
            shadow(im, (bxc - br, byc - br, bxc + br, byc + br), br, blur=P(3), alpha=90, offset=(0, P(2))); d = ImageDraw.Draw(im)
            d.ellipse((bxc - br, byc - br, bxc + br, byc + br), fill=ACCENT, outline="white", width=int(P(2.5)))
            d.text((bxc, byc), str(c["n"]), fill="white", font=fbig, anchor="mm")
            continue
        # label card
        width = P(c.get("width", 250))
        lines = []
        maxw = width - P(28)
        for pi, para in enumerate(c["text"].split("\n")):
            font = fb if pi == 0 else f
            avail = maxw - (P(10) + 2 * P(10) + P(10) if pi == 0 else 0)
            cur = ""
            for word in para.split():
                trial = (cur + " " + word).strip()
                if font.getlength(trial) <= avail or not cur:
                    cur = trial
                else:
                    lines.append(cur); cur = word
            lines.append(cur)
        lh = P(19); th = lh * len(lines) + P(20)
        at = c.get("at", "right"); dx, dy = P(c.get("dx", 0)), P(c.get("dy", 0))
        if at == "right": cx0, cy0 = x1 + P(22), y0
        elif at == "left": cx0, cy0 = x0 - P(22) - width, y0
        elif at == "top": cx0, cy0 = x0, y0 - P(22) - th
        else: cx0, cy0 = x0, y1 + P(22)
        cx0 += dx; cy0 += dy
        cx0 = max(P(6), min(cx0, im.width - width - P(6))); cy0 = max(P(6), min(cy0, im.height - th - P(6)))
        card = (cx0, cy0, cx0 + width, cy0 + th)
        # connector: from badge to card's nearest edge
        badge_c = (x0, y0)
        near = (min(max(badge_c[0], card[0]), card[2]), min(max(badge_c[1], card[1]), card[3]))
        d.line([badge_c, near], fill=ACCENT, width=int(P(2)))
        shadow(im, card, P(8)); d = ImageDraw.Draw(im)
        rrect(d, card, P(8), fill=CARD, outline=RULE, width=int(P(1)))
        # number chip in card
        chip_r = P(10); ccx, ccy = cx0 + P(14) + chip_r, cy0 + P(10) + chip_r
        d.ellipse((ccx - chip_r, ccy - chip_r, ccx + chip_r, ccy + chip_r), fill=ACCENT)
        d.text((ccx, ccy), str(c["n"]), fill="white", font=fn, anchor="mm")
        ty = cy0 + P(10)
        for i, ln in enumerate(lines):
            d.text((cx0 + P(14) + 2 * chip_r + P(10) if i == 0 else cx0 + P(14), ty), ln, fill=INK, font=fb if i == 0 and c.get("bold_first", True) else f)
            ty += lh
        # badge on the element
        br = P(11)
        d.ellipse((x0 - br, y0 - br, x0 + br, y0 + br), fill=ACCENT, outline="white", width=int(P(2)))
        d.text((x0, y0), str(c["n"]), fill="white", font=fn, anchor="mm")
    out = im.convert("RGB")
    if spec.get("downscale"):
        out = out.resize((int(out.width * spec["downscale"]), int(out.height * spec["downscale"])), Image.LANCZOS)
    out.save(dst, optimize=True)
    print(dst, out.size)


if __name__ == "__main__":
    main(*sys.argv[1:4])
