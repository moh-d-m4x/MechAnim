"""
TAPIR Tracker - Point tracking using official BootsTAPIR v2 model with PyTorch.

Uses the official DeepMind PyTorch implementation for accurate point tracking.
Processes ALL video frames at once for optimal accuracy.
"""
import numpy as np
from typing import List, Tuple, Optional
from pathlib import Path
from dataclasses import dataclass

import cv2
import torch
import torch.nn.functional as F

# Import official TAPIR model
from tapnet import tapir_model

# Model paths
MODELS_DIR = Path(__file__).parent / "models"
CHECKPOINT_PATH = MODELS_DIR / "bootstapir_checkpoint_v2.pt"


@dataclass
class TrackingPoint:
    """A tracked point with metadata."""
    x: float
    y: float
    frame: int
    confidence: float = 1.0
    visible: bool = True


def preprocess_frames(frames: torch.Tensor) -> torch.Tensor:
    """
    Preprocess frames to model inputs.
    
    Input: [T, H, W, C], [0, 255], uint8 or float tensor
    Output: [T, H, W, C], [-1, 1], float32
    """
    frames = frames.float()
    frames = frames / 255 * 2 - 1
    return frames


def postprocess_occlusions(occlusions: torch.Tensor, expected_dist: torch.Tensor) -> torch.Tensor:
    """Compute visibility from occlusion and expected distance."""
    visibles = (1 - F.sigmoid(occlusions)) * (1 - F.sigmoid(expected_dist)) > 0.5
    return visibles


class TAPIRTracker:
    """
    TAPIR-based point tracker using official PyTorch implementation.
    
    Uses BootsTAPIR v2 with full video processing for accurate tracking.
    """
    
    def __init__(self, input_size: int = 256):
        self.input_size = input_size
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.model_loaded = False
        self.model = None
        
        print(f"[TAPIR] Using device: {self.device}")
        self._load_model()
    
    def _load_model(self):
        """Load the TAPIR v2 model."""
        if not CHECKPOINT_PATH.exists():
            raise FileNotFoundError(f"[TAPIR] Checkpoint not found at {CHECKPOINT_PATH}")
        
        # Create model with BootsTAPIR settings (pyramid_level=1)
        self.model = tapir_model.TAPIR(pyramid_level=1)
        self.model.load_state_dict(torch.load(CHECKPOINT_PATH, weights_only=True))
        self.model = self.model.to(self.device)
        self.model = self.model.eval()
        torch.set_grad_enabled(False)
        
        self.model_loaded = True
        print(f"[TAPIR] Official model loaded successfully")
    
    def is_ready(self) -> bool:
        """Check if the tracker is ready for inference."""
        return self.model_loaded and self.model is not None
    
    def _resize_video(self, frames: List[np.ndarray]) -> np.ndarray:
        """Resize video frames to model input size."""
        resized = []
        for frame in frames:
            # Convert BGR to RGB
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            # Resize
            resized_frame = cv2.resize(rgb, (self.input_size, self.input_size))
            resized.append(resized_frame)
        return np.stack(resized, axis=0)
    
    def track_video(
        self,
        frames: List[np.ndarray],
        init_point: Tuple[float, float],
        init_frame: int = 0
    ) -> List[TrackingPoint]:
        """
        Track a point through all video frames using official TAPIR.
        
        Args:
            frames: List of video frames as numpy arrays (BGR)
            init_point: Initial point (x, y) in pixel coordinates
            init_frame: Frame index where tracking starts
            
        Returns:
            List of TrackingPoint objects for each frame
        """
        if not self.is_ready():
            raise RuntimeError("[TAPIR] Model not loaded")
        
        orig_height, orig_width = frames[0].shape[:2]
        num_frames = len(frames)
        
        print(f"[TAPIR] Processing {num_frames} frames, 1 point...")
        print(f"[TAPIR] Original: {orig_width}x{orig_height}, Model: {self.input_size}x{self.input_size}")
        
        # Resize video
        frames_resized = self._resize_video(frames)
        
        # Scale query point to model resolution
        scale_x = self.input_size / orig_width
        scale_y = self.input_size / orig_height
        model_x = init_point[0] * scale_x
        model_y = init_point[1] * scale_y
        
        # Create query point in [t, y, x] format (official format!)
        query_points = np.array([[init_frame, model_y, model_x]], dtype=np.float32)
        
        # Convert to tensors
        frames_tensor = torch.tensor(frames_resized).to(self.device)
        query_tensor = torch.tensor(query_points).to(self.device)
        
        # Preprocess and add batch dimension
        frames_preprocessed = preprocess_frames(frames_tensor)
        frames_preprocessed = frames_preprocessed[None]  # [1, T, H, W, C]
        query_tensor = query_tensor[None]  # [1, N, 3]
        
        # Run model inference
        print(f"[TAPIR] Running inference...")
        outputs = self.model(frames_preprocessed, query_tensor)
        
        tracks = outputs['tracks'][0]      # [N, T, 2]
        occlusions = outputs['occlusion'][0]  # [N, T]
        expected_dist = outputs['expected_dist'][0]
        
        # Compute visibility
        visibles = postprocess_occlusions(occlusions, expected_dist)
        
        # Convert to numpy
        tracks = tracks.cpu().numpy()  # [N, T, 2] in (x, y) format
        visibles = visibles.cpu().numpy()  # [N, T]
        
        # Scale tracks back to original resolution
        tracks[..., 0] = tracks[..., 0] / self.input_size * orig_width
        tracks[..., 1] = tracks[..., 1] / self.input_size * orig_height
        
        # Debug: print first few frames
        for i in range(min(3, num_frames)):
            x, y = tracks[0, i]
            print(f"[TAPIR] Frame {i}: init=({init_point[0]:.1f}, {init_point[1]:.1f}) -> tracked=({x:.1f}, {y:.1f})")
        
        # Convert results to TrackingPoint list
        path = []
        for frame_idx in range(num_frames):
            x = float(tracks[0, frame_idx, 0])
            y = float(tracks[0, frame_idx, 1])
            visible = bool(visibles[0, frame_idx])
            confidence = 1.0 if visible else 0.3
            
            path.append(TrackingPoint(
                x=x, y=y,
                frame=frame_idx, confidence=confidence, visible=visible
            ))
        
        print(f"[TAPIR] Tracked {len(path)} frames successfully")
        return path


# Singleton instance
_tracker_instance: Optional[TAPIRTracker] = None


def get_tracker() -> TAPIRTracker:
    """Get or create the singleton tracker instance."""
    global _tracker_instance
    if _tracker_instance is None:
        _tracker_instance = TAPIRTracker()
    return _tracker_instance
