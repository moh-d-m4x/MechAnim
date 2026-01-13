"""
Model Manager - Handles TAPIR model downloads and GPU detection.
"""
import os
import sys
import subprocess
import urllib.request
import zipfile
import threading
from pathlib import Path
from typing import Optional, Dict, Any
from dataclasses import dataclass

# Model paths
MODELS_DIR = Path(__file__).parent / "models"
CHECKPOINT_PATH = MODELS_DIR / "bootstapir_checkpoint_v2.pt"  # PyTorch checkpoint (non-causal v2)
ONNX_DIR = MODELS_DIR / "onnxruntime"  # For future ONNX export

# Download URLs
CHECKPOINT_URL = "https://storage.googleapis.com/dm-tapnet/bootstap/bootstapir_checkpoint_v2.pt"
ONNX_GPU_URL = "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-gpu-1.23.2.zip"
ONNX_CPU_URL = "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip"


@dataclass
class DownloadProgress:
    """Track download progress."""
    file_name: str
    total_bytes: int
    downloaded_bytes: int
    is_complete: bool
    error: Optional[str] = None
    
    @property
    def percent(self) -> float:
        if self.total_bytes == 0:
            return 0
        return (self.downloaded_bytes / self.total_bytes) * 100


class ModelManager:
    """Manages TAPIR model files and ONNX runtime."""
    
    def __init__(self):
        self._current_download: Optional[DownloadProgress] = None
        self._download_thread: Optional[threading.Thread] = None
        self._cancel_requested: bool = False
        
    def check_models_exist(self) -> Dict[str, Any]:
        """Check if required model files exist."""
        checkpoint_exists = CHECKPOINT_PATH.exists()
        # DLLs are in lib/ subdirectory after extraction
        onnx_lib_dir = ONNX_DIR / "lib"
        onnx_exists = onnx_lib_dir.exists() and any(onnx_lib_dir.glob("*.dll"))
        
        print(f"[TAPIR] Model check: checkpoint={checkpoint_exists}, onnx={onnx_exists}")
        
        return {
            "checkpoint_exists": checkpoint_exists,
            "checkpoint_path": str(CHECKPOINT_PATH),
            "onnx_exists": onnx_exists,
            "onnx_path": str(ONNX_DIR),
            "ready": checkpoint_exists and onnx_exists
        }
    
    def detect_gpu(self) -> Dict[str, Any]:
        """Check for CUDA-compatible GPU."""
        result = {
            "gpu_available": False,
            "gpu_name": None,
            "cuda_version": None,
            "recommended": "cpu"
        }
        
        # Try using torch first
        try:
            import torch
            if torch.cuda.is_available():
                result["gpu_available"] = True
                result["gpu_name"] = torch.cuda.get_device_name(0)
                result["cuda_version"] = torch.version.cuda
                result["recommended"] = "gpu"
                return result
        except ImportError:
            pass
        
        # Fallback: check nvidia-smi
        try:
            proc = subprocess.run(
                ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                capture_output=True, text=True, timeout=5
            )
            if proc.returncode == 0 and proc.stdout.strip():
                result["gpu_available"] = True
                result["gpu_name"] = proc.stdout.strip().split('\n')[0]
                result["recommended"] = "gpu"
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        
        return result
    
    def get_download_progress(self) -> Optional[Dict[str, Any]]:
        """Get current download progress."""
        if self._current_download is None:
            return None
        
        return {
            "file_name": self._current_download.file_name,
            "total_bytes": self._current_download.total_bytes,
            "downloaded_bytes": self._current_download.downloaded_bytes,
            "percent": self._current_download.percent,
            "is_complete": self._current_download.is_complete,
            "error": self._current_download.error
        }
    
    def start_download(self, use_gpu: bool = False) -> Dict[str, Any]:
        """Start downloading required model files in background."""
        if self._download_thread and self._download_thread.is_alive():
            return {"status": "already_downloading"}
        
        # Create models directory
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        
        # Reset cancel flag
        self._cancel_requested = False
        
        # Initialize progress immediately so polling works right away
        self._current_download = DownloadProgress(
            file_name="Preparing download...",
            total_bytes=0,
            downloaded_bytes=0,
            is_complete=False
        )
        
        # Start download in background thread
        self._download_thread = threading.Thread(
            target=self._download_files,
            args=(use_gpu,),
            daemon=True
        )
        self._download_thread.start()
        
        return {"status": "started"}
    
    def _download_files(self, use_gpu: bool):
        """Download checkpoint and ONNX runtime."""
        try:
            # Download checkpoint if not exists
            if not CHECKPOINT_PATH.exists():
                print(f"[TAPIR] Starting checkpoint download from {CHECKPOINT_URL}")
                # Set initial progress with estimate
                self._current_download = DownloadProgress(
                    file_name="BootsTAPIR Checkpoint",
                    total_bytes=200 * 1024 * 1024,  # ~200MB estimate
                    downloaded_bytes=0,
                    is_complete=False
                )
                self._download_file(CHECKPOINT_URL, CHECKPOINT_PATH, "BootsTAPIR Checkpoint")
                print(f"[TAPIR] Checkpoint download complete")
            else:
                print(f"[TAPIR] Checkpoint already exists")
            
            # Download ONNX runtime if not exists (DLLs are in lib/ subdirectory)
            onnx_lib_dir = ONNX_DIR / "lib"
            if not (onnx_lib_dir.exists() and any(onnx_lib_dir.glob("*.dll"))):
                onnx_url = ONNX_GPU_URL if use_gpu else ONNX_CPU_URL
                zip_name = "onnxruntime-gpu.zip" if use_gpu else "onnxruntime-cpu.zip"
                zip_path = MODELS_DIR / zip_name
                
                print(f"[TAPIR] Starting ONNX Runtime download from {onnx_url}")
                # Set initial progress with estimate
                self._current_download = DownloadProgress(
                    file_name="ONNX Runtime",
                    total_bytes=180 * 1024 * 1024,  # ~180MB estimate
                    downloaded_bytes=0,
                    is_complete=False
                )
                self._download_file(onnx_url, zip_path, "ONNX Runtime")
                print(f"[TAPIR] ONNX Runtime download complete")
                
                # Extract zip
                self._current_download = DownloadProgress(
                    file_name="Extracting ONNX Runtime...",
                    total_bytes=1,
                    downloaded_bytes=0,
                    is_complete=False
                )
                
                import shutil
                
                with zipfile.ZipFile(zip_path, 'r') as zf:
                    # Extract to temp folder first
                    extract_dir = MODELS_DIR / "onnx_temp"
                    if extract_dir.exists():
                        shutil.rmtree(extract_dir, ignore_errors=True)
                    zf.extractall(extract_dir)
                    
                    # Copy inner folder contents to onnxruntime/
                    inner_folders = list(extract_dir.iterdir())
                    if inner_folders:
                        inner_folder = inner_folders[0]
                        if inner_folder.is_dir():
                            # Remove existing onnxruntime folder if exists
                            if ONNX_DIR.exists():
                                shutil.rmtree(ONNX_DIR, ignore_errors=True)
                            # Copy the entire folder
                            shutil.copytree(inner_folder, ONNX_DIR)
                    
                    # Cleanup temp folder
                    shutil.rmtree(extract_dir, ignore_errors=True)
                
                # Remove zip file
                zip_path.unlink(missing_ok=True)
                
                self._current_download.downloaded_bytes = 1
                self._current_download.is_complete = True
            
            # Mark complete
            self._current_download = DownloadProgress(
                file_name="Complete",
                total_bytes=100,
                downloaded_bytes=100,
                is_complete=True
            )
            
        except Exception as e:
            if self._current_download:
                self._current_download.error = str(e)
                self._current_download.is_complete = True
    
    def _download_file(self, url: str, dest_path: Path, display_name: str):
        """Download a file with progress tracking using requests."""
        import requests
        
        # Ensure progress object exists
        if self._current_download is None:
            self._current_download = DownloadProgress(
                file_name=display_name,
                total_bytes=200 * 1024 * 1024,  # Default estimate
                downloaded_bytes=0,
                is_complete=False
            )
        else:
            # Update existing (keep estimated total_bytes)
            self._current_download.file_name = display_name
            self._current_download.downloaded_bytes = 0
            self._current_download.is_complete = False
            self._current_download.error = None
        
        max_retries = 3
        retry_delay = 5
        
        for attempt in range(max_retries):
            try:
                # Stream download with progress - allow redirects, longer timeout
                # Use tuple timeout: (connect_timeout, read_timeout)
                response = requests.get(
                    url, 
                    stream=True, 
                    timeout=(30, 300),  # 30s connect, 5min read timeout
                    allow_redirects=True,
                    headers={'User-Agent': 'MechAnim-Downloader/1.0'}
                )
                response.raise_for_status()
                break  # Success, exit retry loop
            except requests.exceptions.Timeout:
                if attempt < max_retries - 1:
                    print(f"[TAPIR] Timeout, retrying in {retry_delay}s... (attempt {attempt + 2}/{max_retries})")
                    self._current_download.file_name = f"Retrying... ({attempt + 2}/{max_retries})"
                    import time
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    raise
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    print(f"[TAPIR] Error: {e}, retrying...")
                    self._current_download.file_name = f"Retrying... ({attempt + 2}/{max_retries})"
                    import time
                    time.sleep(retry_delay)
                else:
                    raise
        
        try:
            # Only update total_bytes if server provides valid content-length
            # Otherwise keep the estimated size that was set earlier
            server_total = int(response.headers.get('content-length', 0))
            if server_total > 0:
                self._current_download.total_bytes = server_total
            elif self._current_download.total_bytes == 0:
                # Fallback estimate if nothing set
                if 'bootstapir' in url:
                    self._current_download.total_bytes = 200 * 1024 * 1024
                else:
                    self._current_download.total_bytes = 180 * 1024 * 1024
            
            downloaded = 0
            chunk_size = 65536  # 64KB chunks for faster progress updates
            
            with open(dest_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=chunk_size):
                    if self._cancel_requested:
                        f.close()
                        dest_path.unlink(missing_ok=True)
                        self._current_download.error = "Download cancelled"
                        self._current_download.is_complete = True
                        return
                    
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        self._current_download.downloaded_bytes = downloaded
                        # Update display name with progress
                        self._current_download.file_name = f"Downloading... ({downloaded // (1024*1024)}MB)"
            
        except Exception as e:
            self._current_download.error = str(e)
            raise
    
    def cancel_download(self):
        """Request cancellation of current download."""
        self._cancel_requested = True
        if self._current_download:
            self._current_download.error = "Cancelling..."


# Global instance
model_manager = ModelManager()
