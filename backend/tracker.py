"""
Single-point tracker for motion path extraction.
Uses OpenCV calcOpticalFlowPyrLK (Pyramidal Lucas-Kanade) as detector.
TAPIR model is now the primary method for Auto detection.
"""
import numpy as np
from typing import List, Tuple, Optional
from dataclasses import dataclass
import cv2


@dataclass
class TrackingPoint:
    x: float
    y: float
    frame: int
    confidence: float = 1.0  # 1.0 = detected, 0.0 = predicted/occluded
    corrected: bool = False  # True if manually corrected by user


class SinglePointTracker:
    """
    Tracks a single point through video frames using:
    - Detector: OpenCV cv2.calcOpticalFlowPyrLK (Pyramidal Lucas-Kanade)
    - Tracker: Norfair (Kalman filtering + Hungarian matching)
    - Recovery: Re-lock on reappearance after occlusion
    """
    
    # Optical flow parameters (optimized for tracking)
    LK_PARAMS = dict(
        winSize=(21, 21),  # Window size for optical flow
        maxLevel=3,        # Pyramid levels
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
    )
    
    # Occlusion detection thresholds
    OCCLUSION_ERROR_THRESHOLD = 10.0  # Max error to consider valid
    RELOCK_DISTANCE_THRESHOLD = 50.0  # Max distance to snap back from prediction
    
    def __init__(self, distance_threshold: float = 50.0, method: str = 'euclidean'):
        self.distance_threshold = distance_threshold
        self.method = method
        self.path: List[TrackingPoint] = []
        self.corrections: dict = {}  # frame_idx -> (x, y) manual corrections
        
    def track_video(
        self, 
        frames: List[np.ndarray], 
        init_point: Tuple[float, float],
        init_frame: int = 0
    ) -> List[TrackingPoint]:
        """
        Track a single point through all video frames.
        
        Uses RAW Pyramidal Lucas-Kanade optical flow for detection.
        NO Kalman filter lag - positions are exactly where detected.
        Smoothing is applied as post-processing (not during tracking).
        """
        self.path = []
        
        current_point = np.array([[init_point[0], init_point[1]]])
        prev_gray = None
        last_valid_point = init_point
        
        for frame_idx, frame in enumerate(frames):
            # Check for manual corrections
            if frame_idx in self.corrections:
                corrected = self.corrections[frame_idx]
                current_point = np.array([[corrected[0], corrected[1]]])
                self.path.append(TrackingPoint(
                    x=corrected[0], y=corrected[1], 
                    frame=frame_idx, confidence=1.0, corrected=True
                ))
                prev_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
                last_valid_point = (corrected[0], corrected[1])
                continue
            
            if frame_idx < init_frame:
                # Before init frame, use init point
                self.path.append(TrackingPoint(
                    x=init_point[0], y=init_point[1], 
                    frame=frame_idx, confidence=0.5
                ))
                continue
            
            # Convert to grayscale
            curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
            
            if frame_idx == init_frame:
                # First frame at init point - use directly (no Kalman)
                self.path.append(TrackingPoint(
                    x=init_point[0], y=init_point[1], 
                    frame=frame_idx, confidence=1.0
                ))
                prev_gray = curr_gray
                last_valid_point = init_point
                continue
            
            # Run optical flow detection - use RAW result (no Kalman filter)
            detected_point, confidence, flow_error = self._detect_with_optical_flow(
                prev_gray, curr_gray, current_point
            )
            
            if confidence >= 0.5:
                # Good detection - use directly (no Kalman lag!)
                self.path.append(TrackingPoint(
                    x=detected_point[0], y=detected_point[1], 
                    frame=frame_idx, confidence=confidence
                ))
                current_point = np.array([[detected_point[0], detected_point[1]]])
                last_valid_point = detected_point
            else:
                # Occlusion - use last valid point (could interpolate later in post-process)
                self.path.append(TrackingPoint(
                    x=last_valid_point[0], y=last_valid_point[1], 
                    frame=frame_idx, confidence=confidence
                ))
            
            prev_gray = curr_gray
        
        return self.path
    
    def _detect_with_optical_flow(
        self,
        prev_gray: np.ndarray,
        curr_gray: np.ndarray,
        prev_point: np.ndarray
    ) -> Tuple[Tuple[float, float], float, float]:
        """
        Detect point in current frame using Pyramidal Lucas-Kanade optical flow.
        
        Returns:
            (x, y): Detected point coordinates
            confidence: Detection confidence (0-1)
            error: Optical flow error
        """
        try:
            # Format point for optical flow
            prev_pts = prev_point.reshape(-1, 1, 2).astype(np.float32)
            
            # Run Lucas-Kanade optical flow
            next_pts, status, error = cv2.calcOpticalFlowPyrLK(
                prev_gray, curr_gray, prev_pts, None, **self.LK_PARAMS
            )
            
            if status[0][0] == 1:  # Point was found
                x, y = next_pts[0][0]
                err = error[0][0] if error is not None else 0.0
                
                # Calculate confidence based on error
                if err < self.OCCLUSION_ERROR_THRESHOLD:
                    confidence = max(0.5, 1.0 - (err / self.OCCLUSION_ERROR_THRESHOLD) * 0.5)
                else:
                    confidence = 0.3  # Low confidence but still detected
                
                return (float(x), float(y)), confidence, err
            else:
                # Point not found - occlusion or out of frame
                return (prev_point[0][0], prev_point[0][1]), 0.0, 999.0
                
        except Exception as e:
            print(f"Optical flow error: {e}")
            return (prev_point[0][0], prev_point[0][1]), 0.0, 999.0
    
    def correct_point(self, frame_idx: int, new_x: float, new_y: float):
        """
        Store a manual correction for a specific frame.
        Call track_video again to apply corrections.
        """
        self.corrections[frame_idx] = (new_x, new_y)
    
    def clear_corrections(self):
        """Clear all manual corrections."""
        self.corrections = {}
    
    def _fallback_track(
        self, 
        frames: List[np.ndarray], 
        init_point: Tuple[float, float],
        init_frame: int
    ) -> List[TrackingPoint]:
        """
        Fallback tracker using only OpenCV optical flow (no Norfair).
        """
        path = []
        current_point = np.array([[init_point[0], init_point[1]]])
        prev_gray = None
        
        for frame_idx, frame in enumerate(frames):
            if frame_idx < init_frame:
                path.append(TrackingPoint(x=init_point[0], y=init_point[1], frame=frame_idx))
                continue
            
            curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
            
            if frame_idx == init_frame:
                path.append(TrackingPoint(x=init_point[0], y=init_point[1], frame=frame_idx))
                prev_gray = curr_gray
                continue
            
            # Use optical flow
            detected, confidence, _ = self._detect_with_optical_flow(
                prev_gray, curr_gray, current_point
            )
            
            current_point = np.array([[detected[0], detected[1]]])
            path.append(TrackingPoint(x=detected[0], y=detected[1], frame=frame_idx))
            prev_gray = curr_gray
        
        return path


def smooth_path(path: List[TrackingPoint], window_size: int = 5) -> List[TrackingPoint]:
    """
    Apply simple moving average smoothing to the path.
    """
    if len(path) < window_size:
        return path
    
    smoothed = []
    for i, point in enumerate(path):
        start = max(0, i - window_size // 2)
        end = min(len(path), i + window_size // 2 + 1)
        
        # Only smooth non-corrected points
        if point.corrected:
            smoothed.append(point)
        else:
            avg_x = sum(p.x for p in path[start:end]) / (end - start)
            avg_y = sum(p.y for p in path[start:end]) / (end - start)
            smoothed.append(TrackingPoint(
                x=avg_x, y=avg_y, 
                frame=point.frame, 
                confidence=point.confidence,
                corrected=point.corrected
            ))
    
    return smoothed
