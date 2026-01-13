"""
TAPIR Interactive Demo Server.

Run: python demo/tapir_demo.py
Open: http://localhost:8000
"""
import os
import sys
import urllib.request
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import cv2
import numpy as np
import torch
import torch.nn.functional as F

# Add backend to path
DEMO_DIR = Path(__file__).parent
BACKEND_DIR = DEMO_DIR.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from tapnet import tapir_model

# Constants
CHECKPOINT_PATH = BACKEND_DIR / "models" / "bootstapir_checkpoint_v2.pt"
VIDEO_URL = "https://storage.googleapis.com/dm-tapnet/horsejump-high.mp4"
VIDEO_PATH = DEMO_DIR / "videos" / "horsejump-high.mp4"
OUTPUT_PATH = DEMO_DIR / "tapir_demo_output.mp4"

# Global state
device = None
model = None
video_frames = None     # [T, H, W, C] original size
video_resized = None    # [T, 256, 256, 3] resized
orig_size = None        # (H, W)


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def init_app():
    global device, model, video_frames, video_resized, orig_size
    
    print("Initializing...")
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"Device: {device}")
    
    # Download video
    VIDEO_PATH.parent.mkdir(exist_ok=True)
    if not VIDEO_PATH.exists():
        print("Downloading video...")
        urllib.request.urlretrieve(VIDEO_URL, VIDEO_PATH)
    
    # Load video
    print("Loading video...")
    cap = cv2.VideoCapture(str(VIDEO_PATH))
    frames = []
    while len(frames) < 50:
        ret, frame = cap.read()
        if not ret: break
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    cap.release()
    video_frames = np.stack(frames, axis=0)
    orig_size = video_frames.shape[1:3]
    print(f"Video loaded: {video_frames.shape}")
    
    # Resize for model
    print("Resizing...")
    video_resized = np.stack([cv2.resize(f, (256, 256)) for f in video_frames])
    
    # Load model
    print("Loading model...")
    model = tapir_model.TAPIR(pyramid_level=1)
    model.load_state_dict(torch.load(CHECKPOINT_PATH, weights_only=True))
    model = model.to(device).eval()
    torch.set_grad_enabled(False)
    print("Ready!")


def preprocess_frames(frames):
    return frames.float() / 255 * 2 - 1


def postprocess_occlusions(occ, expd):
    return (1 - F.sigmoid(occ)) * (1 - F.sigmoid(expd)) > 0.5


def paint_tracks(video, tracks, visibles, query_points):
    """Paint tracks with trails and query marker."""
    out = video.copy()
    num_frames = video.shape[0]
    num_points = tracks.shape[0]
    
    # Color
    color = (0, 255, 0) # Green
    
    for t in range(num_frames):
        frame = out[t]
        for i in range(num_points):
            # Trail
            for prev_t in range(max(0, t - 15), t):
                if visibles[i, prev_t] and visibles[i, prev_t+1]:
                    p1 = tracks[i, prev_t].astype(int)
                    p2 = tracks[i, prev_t+1].astype(int)
                    cv2.line(frame, tuple(p1), tuple(p2), color, 2)
            
            # Point
            if visibles[i, t]:
                p = tracks[i, t].astype(int)
                cv2.circle(frame, tuple(p), 4, color, -1)
                
            # Query marker (on click frame)
            qt = int(query_points[i, 0])
            if t == qt:
                qp = query_points[i, 1:][::-1].astype(int) # y,x -> x,y
                cv2.drawMarker(frame, tuple(qp), (255, 0, 0), cv2.MARKER_CROSS, 15, 2)
                
    return out


@app.on_event("startup")
async def startup_event():
    init_app()


@app.get("/")
async def get_index():
    with open(DEMO_DIR / "view_demo.html", 'r', encoding='utf-8') as f:
        return HTMLResponse(f.read())


@app.get("/video")
async def get_video():
    if not OUTPUT_PATH.exists():
        # Fallback to source if no output yet
        return FileResponse(VIDEO_PATH)
    return FileResponse(OUTPUT_PATH)


@app.post("/track")
async def track_point(request: Request):
    data = await request.json()
    cx = data.get('x')  # Client click X (0-1) relative to video element
    cy = data.get('y')  # Client click Y (0-1) relative to video element
    
    print(f"Track request: rel=({cx:.3f}, {cy:.3f})")
    
    # Map to model coordinates
    mh, mw = 256, 256
    my = cy * mh
    mx = cx * mw
    
    # Create query [t, y, x]
    query_point = np.array([[0, my, mx]], dtype=np.float32) # Frame 0
    
    # Inference
    frames_tensor = torch.tensor(video_resized).to(device)
    query_tensor = torch.tensor(query_point).to(device)
    
    frames_input = preprocess_frames(frames_tensor)[None]
    query_input = query_tensor[None]
    
    print("Running inference...")
    outputs = model(frames_input, query_input)
    
    tracks = outputs['tracks'][0].cpu().numpy() # [1, T, 2]
    visibles = postprocess_occlusions(
        outputs['occlusion'][0], 
        outputs['expected_dist'][0]
    ).cpu().numpy()
    
    # Scale tracks to original size for viz
    tracks_scaled = tracks.copy()
    tracks_scaled[..., 0] *= orig_size[1] / mw
    tracks_scaled[..., 1] *= orig_size[0] / mh
    
    # Scale query for viz
    query_scaled = np.zeros((1, 3))
    query_scaled[0, 0] = 0
    query_scaled[0, 1] = my * (orig_size[0] / mh) # y
    query_scaled[0, 2] = mx * (orig_size[1] / mw) # x
    
    # Paint
    print("Painting video...")
    video_viz = paint_tracks(video_frames, tracks_scaled, visibles, query_scaled)
    
    # Save
    h, w = video_frames.shape[1:3]
    out = cv2.VideoWriter(str(OUTPUT_PATH), cv2.VideoWriter_fourcc(*'mp4v'), 10, (w, h))
    for frame in video_viz:
        out.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
    out.release()
    
    print("Done!")
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

