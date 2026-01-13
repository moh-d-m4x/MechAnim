import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Upload, Crosshair, Play, Square, Eye, ArrowRight, Loader2, AlertCircle, CheckCircle, Download } from 'lucide-react';
import { Point, TrackingPoint, MotionPath } from '../types';
import { trackVideo, fileToBase64, getVideoFormat, checkBackendHealth, checkModelStatus, ModelStatus } from '../utils/trackingApi';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { ModelDownloadDialog } from './ModelDownloadDialog';

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
    const [isAutoDetection, setIsAutoDetection] = useState(false);  // false = Manual (default)
    const [manualPoints, setManualPoints] = useState<{ x: number; y: number }[]>([]);  // Points placed in manual mode
    const [enableSmoothing, setEnableSmoothing] = useState(true);  // Smoothing checkbox - default ON
    const [connectEndPoints, setConnectEndPoints] = useState(true);  // Connect first/last points - default ON
    const [redrawKey, setRedrawKey] = useState(0);  // Used to force canvas redraw
    const [hoveredManualPoint, setHoveredManualPoint] = useState<number | null>(null);  // Index of point under mouse
    const [draggingManualPoint, setDraggingManualPoint] = useState<number | null>(null);  // Index of point being dragged
    const [corrections, setCorrections] = useState<Record<number, { x: number; y: number }>>({});
    const [draggingPoint, setDraggingPoint] = useState<number | null>(null);  // Frame index being dragged
    const [isDraggingFile, setIsDraggingFile] = useState(false);  // For drag-drop file upload
    const [showDownloadDialog, setShowDownloadDialog] = useState(false);  // TAPIR model download
    const [tapirModelsReady, setTapirModelsReady] = useState(false);  // Whether TAPIR models are downloaded

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

    // Clear selections when switching between Auto and Manual mode
    useEffect(() => {
        setManualPoints([]);
        setTrackingRect(null);
        setMotionPath([]);
        setShowPreview(false);

        // Check TAPIR model status when switching to Auto mode
        if (isAutoDetection) {
            checkModelStatus().then(status => {
                if (status) {
                    setTapirModelsReady(status.ready);
                    if (!status.ready) {
                        setShowDownloadDialog(true);
                    }
                }
            });
        }
    }, [isAutoDetection]);

    // Force canvas redraw when modal opens (to show existing manual points)
    useEffect(() => {
        if (isOpen) {
            // Increment redrawKey to force canvas redraw immediately
            setRedrawKey(prev => prev + 1);
        }
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

    // Process a dropped or selected file
    const processDroppedFile = async (file: File) => {
        const validTypes = ['video/mp4', 'video/webm', 'image/gif'];
        const isValidExtension = file.name.toLowerCase().match(/\.(mp4|webm|gif)$/);

        if (!validTypes.includes(file.type) && !isValidExtension) {
            setError('Unsupported format. Please use MP4, WebM, or GIF.');
            return;
        }

        // Simulate file input change event
        const fakeEvent = {
            target: { files: [file] }
        } as unknown as React.ChangeEvent<HTMLInputElement>;

        await handleFileSelect(fakeEvent);
    };

    // Drag and drop handlers
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingFile(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingFile(false);
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingFile(false);

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            await processDroppedFile(files[0]);
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
            setVideoState(prev => {
                const nextFrame = (prev.currentFrame + 1) % prev.totalFrames;

                // For videos, seek the video element
                if (!prev.isGif && videoRef.current) {
                    videoRef.current.currentTime = nextFrame / prev.fps;
                }

                return { ...prev, currentFrame: nextFrame };
            });
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

    // Helper: Find if a point is at the given coordinates (within hit radius)
    const getManualPointAtPosition = (coords: { x: number; y: number }): number | null => {
        const HIT_RADIUS = 15;  // Pixels tolerance for clicking on a point
        for (let i = 0; i < manualPoints.length; i++) {
            const pt = manualPoints[i];
            const dist = Math.hypot(pt.x - coords.x, pt.y - coords.y);
            if (dist <= HIT_RADIUS) {
                return i;
            }
        }
        return null;
    };

    // Handle mouse DOWN - manual mode: drag point or add new, auto mode: single click point selection
    const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || !videoState.url) return; // Left click only

        const coords = getCanvasCoordinates(event);
        if (!coords) return;

        if (!isAutoDetection) {
            // MANUAL MODE: Check if clicking on existing point to drag, or add new
            const pointIndex = getManualPointAtPosition(coords);
            if (pointIndex !== null) {
                // Start dragging existing point
                setDraggingManualPoint(pointIndex);
            } else {
                // Add new point
                setManualPoints(prev => [...prev, coords]);
            }
        } else {
            // AUTO MODE: Single click point selection (no rectangle dragging)
            // Create a small tracking rect centered on the click point
            setTrackingRect({ x: coords.x - 20, y: coords.y - 20, width: 40, height: 40 });
            setMotionPath([]);
            setShowPreview(false);
        }
    };

    // Handle mouse MOVE - drag manual point, update rectangle, or track hover
    const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
        const coords = getCanvasCoordinates(event);
        if (!coords) return;

        // Manual mode: Handle point dragging or hover detection
        if (!isAutoDetection) {
            if (draggingManualPoint !== null) {
                // Update dragged point position
                setManualPoints(prev => prev.map((pt, i) =>
                    i === draggingManualPoint ? coords : pt
                ));
            } else {
                // Check for hover over points
                const pointIndex = getManualPointAtPosition(coords);
                setHoveredManualPoint(pointIndex);
            }
            return;
        }

        // Auto mode: Update rectangle selection
        if (!isSelecting || !selectionStart) return;

        const x = Math.min(selectionStart.x, coords.x);
        const y = Math.min(selectionStart.y, coords.y);
        const width = Math.abs(coords.x - selectionStart.x);
        const height = Math.abs(coords.y - selectionStart.y);

        setTrackingRect({ x, y, width, height });
    };

    // Handle mouse UP - finish rectangle selection or stop dragging
    const handleCanvasMouseUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
        // Stop any manual point dragging
        if (draggingManualPoint !== null) {
            setDraggingManualPoint(null);
            return;
        }

        // Auto mode: finish rectangle selection
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

    // Handle canvas RIGHT click - delete single point in manual mode, clear all in auto mode
    const handleCanvasRightClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
        event.preventDefault();

        if (!isAutoDetection) {
            // MANUAL MODE: Delete only the clicked point (if any)
            const coords = getCanvasCoordinates(event);
            if (coords) {
                const pointIndex = getManualPointAtPosition(coords);
                if (pointIndex !== null) {
                    // Remove only this point
                    setManualPoints(prev => prev.filter((_, i) => i !== pointIndex));
                    return;
                }
            }
            // No point clicked - don't do anything
        } else {
            // AUTO MODE: Clear all selection
            setTrackingRect(null);
            setMotionPath([]);
            setShowPreview(false);
            setIsSelecting(false);
            setSelectionStart(null);
        }
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

            // Draw manual mode points with connecting lines (closed path)
            if (!isAutoDetection && manualPoints.length > 0) {
                const scaleX = canvas.width / videoState.width;
                const scaleY = canvas.height / videoState.height;

                // Calculate display points (smoothed or original)
                let displayPoints = manualPoints;

                if (enableSmoothing && manualPoints.length >= 3) {
                    const smoothed: { x: number; y: number }[] = [];
                    const pointCount = manualPoints.length;
                    const segmentsPerEdge = 20;

                    // For closed paths: iterate all segments including last-to-first
                    // For open paths: iterate only n-1 segments  
                    const numSegments = connectEndPoints ? pointCount : pointCount - 1;

                    for (let i = 0; i < numSegments; i++) {
                        let p0, p1, p2, p3;

                        if (connectEndPoints) {
                            // Closed path: wrap around using modulo
                            p0 = manualPoints[(i - 1 + pointCount) % pointCount];
                            p1 = manualPoints[i];
                            p2 = manualPoints[(i + 1) % pointCount];
                            p3 = manualPoints[(i + 2) % pointCount];
                        } else {
                            // Open path: clamp to endpoints
                            p0 = manualPoints[Math.max(0, i - 1)];
                            p1 = manualPoints[i];
                            p2 = manualPoints[Math.min(pointCount - 1, i + 1)];
                            p3 = manualPoints[Math.min(pointCount - 1, i + 2)];
                        }

                        for (let t = 0; t < segmentsPerEdge; t++) {
                            const tt = t / segmentsPerEdge;
                            const tt2 = tt * tt;
                            const tt3 = tt2 * tt;

                            const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * tt +
                                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt2 +
                                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * tt3);
                            const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * tt +
                                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt2 +
                                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * tt3);

                            smoothed.push({ x, y });
                        }
                    }

                    // For open paths, add the last point
                    if (!connectEndPoints && smoothed.length > 0) {
                        smoothed.push(manualPoints[pointCount - 1]);
                    }

                    if (smoothed.length > 0) {
                        displayPoints = smoothed;
                    }
                }

                // Draw the path (smoothed or straight lines)
                if (displayPoints.length > 1) {
                    ctx.beginPath();
                    ctx.moveTo(displayPoints[0].x * scaleX, displayPoints[0].y * scaleY);

                    for (let i = 1; i < displayPoints.length; i++) {
                        ctx.lineTo(displayPoints[i].x * scaleX, displayPoints[i].y * scaleY);
                    }

                    // Connect last to first only if enabled
                    if (connectEndPoints) {
                        ctx.lineTo(displayPoints[0].x * scaleX, displayPoints[0].y * scaleY);
                    }

                    ctx.strokeStyle = enableSmoothing ? 'rgba(150, 100, 255, 0.9)' : 'rgba(100, 200, 255, 0.9)';
                    ctx.lineWidth = 3;
                    ctx.setLineDash([]);
                    ctx.stroke();
                }

                // Draw individual control points (always show original points)
                manualPoints.forEach((pt, idx) => {
                    const isHovered = hoveredManualPoint === idx;
                    const isDragging = draggingManualPoint === idx;
                    const radius = (isHovered || isDragging) ? 12 : 8;  // Larger when hovered/dragging

                    ctx.beginPath();
                    ctx.arc(pt.x * scaleX, pt.y * scaleY, radius, 0, Math.PI * 2);

                    // Color based on state
                    if (isDragging) {
                        ctx.fillStyle = '#ff6600';  // Orange when dragging
                    } else if (isHovered) {
                        ctx.fillStyle = '#ffff00';  // Yellow when hovered
                    } else if (idx === 0) {
                        ctx.fillStyle = '#00ff00';  // Green for first point
                    } else {
                        ctx.fillStyle = '#00aaff';  // Blue for other points
                    }
                    ctx.fill();
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 2;
                    ctx.stroke();

                    // Draw point number
                    ctx.fillStyle = '#000';
                    ctx.font = 'bold 10px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText(`${idx + 1}`, pt.x * scaleX, pt.y * scaleY + 3);
                });
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
    }, [videoState.currentFrame, videoState.isGif, trackingRect, motionPath, showPreview, videoState.width, videoState.height, videoState.url, isPlaying, isSelecting, manualPoints, isAutoDetection, enableSmoothing, connectEndPoints, isOpen, redrawKey, hoveredManualPoint, draggingManualPoint]);

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

    // Transfer path to main canvas - normalized and centered
    const handleTransfer = () => {
        // Get source points based on mode
        let sourcePoints: { x: number; y: number }[];

        if (!isAutoDetection) {
            // MANUAL MODE: Use manual points (closed loop)
            if (manualPoints.length < 2) return;
            sourcePoints = [...manualPoints];

            // Apply smoothing if enabled (Catmull-Rom spline interpolation)
            if (enableSmoothing && sourcePoints.length >= 3) {
                const smoothed: { x: number; y: number }[] = [];
                const pointCount = sourcePoints.length;
                const segmentsPerEdge = 20;

                // For closed paths: iterate all segments including last-to-first
                // For open paths: iterate only n-1 segments  
                const numSegments = connectEndPoints ? pointCount : pointCount - 1;

                for (let i = 0; i < numSegments; i++) {
                    let p0, p1, p2, p3;

                    if (connectEndPoints) {
                        // Closed path: wrap around using modulo
                        p0 = sourcePoints[(i - 1 + pointCount) % pointCount];
                        p1 = sourcePoints[i];
                        p2 = sourcePoints[(i + 1) % pointCount];
                        p3 = sourcePoints[(i + 2) % pointCount];
                    } else {
                        // Open path: clamp to endpoints
                        p0 = sourcePoints[Math.max(0, i - 1)];
                        p1 = sourcePoints[i];
                        p2 = sourcePoints[Math.min(pointCount - 1, i + 1)];
                        p3 = sourcePoints[Math.min(pointCount - 1, i + 2)];
                    }

                    for (let t = 0; t < segmentsPerEdge; t++) {
                        const tt = t / segmentsPerEdge;
                        const tt2 = tt * tt;
                        const tt3 = tt2 * tt;

                        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * tt +
                            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt2 +
                            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * tt3);
                        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * tt +
                            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt2 +
                            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * tt3);

                        smoothed.push({ x, y });
                    }
                }

                // For open paths, add the last point
                if (!connectEndPoints && smoothed.length > 0) {
                    smoothed.push(sourcePoints[pointCount - 1]);
                }

                if (smoothed.length > 0) {
                    sourcePoints = smoothed;
                }
            }
        } else {
            // AUTO MODE: Use motion path
            if (motionPath.length === 0) return;
            sourcePoints = motionPath.map(p => ({ x: p.x, y: p.y }));
        }

        // Main canvas world coordinates: origin (0,0) is at center
        const CANVAS_CENTER_X = 0;
        const CANVAS_CENTER_Y = 0;

        // Calculate bounding box
        const xs = sourcePoints.map(p => p.x);
        const ys = sourcePoints.map(p => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const pathWidth = maxX - minX;
        const pathHeight = maxY - minY;

        // Determine scale to fit path nicely (~30% of 600 viewport)
        const targetSize = 180;
        const scale = targetSize / Math.max(pathWidth, pathHeight, 1);

        // Calculate path center
        const pathCenterX = minX + pathWidth / 2;
        const pathCenterY = minY + pathHeight / 2;

        // Transform: center, scale, flip Y
        const points: Point[] = sourcePoints.map(p => ({
            x: CANVAS_CENTER_X + (p.x - pathCenterX) * scale,
            y: CANVAS_CENTER_Y - (p.y - pathCenterY) * scale
        }));

        // For closed paths in manual mode, duplicate first point at end to close polyline
        if (!isAutoDetection && connectEndPoints && points.length > 1) {
            points.push({ ...points[0] });
        }

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

                    {/* Auto/Manual Detection Toggle - Pill Style - Centered */}
                    <div className="flex-1 flex justify-center">
                        <div className="flex items-center bg-slate-700 rounded-full p-1">
                            <button
                                onClick={() => setIsAutoDetection(false)}
                                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${!isAutoDetection
                                    ? 'bg-slate-500 text-white shadow-md'
                                    : 'text-slate-400 hover:text-slate-300'
                                    }`}
                            >
                                Manual
                            </button>
                            <button
                                onClick={() => setIsAutoDetection(true)}
                                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${isAutoDetection
                                    ? 'bg-slate-500 text-white shadow-md'
                                    : 'text-slate-400 hover:text-slate-300'
                                    }`}
                            >
                                Auto
                            </button>
                        </div>
                    </div>

                    <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded">
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                {/* Main Content */}
                <div className="flex-1 flex flex-col p-4 gap-4 overflow-auto">
                    {/* Video Canvas */}
                    <div
                        className="relative bg-slate-900 rounded-lg overflow-hidden flex-1"
                        style={{ minHeight: '500px' }}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        {!videoState.url ? (
                            <div
                                className={`absolute inset-0 flex flex-col items-center justify-center cursor-pointer border-2 border-dashed rounded-lg transition-all duration-200 ${isDraggingFile
                                    ? 'border-blue-400 bg-blue-500/10 text-blue-400'
                                    : 'border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-400'
                                    }`}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Upload className={`w-16 h-16 mb-4 ${isDraggingFile ? 'animate-bounce' : ''}`} />
                                <p className="text-lg font-medium mb-2">
                                    {isDraggingFile ? 'Drop file here!' : 'Drag & drop media here'}
                                </p>
                                <p className="text-sm opacity-70">or click to browse</p>
                                <p className="text-xs mt-3 opacity-50">Supports: MP4, WebM, GIF</p>
                            </div>
                        ) : (
                            <>
                                {/* Hidden video element for video files */}
                                {!videoState.isGif && (
                                    <video
                                        ref={videoRef}
                                        src={videoState.url}
                                        className="hidden"
                                        preload="auto"
                                        onLoadedData={() => {
                                            if (videoRef.current) {
                                                // Seek to frame 0 to ensure first frame is ready
                                                videoRef.current.currentTime = 0;
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

                                {/* GIF img element - hidden, only used for initial loading reference */}
                                {videoState.isGif && (
                                    <img
                                        ref={imgRef}
                                        src={videoState.url}
                                        alt="GIF preview"
                                        className="hidden"
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
                                    className="w-full h-full cursor-crosshair object-contain"
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

                        {/* Path Info - show tracked or manual points count */}
                        {motionPath.length > 0 && isAutoDetection && (
                            <span className="text-green-400 text-sm px-3">
                                ✓ Tracked {motionPath.length} points
                            </span>
                        )}
                        {manualPoints.length > 0 && !isAutoDetection && (
                            <span className="text-cyan-400 text-sm px-3">
                                ✓ {manualPoints.length} manual points
                            </span>
                        )}
                    </div>

                    <div className="flex gap-2">
                        {isAutoDetection && (
                            <>
                                {!tapirModelsReady ? (
                                    <button
                                        onClick={() => setShowDownloadDialog(true)}
                                        className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
                                    >
                                        <Download className="w-4 h-4" />
                                        Download TAPIR
                                    </button>
                                ) : (
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
                                )}
                            </>
                        )}
                        {/* Smoothing checkbox for manual mode - next to Transfer button */}
                        {!isAutoDetection && (
                            <label className="flex items-center gap-2 px-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={enableSmoothing}
                                    onChange={(e) => setEnableSmoothing(e.target.checked)}
                                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 accent-blue-500"
                                />
                                <span className="text-sm text-slate-300">Smooth Path</span>
                            </label>
                        )}
                        {/* Connect end points checkbox for manual mode */}
                        {!isAutoDetection && (
                            <label className="flex items-center gap-2 px-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={connectEndPoints}
                                    onChange={(e) => setConnectEndPoints(e.target.checked)}
                                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 accent-blue-500"
                                />
                                <span className="text-sm text-slate-300">Connect Ends</span>
                            </label>
                        )}

                        <button
                            onClick={handleTransfer}
                            disabled={(isAutoDetection && motionPath.length === 0) || (!isAutoDetection && manualPoints.length < 2)}
                            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                        >
                            <ArrowRight className="w-4 h-4" />
                            Transfer as Drawing
                        </button>
                    </div>
                </div>
            </div>

            {/* TAPIR Model Download Dialog */}
            <ModelDownloadDialog
                isOpen={showDownloadDialog}
                onClose={() => setShowDownloadDialog(false)}
                onComplete={() => {
                    setShowDownloadDialog(false);
                    setTapirModelsReady(true);
                }}
            />
        </div>
    );
};
