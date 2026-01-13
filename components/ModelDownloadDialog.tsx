import React, { useState, useEffect, useCallback } from 'react';
import { Download, Cpu, Monitor, AlertCircle, CheckCircle, Loader2, X, XCircle } from 'lucide-react';
import {
    checkModelStatus,
    checkGpuAvailable,
    startModelDownload,
    getDownloadProgress,
    cancelDownload,
    ModelStatus,
    GpuCheckResult,
    DownloadProgress
} from '../utils/trackingApi';

interface ModelDownloadDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onComplete: () => void;
}

export const ModelDownloadDialog: React.FC<ModelDownloadDialogProps> = ({
    isOpen,
    onClose,
    onComplete
}) => {
    const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
    const [gpuCheck, setGpuCheck] = useState<GpuCheckResult | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);
    const [progress, setProgress] = useState<DownloadProgress | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Check status on mount
    useEffect(() => {
        if (!isOpen) return;

        const checkStatus = async () => {
            const status = await checkModelStatus();
            setModelStatus(status);

            const gpu = await checkGpuAvailable();
            setGpuCheck(gpu);
        };

        checkStatus();
    }, [isOpen]);

    // Poll download progress
    useEffect(() => {
        if (!isDownloading) return;

        const interval = setInterval(async () => {
            const prog = await getDownloadProgress();
            setProgress(prog);

            if (prog?.is_complete) {
                setIsDownloading(false);
                if (prog.error) {
                    setError(prog.error);
                } else {
                    // Refresh status
                    const status = await checkModelStatus();
                    setModelStatus(status);
                    if (status?.ready) {
                        onComplete();
                    }
                }
            }
        }, 500);

        return () => clearInterval(interval);
    }, [isDownloading, onComplete]);

    const handleDownload = useCallback(async (useGpu: boolean) => {
        setError(null);
        setIsDownloading(true);
        const result = await startModelDownload(useGpu);
        if (result.status === 'error') {
            setError('Failed to start download');
            setIsDownloading(false);
        }
    }, []);

    const handleCancel = useCallback(async () => {
        await cancelDownload();
        setIsDownloading(false);
        setProgress(null);
    }, []);

    if (!isOpen) return null;

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
                {/* Header */}
                <div className="bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Download className="text-white" size={24} />
                        <h2 className="text-xl font-bold text-white">TAPIR Model Setup</h2>
                    </div>
                    {!isDownloading && (
                        <button
                            onClick={onClose}
                            className="text-white/80 hover:text-white transition-colors"
                        >
                            <X size={24} />
                        </button>
                    )}
                </div>

                <div className="p-6 space-y-6">
                    {/* Status Message */}
                    {modelStatus?.ready ? (
                        <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg border border-green-200">
                            <CheckCircle className="text-green-600" size={24} />
                            <div>
                                <p className="font-medium text-green-800">Models Ready!</p>
                                <p className="text-sm text-green-600">TAPIR is ready for Auto detection.</p>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 p-4 bg-amber-50 rounded-lg border border-amber-200">
                            <AlertCircle className="text-amber-600" size={24} />
                            <div>
                                <p className="font-medium text-amber-800">Models Required</p>
                                <p className="text-sm text-amber-600">
                                    Download required files to enable Auto detection (~500MB).
                                </p>
                            </div>
                        </div>
                    )}

                    {/* GPU Detection */}
                    {gpuCheck && (
                        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                            <div className="flex items-center gap-3">
                                {gpuCheck.gpu_available ? (
                                    <>
                                        <Monitor className="text-green-600" size={20} />
                                        <div>
                                            <p className="font-medium text-slate-800">GPU Detected</p>
                                            <p className="text-sm text-slate-500">{gpuCheck.gpu_name}</p>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <Cpu className="text-slate-500" size={20} />
                                        <div>
                                            <p className="font-medium text-slate-800">CPU Only</p>
                                            <p className="text-sm text-slate-500">No compatible GPU found</p>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Download Progress */}
                    {isDownloading && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-slate-600 flex items-center gap-2">
                                    <Loader2 className="animate-spin" size={14} />
                                    {progress?.file_name || 'Preparing download...'}
                                </span>
                                {progress && progress.total_bytes > 0 && (
                                    <span className="text-slate-500">
                                        {formatBytes(progress.downloaded_bytes)} / {formatBytes(progress.total_bytes)}
                                    </span>
                                )}
                            </div>
                            <div className="w-full bg-slate-200 rounded-full h-4 overflow-hidden">
                                {progress && progress.total_bytes > 0 ? (
                                    <div
                                        className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full rounded-full transition-all duration-300"
                                        style={{ width: `${Math.min(progress.percent, 100)}%` }}
                                    />
                                ) : (
                                    <div className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full rounded-full animate-pulse w-1/3" />
                                )}
                            </div>
                            <p className="text-center text-sm font-medium text-slate-600">
                                {progress && progress.total_bytes > 0
                                    ? `${progress.percent.toFixed(1)}% complete`
                                    : 'Connecting to server...'}
                            </p>
                            <button
                                onClick={handleCancel}
                                className="flex items-center justify-center gap-2 mx-auto mt-2 px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors text-sm font-medium"
                            >
                                <XCircle size={16} />
                                Cancel Download
                            </button>
                        </div>
                    )}

                    {/* Error Message */}
                    {error && (
                        <div className="p-4 bg-red-50 rounded-lg border border-red-200">
                            <p className="text-red-700 text-sm">{error}</p>
                        </div>
                    )}

                    {/* Download Buttons */}
                    {!modelStatus?.ready && !isDownloading && (
                        <div className="flex gap-3">
                            {gpuCheck?.gpu_available && (
                                <button
                                    onClick={() => handleDownload(true)}
                                    className="flex-1 flex items-center justify-center gap-2 py-3 px-4 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-lg font-medium hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg"
                                >
                                    <Monitor size={18} />
                                    Download for GPU
                                </button>
                            )}
                            <button
                                onClick={() => handleDownload(false)}
                                className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium transition-all shadow-lg ${gpuCheck?.gpu_available
                                    ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                    : 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700'
                                    }`}
                            >
                                <Cpu size={18} />
                                Download for CPU
                            </button>
                        </div>
                    )}

                    {/* Ready - Close Button */}
                    {modelStatus?.ready && (
                        <button
                            onClick={onComplete}
                            className="w-full py-3 px-4 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-lg font-medium hover:from-green-600 hover:to-emerald-700 transition-all shadow-lg"
                        >
                            Start Using TAPIR
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
