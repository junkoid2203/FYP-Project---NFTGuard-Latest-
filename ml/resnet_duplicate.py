# -*- coding: utf-8 -*-
"""
resnet_duplicate.py — duplicate / copy-mint detection via CNN image embeddings.

Beyond pHash: a pre-trained ResNet-50 turns each NFT image into a 2048-d embedding,
then copies are flagged by COSINE SIMILARITY. A re-uploaded ("copied") image scores
~1.0 against the original even though the copy has a brand-new tokenId + contract —
which is exactly the copy-mint scam heuristics/pHash struggle with.

Run:  ml/.venv/Scripts/python.exe ml/resnet_duplicate.py
"""
import io, sys, requests
import numpy as np
import torch
from torchvision import models, transforms
from PIL import Image, ImageEnhance

print("Loading pre-trained ResNet-50 (first run downloads ~100MB of weights)...")
model = models.resnet50(weights=models.ResNet50_Weights.DEFAULT)
model.fc = torch.nn.Identity()                 # drop the classifier -> feature extractor
model.eval()
pre = transforms.Compose([
    transforms.Resize(256), transforms.CenterCrop(224), transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

def embed(img):
    x = pre(img.convert("RGB")).unsqueeze(0)
    with torch.no_grad():
        v = model(x).squeeze().numpy()
    return v / (np.linalg.norm(v) + 1e-9)      # unit vector -> dot product == cosine

def cos(a, b):
    return float(np.dot(a, b))

# --- pull real NFT images from the running app ---
nfts = [n for n in requests.get("http://localhost:5000/api/nfts", timeout=15).json() if n.get("image")][:8]
print(f"Fetching {len(nfts)} real NFT images...")
items = []
for n in nfts:
    try:
        r = requests.get(n["image"], timeout=30); r.raise_for_status()
        items.append((n["name"], Image.open(io.BytesIO(r.content))))
    except Exception as e:
        print("  skip", n["name"], "-", e)
if len(items) < 2:
    sys.exit("Not enough images downloaded.")

embs = [(name, embed(img)) for name, img in items]

# --- SIMULATE A COPY-MINT: someone re-mints NFT #1's image under a NEW identity ---
orig_name, orig_img = items[0]
copy_emb = embed(orig_img)                       # identical pixels, "new token"
print("\n=== COPY-MINT DETECTION ===")
print(f'Scenario: a scammer re-mints "{orig_name}"\'s image as a brand-new NFT.')
sim_orig = cos(copy_emb, embs[0][1])
print(f"  copy vs the original image : {sim_orig:.3f}  -> {'DUPLICATE - FLAG' if sim_orig > 0.98 else 'ok'}")
others = [cos(copy_emb, e) for _, e in embs[1:]]
print(f"  copy vs other real NFTs    : max {max(others):.3f} · avg {np.mean(others):.3f}")

# --- HARDER, REALISTIC TEST: a *modified* copy (resized + cropped + recompressed) ---
# This is what a real copy-minter does — pHash / exact-match struggle here.
w, h = orig_img.size
mod = orig_img.convert("RGB").resize((180, 180)).crop((8, 8, 172, 172)).resize((w, h))
mod = ImageEnhance.Brightness(mod).enhance(1.12)
buf = io.BytesIO(); mod.save(buf, format="JPEG", quality=70); buf.seek(0)
mod_emb = embed(Image.open(buf))
sim_mod = cos(mod_emb, embs[0][1])
print(f"  MODIFIED copy (resize+crop+recompress) vs original : {sim_mod:.3f} -> {'DUPLICATE - FLAG' if sim_mod > 0.90 else 'missed'}")
print(f"  modified copy vs other real NFTs                   : max {max(cos(mod_emb, e) for _, e in embs[1:]):.3f}")

print("\n=== pairwise similarity of the genuinely-distinct NFTs (threshold 0.98) ===")
falsehits = 0
for i in range(len(embs)):
    for j in range(i + 1, len(embs)):
        s = cos(embs[i][1], embs[j][1])
        hit = s > 0.98
        falsehits += hit
        print(f"  {embs[i][0][:24]:24s} vs {embs[j][0][:24]:24s} = {s:.3f}{'  <- false-flag' if hit else ''}")
print(f"\nSummary: exact copy scored {sim_orig:.3f} (flagged); "
      f"{falsehits} false-positive(s) among {len(embs)*(len(embs)-1)//2} distinct pairs at threshold 0.98.")
