import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Upload, Crosshair, Play, Square, Eye, ArrowRight, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { Point, TrackingPoint, MotionPath } from '../types';
import { trackVideo, fileToBase64, getVideoFormat, checkBackendHealth } from '../utils/trackingApi';
import { parseGIF, decompressFrames } from 'gifuct-js';

interface TrackingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onTransfer: (path: Point[]) => void;
}

interface VideoState {
    file: File | null;
    url: string;
    frames: string[];  // Data URLs for each frame
    currentFrame: number;
    totalFrames: number;
    fps: number;
    width: number;
    height: number;
    isLoading: boolean;
    isGif: boolean;
}

export const TrackingModal: React.FC<TrackingModalProps> = ({ isOpen, onClose, onTransfer }) => {
    // State
    const [videoState, setVideoState] = useState<VideoState>({
        file: null,
        url: '',
        frames: [],
        currentFrame: 0,
        totalFrames: 0,
        fps: 30,
        width: 640,
        height: 480,
        isLoading: false,
        isGif: false
    });

    // Rectangle selection state (replacing single point)
    const [trackingRect, setTrackingRect] = useState<{
        x: number; y: number;  // Top-left corner
        width: number; height: number;
    } | null>(null);
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);

    const [motionPath, setMotionPath] = useState<TrackingPoint[]>([]);
    const [isTracking, setIsTracking] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');
    const [error, setError] = useState<string | null>(null);
    const [trackingMethod, setTrackingMethod] = useState<'euclidean' | 'frobenius' | 'mean_euclidean' | 'mean_manhattan'>('euclidean');

    // Manual correction state
    const [editMode, setEditMode] = useState(false);
    const [corrections, setCorrections] = useState<Record<number, { x: number; y: number }>>({});
    const [draggingPoint, setDraggingPoint] = useState<number | null>(null);  // Frame index being dragged

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const gifFrameImagesRef = useRef<HTMLImageElement[]>([]);

    // Check backend health
    useEffect(() => {
        if (!isOpen) return;

        const check = async () => {
            const online = await checkBackendHealth();
            setBackendStatus(online ? 'online' : 'offline');
        };

        check();
        const interval = setInterval(check, 10000);
        return () => clearInterval(interval);
    }, [isOpen]);

    // Handle file selection - support both video and GIF
    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setVideoState(prev => ({ ...prev, isLoading: true, file }));
        setTrackingRect(null);
        setMotionPath([]);
        setShowPreview(false);
        setError(null);
        setIsPlaying(false);

        try {
            const url = URL.createObjectURL(file);
            const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');

            if (isGif) {
                // Extract GIF frames using gifuct-js
                const arrayBuffer = await file.arrayBuffer();
                const gif = parseGIF(arrayBuffer);
                const frames = decompressFrames(gif, true);

                if (frames.length === 0) {
                    throw new Error('No frames found in GIF');
                }

                const width = frames[0].dims.width;
                const height = frames[0].dims.height;

                // Create a canvas to render frames
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                const tempCtx = tempCanvas.getContext('2d')!;

                // Accumulator canvas for proper GIF rendering (handles disposal)
                const accCanvas = document.createElement('canvas');
                accCanvas.width = width;
                accCanvas.height = height;
                const accCtx = accCanvas.getContext('2d')!;

                // Extract each frame as a data URL
                const frameDataUrls: string[] = [];
                const frameImages: HTMLImageElement[] = [];
                let totalDelay = 0;

                for (let i = 0; i < frames.length; i++) {
                    const frame = frames[i];
                    const { dims, patch, delay } = frame;

                    totalDelay += delay || 100;

                    // Create ImageData from patch
                    const imageData = new ImageData(
                        new Uint8ClampedArray(patch),
                        dims.width,
                        dims.height
                    );

                    // Draw to temp canvas
                    tempCtx.clearRect(0, 0, width, height);
                    tempCtx.putImageData(imageData, dims.left || 0, dims.top || 0);

                    // Composite onto accumulator
                    accCtx.drawImage(tempCanvas, 0, 0);

                    // Save frame as data URL
                    const dataUrl = accCanvas.toDataURL('image/png');
                    frameDataUrls.push(dataUrl);

                    // Pre-load image for fast rendering
                    const img = new Image();
                    img.src = dataUrl;
                    frameImages.push(img);
                }

                gifFrameImagesRef.current = frameImages;

                // Calculate FPS from average delay
                const avgDelay = totalDelay / frames.length;
                const fps = Math.round(1000 / avgDelay);

                setVideoState({
                    file,
                    url,
                    frames: frameDataUrls,
                    currentFrame: 0,
                    totalFrames: frames.length,
                    fps: Math.max(fps, 1),
                    width,
                    height,
                    isLoading: false,
                    isGif: true
                });
            } else {
                // Load video
                const video = document.createElement('video');
                video.src = url;

                await new Promise<void>((resolve, reject) => {
                    video.onloadedmetadata = () => resolve();
                    video.onerror = () => reject(new Error('Failed to load video'));
                });

                const duration = video.duration;
                const fps = 30;
                const totalFrames = Math.floor(duration * fps);

                setVideoState({
                    file,
                    url,
                    frames: [],
                    currentFrame: 0,
                    totalFrames: Math.max(totalFrames, 1),
                    fps,
                    width: video.videoWidth || 640,
                    height: video.videoHeight || 480,
                    isLoading: false,
                    isGif: false
                });

                video.remove();
            }
        } catch (err) {
            setError('Failed to load media: ' + (err instanceof Error ? err.message : 'Unknown error'));
            setVideoState(prev => ({ ...prev, isLoading: false }));
        }
    };

    // Seek to frame and redraw canvas
    const seekToFrame = useCallback((frame: number) => {
        setVideoState(prev => ({ ...prev, currentFrame: frame }));

        // For videos, also seek the video element
        if (videoRef.current && !videoState.isGif) {
            const time = frame / videoState.fps;
            videoRef.current.currentTime = time;
        }
    }, [videoState.fps, videoState.isGif]);

    // Animation playback loop
    useEffect(() => {
        if (!isPlaying || videoState.totalFrames <= 1) return;

        const interval = setInterval(() => {
            setVideoState(prev => ({
                ...prev,
                currentFrame: (prev.currentFrame + 1) % prev.totalFrames
            }));
        }, 1000 / videoState.fps);

        return () => clearInterval(interval);
    }, [isPlaying, videoState.fps, videoState.totalFrames]);

    // Helper to convert mouse event to canvas coordinates
    const getCanvasCoordinates = (event: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;

        const rect = canvas.getBoundingClientRect();
        const canvasAspect = canvas.width / canvas.height;
        const containerAspect = rect.width / rect.height;

        let renderWidth, renderHeight, offsetX, offsetY;
        if (canvasAspect > containerAspect) {
            renderWidth = rect.width;
            renderHeight = rect.width / canvasAspect;
            offsetX = 0;
            offsetY = (rect.height - renderHeight) / 2;
        } else {
            renderHeight = rect.height;
            renderWidth = rect.height * canvasAspect;
            offsetX = (rect.width - renderWidth) / 2;
            offsetY = 0;
        }

        const clickX = event.clientX - rect.left - offsetX;
        const clickY = event.clientY - rect.top - offsetY;

        if (clickX < 0 || clickX > renderWidth || clickY < 0 || clickY > renderHeight) {
            return null;
        }

        return {
            x: (clickX / renderWidth) * canvas.width,
            y: (clickY / renderHeight) * canvas.height
        };
    };

    // Handle mouse DOWN - start rectangle selection
    const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || !videoState.url) return; // Left click only

        const coords = getCanvasCoordinates(event);
        if (!coords) return;

        setIsSelecting(true);
        setSelectionStart(coords);
        setTrackingRect({ x: coords.x, y: coords.y, width: 0, height: 0 });
        setMotionPath([]);
        setShowPreview(false);
    };

    // Handle mouse MOVE - update rectangle size during drag
    const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (!isSelecting || !selectionStart) return;

        const coords = getCanvasCoordinates(event);
        if (!coords) return;

        // Calculate rectangle from start to current position
        const x = Math.min(selectionStart.x, coords.x);
        const y = Math.min(selectionStart.y, coords.y);
        const width = Math.abs(coords.x - selectionStart.x);
        const height = Math.abs(coords.y - selectionStart.y);

        setTrackingRect({ x, y, width, height });
    };

    // Handle mouse UP - finish rectangle selection
    const handleCanvasMouseUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (!isSelecting || !selectionStart) return;

        const coords = getCanvasCoordinates(event);
        if (coords) {
            const x = Math.min(selectionStart.x, coords.x);
            const y = Math.min(selectionStart.y, coords.y);
            const width = Math.abs(coords.x - selectionStart.x);
            const height = Math.abs(coords.y - selectionStart.y);

            // Minimum size check - if too small, treat as a point click
            if (width < 10 && height < 10) {
                setTrackingRect({ x: coords.x - 20, y: coords.y - 20, width: 40, height: 40 });
            } else {
                setTrackingRect({ x, y, width, height });
            }
        }

        setIsSelecting(false);
        setSelectionStart(null);
    };

    // Handle canvas RIGHT click to CLEAR selection
    const handleCanvasRightClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        setTrackingRect(null);
        setMotionPath([]);
        setShowPreview(false);
        setIsSelecting(false);
        setSelectionStart(null);
    };

    // Draw current frame and overlays
    useEffect(() => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const img = imgRef.current;
        if (!canvas || !videoState.url) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const draw = () => {
            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw frame from video or GIF
            if (videoState.isGif && videoState.frames.length > 0) {
                // Use extracted GIF frames
                const frameImg = gifFrameImagesRef.current[videoState.currentFrame];
                if (frameImg && frameImg.complete) {
                    ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
                }
            } else if (video && !videoState.isGif) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }

            // Draw tracking rectangle selection
            if (trackingRect) {
                const scaleX = canvas.width / videoState.width;
                const scaleY = canvas.height / videoState.height;

                // Draw the rectangle
                ctx.strokeStyle = isSelecting ? 'rgba(0, 255, 0, 0.6)' : 'rgba(0, 200, 0, 1)';
                ctx.lineWidth = 2;
                ctx.setLineDash(isSelecting ? [5, 5] : []);
                const rx = trackingRect.x * scaleX;
                const ry = trackingRect.y * scaleY;
                const rw = trackingRect.width * scaleX;
                const rh = trackingRect.height * scaleY;
                ctx.strokeRect(rx, ry, rw, rh);
                ctx.setLineDash([]);

                // Draw center point marker
                const px = (trackingRect.x + trackingRect.width / 2) * scaleX;
                const py = (trackingRect.y + trackingRect.height / 2) * scaleY;

                ctx.beginPath();
                ctx.arc(px, py, 6, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 255, 0, 0.8)';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Draw motion path preview
            if (showPreview && motionPath.length > 1) {
                const scaleX = canvas.width / videoState.width;
                const scaleY = canvas.height / videoState.height;

                ctx.beginPath();
                ctx.moveTo(motionPath[0].x * scaleX, motionPath[0].y * scaleY);

                for (let i = 1; i < motionPath.length; i++) {
                    ctx.lineTo(motionPath[i].x * scaleX, motionPath[i].y * scaleY);
                }

                ctx.strokeStyle = 'rgba(0, 200, 255, 0.8)';
                ctx.lineWidth = 3;
                ctx.stroke();

                // Highlight current frame position
                const currentPoint = motionPath[videoState.currentFrame] || motionPath[motionPath.length - 1];
                if (currentPoint) {
                    ctx.beginPath();
                    ctx.arc(currentPoint.x * scaleX, currentPoint.y * scaleY, 6, 0, Math.PI * 2);
                    ctx.fillStyle = '#00ff00';
                    ctx.fill();
                }
            }

            // Continue animation loop if playing GIF
            if (isPlaying && videoState.isGif) {
                animationFrameId = requestAnimationFrame(draw);
            }
        };

        draw();

        // Cleanup
        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }, [videoState.currentFrame, videoState.isGif, trackingRect, motionPath, showPreview, videoState.width, videoState.height, videoState.url, isPlaying, isSelecting]);

    // Run tracking
    const handleRunTracking = async () => {
        if (!videoState.file || !trackingRect || backendStatus !== 'online') return;

        setIsTracking(true);
        setError(null);

        try {
            const base64Video = await fileToBase64(videoState.file);
            const format = getVideoFormat(videoState.file.name);

            // Calculate center of the selection rectangle for init point
            const centerX = trackingRect.x + trackingRect.width / 2;
            const centerY = trackingRect.y + trackingRect.height / 2;

            const response = await trackVideo({
                videoData: base64Video,
                initPoint: { x: centerX, y: centerY, frame: videoState.currentFrame },
                videoFormat: format,
                smooth: true,
                trackingMethod: trackingMethod
            });

            if (response.success && response.path.length > 0) {
                setMotionPath(response.path);
                setShowPreview(true);  // Auto-enable preview after tracking
                setVideoState(prev => ({
                    ...prev,
                    fps: response.fps || prev.fps,
                    totalFrames: response.frameCount || prev.totalFrames
                }));
            } else {
                setError(response.error || 'Tracking failed');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Tracking failed');
        } finally {
            setIsTracking(false);
        }
    };

    // Transfer path to main canvas - centered
    const handleTransfer = () => {
        if (motionPath.length === 0) return;

        // Calculate bounding box of the path
        const xs = motionPath.map(p => p.x);
        const ys = motionPath.map(p => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const pathWidth = maxX - minX;
        const pathHeight = maxY - minY;
        const pathCenterX = minX + pathWidth / 2;
        const pathCenterY = minY + pathHeight / 2;

        // Target center (assume 800x600 main canvas, center at 400,300)
        const targetCenterX = 400;
        const targetCenterY = 300;

        // Calculate offset to center the path
        const offsetX = targetCenterX - pathCenterX;
        const offsetY = targetCenterY - pathCenterY;

        // Convert to Point array and apply centering offset
        const points: Point[] = motionPath.map(p => ({
            x: p.x + offsetX,
            y: p.y + offsetY
        }));

        onTransfer(points);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-800 rounded-xl shadow-2xl w-[95vw] h-[95vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
                    <div className="flex items-center gap-3">
                        <Crosshair className="w-5 h-5 text-blue-400" />
                        <h2 className="text-lg font-semibold text-white">Motion Tracking</h2>
                        {backendStatus === 'checking' && (
                            <span className="flex items-center gap-1 text-xs text-yellow-400">
                                <Loader2 className="w-3 h-3 animate-spin" /> Connecting...
                            </span>
                        )}
                        {backendStatus === 'online' && (
                            <span className="flex items-center gap-1 text-xs text-green-400">
                                <CheckCircle className="w-3 h-3" /> Backend Online (Norfair)
                            </span>
                        )}
                        {backendStatus === 'offline' && (
                            <span className="flex items-center gap-1 text-xs text-red-400">
                                <AlertCircle className="w-3 h-3" /> Backend Offline
                            </span>
                        )}
                    </div>

                    {/* Distance Function Selector */}
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-slate-400">Distance:</label>
                        <select
                            value={trackingMethod}
                            onChange={(e) => setTrackingMethod(e.target.value as typeof trackingMethod)}
                            className="bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 focus:outline-none focus:border-blue-500"
                        >
                            <option value="euclidean">Euclidean</option>
                            <option value="frobenius">Frobenius</option>
                            <option value="mean_euclidean">Mean Euclidean</option>
                            <option value="mean_manhattan">Mean Manhattan</option>
                        </select>
                    </div>

                    {/* Edit Mode Toggle */}
                    {motionPath.length > 0 && (
                        <button
                            onClick={() => setEditMode(!editMode)}
                            className={`flex items-center gap-1 px-3 py-1 rounded text-sm transition-colors ${editMode
                                ? 'bg-orange-600 text-white'
                                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                                }`}
                            title="Enable edit mode to drag and correct tracking points"
                        >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                            {editMode ? 'Editing' : 'Edit Path'}
                        </button>
                    )}

                    <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded">
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                {/* Main Content */}
                <div className="flex-1 flex flex-col p-4 gap-4 overflow-auto">
                    {/* Video Canvas */}
                    <div className="relative bg-slate-900 rounded-lg overflow-hidden flex-1" style={{ minHeight: '500px' }}>
                        {!videoState.url ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
                                <Upload className="w-12 h-12 mb-3" />
                                <p>Load a video or GIF to begin tracking</p>
                            </div>
                        ) : (
                            <>
                                {/* Hidden video element for video files */}
                                {!videoState.isGif && (
                                    <video
                                        ref={videoRef}
                                        src={videoState.url}
                                        className="hidden"
                                        onLoadedData={() => {
                                            if (canvasRef.current && videoRef.current) {
                                                const ctx = canvasRef.current.getContext('2d');
                                                if (ctx) ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                                            }
                                        }}
                                        onSeeked={() => {
                                            if (canvasRef.current && videoRef.current) {
                                                const ctx = canvasRef.current.getContext('2d');
                                                if (ctx) ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                                            }
                                        }}
                                    />
                                )}

                                {/* GIF display - show actual img when playing for native animation */}
                                {videoState.isGif && (
                                    <img
                                        ref={imgRef}
                                        src={videoState.url}
                                        alt="GIF preview"
                                        className={`absolute inset-0 w-full h-full object-contain cursor-crosshair ${isPlaying ? 'block' : 'hidden'}`}
                                        onClick={(e) => {
                                            // Handle click on the img element too
                                            if (!canvasRef.current) return;
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            const canvas = canvasRef.current;
                                            const canvasAspect = canvas.width / canvas.height;
                                            const containerAspect = rect.width / rect.height;

                                            let renderWidth, renderHeight, offsetX, offsetY;
                                            if (canvasAspect > containerAspect) {
                                                renderWidth = rect.width;
                                                renderHeight = rect.width / canvasAspect;
                                                offsetX = 0;
                                                offsetY = (rect.height - renderHeight) / 2;
                                            } else {
                                                renderHeight = rect.height;
                                                renderWidth = rect.height * canvasAspect;
                                                offsetX = (rect.width - renderWidth) / 2;
                                                offsetY = 0;
                                            }

                                            const clickX = e.clientX - rect.left - offsetX;
                                            const clickY = e.clientY - rect.top - offsetY;

                                            if (clickX < 0 || clickX > renderWidth || clickY < 0 || clickY > renderHeight) return;

                                            const x = (clickX / renderWidth) * canvas.width;
                                            const y = (clickY / renderHeight) * canvas.height;

                                            // Create a small rectangle for point clicks on the GIF image
                                            setTrackingRect({ x: x - 20, y: y - 20, width: 40, height: 40 });
                                            setMotionPath([]);
                                            setShowPreview(false);
                                        }}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            setTrackingRect(null);
                                            setMotionPath([]);
                                            setShowPreview(false);
                                        }}
                                        onLoad={() => {
                                            if (canvasRef.current && imgRef.current) {
                                                const ctx = canvasRef.current.getContext('2d');
                                                if (ctx) ctx.drawImage(imgRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                                            }
                                        }}
                                    />
                                )}

                                {/* SVG overlay for path - shows during playback or when preview is on */}
                                {showPreview && motionPath.length > 1 && (
                                    <svg
                                        className="absolute inset-0 w-full h-full pointer-events-none"
                                        viewBox={`0 0 ${videoState.width} ${videoState.height}`}
                                        preserveAspectRatio="xMidYMid meet"
                                    >
                                        {/* Full path line */}
                                        <polyline
                                            points={motionPath.map(p => `${p.x},${p.y}`).join(' ')}
                                            fill="none"
                                            stroke="rgba(0, 200, 255, 0.8)"
                                            strokeWidth="3"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                        {/* Current frame position marker */}
                                        {motionPath[videoState.currentFrame] && (
                                            <circle
                                                cx={motionPath[videoState.currentFrame].x}
                                                cy={motionPath[videoState.currentFrame].y}
                                                r="8"
                                                fill="#00ff00"
                                                stroke="#ffffff"
                                                strokeWidth="2"
                                            />
                                        )}
                                    </svg>
                                )}

                                {/* Canvas - hidden when playing GIF, visible otherwise */}
                                <canvas
                                    ref={canvasRef}
                                    width={videoState.width}
                                    height={videoState.height}
                                    onMouseDown={handleCanvasMouseDown}
                                    onMouseMove={handleCanvasMouseMove}
                                    onMouseUp={handleCanvasMouseUp}
                                    onMouseLeave={handleCanvasMouseUp}
                                    onContextMenu={handleCanvasRightClick}
                                    className={`w-full h-full cursor-crosshair object-contain ${videoState.isGif && isPlaying ? 'hidden' : 'block'}`}
                                />
                            </>
                        )}

                        {videoState.isLoading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                                <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
                            </div>
                        )}
                    </div>

                    {/* Timeline Slider */}
                    {videoState.url && (
                        <div className="flex items-center gap-3 px-2">
                            {/* Play/Stop Button */}
                            <button
                                onClick={() => setIsPlaying(!isPlaying)}
                                className={`p-2 rounded-lg transition-colors ${isPlaying
                                    ? 'bg-red-600 hover:bg-red-500 text-white'
                                    : 'bg-green-600 hover:bg-green-500 text-white'
                                    }`}
                                title={isPlaying ? 'Stop' : 'Play'}
                            >
                                {isPlaying ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                            </button>

                            <span className="text-xs text-slate-400 w-20">
                                Frame {videoState.currentFrame + 1} / {videoState.totalFrames}
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={Math.max(0, videoState.totalFrames - 1)}
                                value={videoState.currentFrame}
                                onChange={(e) => {
                                    setIsPlaying(false);  // Stop playback when user drags
                                    seekToFrame(parseInt(e.target.value));
                                }}
                                className="flex-1 accent-blue-500 cursor-pointer"
                            />
                            <span className="text-xs text-slate-400 w-16 text-right">
                                {(videoState.currentFrame / videoState.fps).toFixed(2)}s
                            </span>
                        </div>
                    )}

                    {/* Error Display */}
                    {error && (
                        <div className="bg-red-900/30 border border-red-500/50 rounded-lg px-4 py-2 text-red-300 text-sm flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" />
                            {error}
                        </div>
                    )}
                </div>

                {/* Controls Footer */}
                <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 bg-slate-800/50">
                    <div className="flex gap-2 items-center">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="video/mp4,video/webm,image/gif"
                            onChange={handleFileSelect}
                            className="hidden"
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                        >
                            <Upload className="w-4 h-4" />
                            Load Media
                        </button>

                        {/* Path Info - between Load Media and Run Tracking */}
                        {motionPath.length > 0 && (
                            <span className="text-green-400 text-sm px-3">
                                ✓ Tracked {motionPath.length} points
                            </span>
                        )}
                    </div>

                    <div className="flex gap-2">
                        <button
                            onClick={handleRunTracking}
                            disabled={!trackingRect || isTracking || backendStatus !== 'online'}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                        >
                            {isTracking ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Tracking...
                                </>
                            ) : (
                                <>
                                    <Play className="w-4 h-4" />
                                    Run Tracking
                                </>
                            )}
                        </button>

                        <button
                            onClick={handleTransfer}
                            disabled={motionPath.length === 0}
                            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                        >
                            <ArrowRight className="w-4 h-4" />
                            Transfer as Drawing
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
