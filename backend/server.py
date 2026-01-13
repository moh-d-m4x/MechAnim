"""
FastAPI server for video tracking with TAPIR.
"""
import os
import base64
import tempfile
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from tracker import SinglePointTracker, TrackingPoint, smooth_path
from tapir_tracker import get_tracker as get_tapir_tracker
from model_manager import model_manager


def extract_frames_from_video(video_path: str):
    """Extract frames from video file."""
    import cv2
    cap = cv2.VideoCapture(video_path)
    frames = []
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(frame)
    
    cap.release()
    return frames, fps


app = FastAPI(title="MechAnim Tracking API", version="1.0.0")

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class InitPoint(BaseModel):
    x: float
    y: float
    frame: int = 0


class TrackRequest(BaseModel):
    video_data: str  # Base64 encoded video
    init_point: InitPoint
    video_format: str = "mp4"
    smooth: bool = True
    tracking_method: str = "euclidean"  # euclidean, frobenius, mean_euclidean, mean_manhattan


class PathPoint(BaseModel):
    x: float
    y: float
    frame: int
    confidence: float = 1.0
    corrected: bool = False
    visible: bool = True


class TrackResponse(BaseModel):
    success: bool
    path: List[PathPoint]
    fps: float
    duration: float  # milliseconds
    frame_count: int
    error: Optional[str] = None


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "tracking"}


# ============ Model Management Endpoints ============

@app.get("/models/status")
async def get_model_status():
    """Check if required TAPIR model files exist."""
    return model_manager.check_models_exist()


@app.get("/models/gpu-check")
async def check_gpu():
    """Check if GPU is available for TAPIR inference."""
    return model_manager.detect_gpu()


class DownloadRequest(BaseModel):
    use_gpu: bool = False


@app.post("/models/download")
async def start_model_download(request: DownloadRequest):
    """Start downloading required model files."""
    return model_manager.start_download(use_gpu=request.use_gpu)


@app.get("/models/download-progress")
async def get_download_progress():
    """Get current download progress."""
    progress = model_manager.get_download_progress()
    if progress is None:
        return {"status": "idle"}
    return progress


@app.post("/models/cancel")
async def cancel_download():
    """Cancel current download."""
    model_manager.cancel_download()
    return {"status": "cancelled"}


# ============ Tracking Endpoints ============

@app.post("/track", response_model=TrackResponse)
async def track_video(request: TrackRequest):
    """
    Track a single point through a video.
    
    Expects base64-encoded video and initial point coordinates.
    Returns the motion path as a list of (x, y, frame) coordinates.
    """
    try:
        # Decode base64 video
        video_bytes = base64.b64decode(request.video_data)
        
        # Save to temporary file
        suffix = f".{request.video_format}"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
            tmp_file.write(video_bytes)
            tmp_path = tmp_file.name
        
        try:
            # Extract frames
            frames, fps = extract_frames_from_video(tmp_path)
            
            if len(frames) == 0:
                raise HTTPException(status_code=400, detail="Could not extract frames from video")
            
            # Track the point using TAPIR
            tapir = get_tapir_tracker()
            path = tapir.track_video(
                frames=frames,
                init_point=(request.init_point.x, request.init_point.y),
                init_frame=request.init_point.frame
            )
            
            # Convert to response format
            path_points = [PathPoint(
                x=p.x, y=p.y, frame=p.frame, 
                confidence=p.confidence, corrected=getattr(p, 'corrected', False),
                visible=p.visible
            ) for p in path]
            
            # Calculate duration
            duration = (len(frames) / fps) * 1000 if fps > 0 else 0
            
            return TrackResponse(
                success=True,
                path=path_points,
                fps=fps,
                duration=duration,
                frame_count=len(frames)
            )
            
        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
                
    except Exception as e:
        return TrackResponse(
            success=False,
            path=[],
            fps=0,
            duration=0,
            frame_count=0,
            error=str(e)
        )


@app.post("/extract-frame")
async def extract_single_frame(video_data: str, frame_index: int = 0, video_format: str = "mp4"):
    """
    Extract a single frame from video as base64 image.
    """
    try:
        video_bytes = base64.b64decode(video_data)
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{video_format}") as tmp_file:
            tmp_file.write(video_bytes)
            tmp_path = tmp_file.name
        
        try:
            import cv2
            cap = cv2.VideoCapture(tmp_path)
            
            # Seek to frame
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ret, frame = cap.read()
            cap.release()
            
            if not ret:
                raise HTTPException(status_code=400, detail="Could not read frame")
            
            # Encode as PNG
            _, buffer = cv2.imencode('.png', frame)
            frame_b64 = base64.b64encode(buffer).decode('utf-8')
            
            return {"success": True, "frame": frame_b64, "format": "png"}
            
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
                
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class CorrectionRequest(BaseModel):
    video_data: str  # Base64 encoded video
    video_format: str = "mp4"
    init_point: InitPoint
    corrections: dict  # {frame_idx: {x: float, y: float}}
    smooth: bool = True
    tracking_method: str = "euclidean"


@app.post("/correct", response_model=TrackResponse)
async def correct_tracking(request: CorrectionRequest):
    """
    Re-run tracking with manual corrections applied.
    
    User can specify corrections for specific frames, and tracking
    will use those positions and continue from there.
    """
    try:
        # Decode base64 video
        video_bytes = base64.b64decode(request.video_data)
        
        # Save to temporary file
        suffix = f".{request.video_format}"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
            tmp_file.write(video_bytes)
            tmp_path = tmp_file.name
        
        try:
            # Extract frames
            frames, fps = extract_frames_from_video(tmp_path)
            
            if len(frames) == 0:
                raise HTTPException(status_code=400, detail="Could not extract frames from video")
            
            # Create tracker with corrections
            tracker = SinglePointTracker(distance_threshold=50.0, method=request.tracking_method)
            
            # Apply corrections
            for frame_str, coords in request.corrections.items():
                frame_idx = int(frame_str)
                tracker.correct_point(frame_idx, coords['x'], coords['y'])
            
            # Track with corrections applied
            path = tracker.track_video(
                frames=frames,
                init_point=(request.init_point.x, request.init_point.y),
                init_frame=request.init_point.frame
            )
            
            # Apply smoothing if requested
            if request.smooth:
                path = smooth_path(path, window_size=5)
            
            # Convert to response format
            path_points = [PathPoint(
                x=p.x, y=p.y, frame=p.frame, 
                confidence=p.confidence, corrected=p.corrected
            ) for p in path]
            
            # Calculate duration
            duration = (len(frames) / fps) * 1000 if fps > 0 else 0
            
            return TrackResponse(
                success=True,
                path=path_points,
                fps=fps,
                duration=duration,
                frame_count=len(frames)
            )
            
        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
                
    except Exception as e:
        return TrackResponse(
            success=False,
            path=[],
            fps=0,
            duration=0,
            frame_count=0,
            error=str(e)
        )


if __name__ == "__main__":
    print("Starting MechAnim Tracking Server...")
    print("API docs available at http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000)
