/**
 * API client for the Norfair tracking backend.
 */

const API_BASE = 'http://localhost:8000';

export interface TrackingPoint {
    x: number;
    y: number;
    frame: number;
    confidence?: number;  // 0-1, confidence of detection
    corrected?: boolean;  // True if manually corrected
}

export interface TrackRequest {
    videoData: string;      // Base64 encoded video
    initPoint: { x: number; y: number; frame: number };
    videoFormat: string;
    smooth?: boolean;
    trackingMethod?: 'euclidean' | 'frobenius' | 'mean_euclidean' | 'mean_manhattan';
}

export interface CorrectionRequest extends TrackRequest {
    corrections: Record<number, { x: number; y: number }>;  // {frameIdx: {x, y}}
}

export interface TrackResponse {
    success: boolean;
    path: TrackingPoint[];
    fps: number;
    duration: number;
    frameCount: number;
    error?: string;
}

/**
 * Check if the tracking backend is available.
 */
export async function checkBackendHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${API_BASE}/health`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        return data.status === 'ok';
    } catch {
        return false;
    }
}

/**
 * Track a single point through a video.
 */
export async function trackVideo(request: TrackRequest): Promise<TrackResponse> {
    try {
        const response = await fetch(`${API_BASE}/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_data: request.videoData,
                init_point: {
                    x: request.initPoint.x,
                    y: request.initPoint.y,
                    frame: request.initPoint.frame
                },
                video_format: request.videoFormat,
                smooth: request.smooth ?? true,
                tracking_method: request.trackingMethod ?? 'euclidean'
            })
        });

        const data = await response.json();
        return {
            success: data.success,
            path: data.path || [],
            fps: data.fps || 0,
            duration: data.duration || 0,
            frameCount: data.frame_count || 0,
            error: data.error
        };
    } catch (error) {
        return {
            success: false,
            path: [],
            fps: 0,
            duration: 0,
            frameCount: 0,
            error: error instanceof Error ? error.message : 'Network error'
        };
    }
}

/**
 * Re-run tracking with manual corrections applied.
 */
export async function correctTracking(request: CorrectionRequest): Promise<TrackResponse> {
    try {
        // Convert corrections to string keys for JSON
        const corrections: Record<string, { x: number; y: number }> = {};
        for (const [frameIdx, coords] of Object.entries(request.corrections)) {
            corrections[String(frameIdx)] = coords;
        }

        const response = await fetch(`${API_BASE}/correct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_data: request.videoData,
                init_point: {
                    x: request.initPoint.x,
                    y: request.initPoint.y,
                    frame: request.initPoint.frame
                },
                video_format: request.videoFormat,
                smooth: request.smooth ?? true,
                tracking_method: request.trackingMethod ?? 'euclidean',
                corrections: corrections
            })
        });

        const data = await response.json();
        return {
            success: data.success,
            path: data.path || [],
            fps: data.fps || 0,
            duration: data.duration || 0,
            frameCount: data.frame_count || 0,
            error: data.error
        };
    } catch (error) {
        return {
            success: false,
            path: [],
            fps: 0,
            duration: 0,
            frameCount: 0,
            error: error instanceof Error ? error.message : 'Network error'
        };
    }
}

/**
 * Convert a File to base64 string.
 */
export function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Remove data URL prefix (e.g., "data:video/mp4;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Get video format from filename.
 */
export function getVideoFormat(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';
    if (ext === 'gif') return 'gif';
    if (ext === 'webm') return 'webm';
    return 'mp4';
}

