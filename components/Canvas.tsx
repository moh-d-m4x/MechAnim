
import React, { useEffect, useRef, useState } from 'react';
import { GlobalConfig, MechanismConfig, Point, MechanismType } from '../types';
import { calculateLinkage, generateCurvePoints } from '../utils/kinematics';

interface CanvasProps {
    config: GlobalConfig;
    setConfig: React.Dispatch<React.SetStateAction<GlobalConfig>>;
    selectedId: string | null;
    setSelectedId: (id: string | null) => void;
    isPlaying: boolean;
    showTrace: boolean;
    isDrawMode: boolean;
    userPath: Point[];
    setUserPath: (path: Point[]) => void;
    angle: number;
    setAngle: React.Dispatch<React.SetStateAction<number>>;
}

const INITIAL_OFFSET_X = 400;
const INITIAL_OFFSET_Y = 300;
const VB_WIDTH = 800;
const VB_HEIGHT = 600;

const GearPath = ({ radius, teeth }: { radius: number, teeth: number }) => {
    const hole = radius * 0.2;
    const outer = radius;
    const inner = radius * 0.85;
    let d = "";
    for (let i = 0; i < teeth; i++) {
        const angle = (Math.PI * 2 * i) / teeth;
        const toothWidth = (Math.PI * 2) / teeth / 2;
        const a1 = angle;
        const a2 = angle + toothWidth * 0.3;
        const a3 = angle + toothWidth * 0.7;
        const a4 = angle + toothWidth;
        const p1 = { x: Math.cos(a1) * inner, y: Math.sin(a1) * inner };
        const p2 = { x: Math.cos(a2) * outer, y: Math.sin(a2) * outer };
        const p3 = { x: Math.cos(a3) * outer, y: Math.sin(a3) * outer };
        const p4 = { x: Math.cos(a4) * inner, y: Math.sin(a4) * inner };
        d += i === 0 ? `M ${p1.x} ${p1.y} ` : `L ${p1.x} ${p1.y} `;
        d += `L ${p2.x} ${p2.y} L ${p3.x} ${p3.y} L ${p4.x} ${p4.y} `;
    }
    d += `Z M ${hole} 0 A ${hole} ${hole} 0 1 0 -${hole} 0 A ${hole} ${hole} 0 1 0 ${hole} 0 Z`;
    return <path d={d} fillRule="evenodd" />;
};

export const Canvas: React.FC<CanvasProps> = ({ 
    config, setConfig, selectedId, setSelectedId, isPlaying, showTrace, isDrawMode, userPath, setUserPath, angle, setAngle
}) => {
    const [traces, setTraces] = useState<Record<string, Point[]>>({});
    const svgRef = useRef<SVGSVGElement>(null);
    
    const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [isPanning, setIsPanning] = useState(false);
    const [isDrawing, setIsDrawing] = useState(false);
    const [dragTarget, setDragTarget] = useState<{ mechId: string, type: 'P1' | 'P2' | 'J1' | 'J2' | 'Effector' | 'Aux' } | null>(null);

    // Trace Logic
    useEffect(() => {
        if (!isPlaying) {
            // Generate full static traces
            const newTraces: Record<string, Point[]> = {};
            config.mechanisms.forEach(m => {
                if (m.type !== 'crank') {
                    newTraces[m.id] = generateCurvePoints(m, 100).points;
                }
            });
            setTraces(newTraces);
        } else {
            // Clear for realtime
            setTraces({});
        }
    }, [config, isPlaying]);

    useEffect(() => {
        if (isPlaying && !isDrawMode && showTrace) {
            // Realtime appending
            config.mechanisms.forEach(m => {
                const state = calculateLinkage(m, angle);
                if (state.isValid && m.type !== 'crank') {
                    setTraces(prev => {
                        const current = prev[m.id] || [];
                        const updated = [...current, state.effector];
                        if (updated.length > 300) updated.shift();
                        return { ...prev, [m.id]: updated };
                    });
                }
            });
        }
    }, [angle, showTrace, isPlaying, isDrawMode]);

    const getWorldPoint = (e: React.MouseEvent | React.TouchEvent): Point | null => {
        if (!svgRef.current) return null;
        const svg = svgRef.current;
        const pt = svg.createSVGPoint();
        const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
        pt.x = clientX;
        pt.y = clientY;
        const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
        
        const Tx = INITIAL_OFFSET_X + viewOffset.x;
        const Ty = INITIAL_OFFSET_Y + viewOffset.y;

        return {
            x: (svgP.x - Tx) / zoom,
            y: (Ty - svgP.y) / zoom
        };
    };

    const updateMechanism = (id: string, updates: Partial<MechanismConfig>) => {
        setConfig(prev => ({
            ...prev,
            mechanisms: prev.mechanisms.map(m => m.id === id ? { ...m, ...updates } : m)
        }));
    };
    
    const handleWheel = (e: React.WheelEvent) => {
        if (!svgRef.current) return;
        
        const zoomSensitivity = 0.001;
        const MIN_ZOOM = 0.1;
        const MAX_ZOOM = 10;

        // Calculate new zoom
        const delta = -e.deltaY;
        const scaleFactor = 1 + delta * zoomSensitivity;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * scaleFactor));
        
        // Calculate point under mouse in SVG ViewBox coordinates
        const pt = svgRef.current.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const svgP = pt.matrixTransform(svgRef.current.getScreenCTM()?.inverse());
        
        // Current transform params
        const Tx = INITIAL_OFFSET_X + viewOffset.x;
        const Ty = INITIAL_OFFSET_Y + viewOffset.y;
        
        // Calculate World Point under mouse before zoom
        const wx = (svgP.x - Tx) / zoom;
        const wy = (Ty - svgP.y) / zoom;
        
        // Calculate New Translation to keep World Point under mouse
        const newTx = svgP.x - wx * newZoom;
        const newTy = svgP.y + wy * newZoom;
        
        setZoom(newZoom);
        setViewOffset({
            x: newTx - INITIAL_OFFSET_X,
            y: newTy - INITIAL_OFFSET_Y
        });
    };

    const handleMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
        if ('button' in e && (e as React.MouseEvent).button === 1) {
            setIsPanning(true);
            e.preventDefault();
            return;
        }
        const p = getWorldPoint(e);
        if (!p) return;

        if (!isPlaying && !isDrawMode) {
            const HIT_RADIUS = 20 / zoom; // Adjust hit radius by zoom
            const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

            // Check all mechanisms (reverse order to grab top-most)
            for (let i = config.mechanisms.length - 1; i >= 0; i--) {
                const m = config.mechanisms[i];
                const state = calculateLinkage(m, angle);
                
                // Check Effector
                if (m.type !== 'crank' && dist(p, state.effector) < HIT_RADIUS) {
                    setDragTarget({ mechId: m.id, type: 'Effector' });
                    setSelectedId(m.id);
                    return;
                }
                
                // Check Aux (Secondary Crank Tip for 5-bar)
                if (m.type === '5bar' && state.aux && dist(p, state.aux) < HIT_RADIUS) {
                    setDragTarget({ mechId: m.id, type: 'Aux' });
                    setSelectedId(m.id);
                    return;
                }

                // Check J2 (Joint/Slider/Intersection)
                if (m.type !== 'crank' && dist(p, state.j2) < HIT_RADIUS) {
                    setDragTarget({ mechId: m.id, type: 'J2' });
                    setSelectedId(m.id);
                    return;
                }
                // Check J1 (Crank Pin)
                if (dist(p, state.j1) < HIT_RADIUS) {
                    setDragTarget({ mechId: m.id, type: 'J1' });
                    setSelectedId(m.id);
                    return;
                }
                
                // Check P2 (Ground / Angle Handle / Secondary Gear)
                let groundHandle = state.p2;
                if (m.type === 'piston' || m.type === 'yoke' || m.type === 'quick-return') {
                     // Calculate visual handle position
                     const rad = (m.groundAngle || 0) * Math.PI / 180;
                     const dist = m.type === 'quick-return' ? 120 : 100;
                     groundHandle = {
                         x: m.anchorX! + Math.cos(rad) * dist,
                         y: m.anchorY! + Math.sin(rad) * dist
                     };
                }
                
                if (dist(p, groundHandle) < HIT_RADIUS) {
                    setDragTarget({ mechId: m.id, type: 'P2' });
                    setSelectedId(m.id);
                    return;
                }
                
                // Check P1 (Anchor/Crank Pivot)
                if (dist(p, state.p1) < HIT_RADIUS * 1.5) {
                     setDragTarget({ mechId: m.id, type: 'P1' });
                     setSelectedId(m.id);
                     return;
                }
            }
        }

        if (isDrawMode) {
            setIsDrawing(true);
            setUserPath([p]);
        }
    };

    const handleMouseMove = (e: React.MouseEvent | React.TouchEvent) => {
        if (isPanning) {
            const movementX = 'movementX' in e ? (e as React.MouseEvent).movementX : 0;
            const movementY = 'movementY' in e ? (e as React.MouseEvent).movementY : 0;
            if (movementX !== undefined) {
                 setViewOffset(prev => ({ x: prev.x + movementX, y: prev.y + movementY }));
            }
            return;
        }

        let p = getWorldPoint(e);
        if (!p) return;

        if (dragTarget && !isPlaying) {
            const m = config.mechanisms.find(mech => mech.id === dragTarget.mechId);
            if (!m) return;

            const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
            const toDeg = (rad: number) => (rad * 180) / Math.PI;
            const state = calculateLinkage(m, angle);

            if (dragTarget.type === 'P1') {
                // Move the entire mechanism anchor
                updateMechanism(m.id, { anchorX: p.x, anchorY: p.y });
            }
            else if (dragTarget.type === 'P2') {
                // Interaction: Rotate Ground / Change Ground Length
                const dx = p.x - state.p1.x;
                const dy = p.y - state.p1.y;
                const newAngle = toDeg(Math.atan2(dy, dx));
                
                if (m.type === '4bar' || m.type === '5bar') {
                    const newGround = Math.hypot(dx, dy);
                    updateMechanism(m.id, { groundLength: newGround, groundAngle: newAngle });
                } else {
                    updateMechanism(m.id, { groundAngle: newAngle });
                }
            }
            else if (dragTarget.type === 'J1') {
                const newCrank = dist(state.p1, p);
                const newAngle = Math.atan2(p.y - state.p1.y, p.x - state.p1.x);
                updateMechanism(m.id, { crankLength: newCrank });
                setAngle(newAngle);
            }
            else if (dragTarget.type === 'Aux') {
                const newRadius = dist(state.p2, p);
                updateMechanism(m.id, { rockerLength: newRadius });
            }
            else if (dragTarget.type === 'J2') {
                if (m.type === '4bar') {
                    const newRocker = dist(state.p2, p);
                    const newCoupler = dist(state.j1, p);
                    updateMechanism(m.id, { rockerLength: newRocker, couplerLength: newCoupler });
                } else if (m.type === 'piston') {
                    const newCoupler = dist(state.j1, p);
                    updateMechanism(m.id, { couplerLength: newCoupler });
                } else if (m.type === 'yoke') {
                    const limit = m.crankLength - 2;
                    const dY = p.y - state.p1.y;
                    const safeY = Math.max(-limit, Math.min(limit, dY));
                    updateMechanism(m.id, { sliderOffset: safeY });
                } else if (m.type === '5bar') {
                     const newCoupler = dist(state.j1, p);
                     const newRod = state.aux ? dist(state.aux, p) : 100;
                     updateMechanism(m.id, { couplerLength: newCoupler, rodLength: newRod });
                }
            }
            else if (dragTarget.type === 'Effector') {
                if (m.type !== 'crank') {
                    if (m.type === '5bar') {
                         const newExtension = dist(state.j2, p);
                         updateMechanism(m.id, { couplerPointDist: newExtension });
                    } else {
                        const barAngle = Math.atan2(state.j2.y - state.j1.y, state.j2.x - state.j1.x);
                        const mouseAngle = Math.atan2(p.y - state.j1.y, p.x - state.j1.x);
                        const newDist = dist(state.j1, p);
                        const newAngleDiff = toDeg(mouseAngle - barAngle);
                        updateMechanism(m.id, { couplerPointDist: newDist, couplerPointAngle: newAngleDiff });
                    }
                }
            }
        }

        if (isDrawMode && isDrawing) {
            const isShift = (e as any).shiftKey;
            if (isShift && userPath.length > 0) {
                const last = userPath[userPath.length - 1];
                const dx = Math.abs(p.x - last.x);
                const dy = Math.abs(p.y - last.y);
                if (dx > dy) p = { x: p.x, y: last.y }; 
                else p = { x: last.x, y: p.y }; 
            }
            const last = userPath[userPath.length - 1];
            if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 5) {
                setUserPath([...userPath, p]);
            }
        }
    };

    const handleMouseUp = () => {
        setIsDrawing(false);
        setIsPanning(false);
        setDragTarget(null);
    };

    const crankDeg = (angle * 180) / Math.PI;

    return (
        <div 
            className={`w-full h-full bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative select-none ${isDrawMode ? 'ring-2 ring-indigo-500 ring-inset' : ''}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleMouseDown}
            onTouchMove={handleMouseMove}
            onTouchEnd={handleMouseUp}
            onWheel={handleWheel}
            tabIndex={0} 
        >
            <svg 
                ref={svgRef}
                viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`} 
                className={`w-full h-full ${isPanning ? 'cursor-grabbing' : 'cursor-default'}`}
                preserveAspectRatio="xMidYMid slice"
            >
                <g transform={`translate(${INITIAL_OFFSET_X + viewOffset.x}, ${INITIAL_OFFSET_Y + viewOffset.y}) scale(${zoom}, -${zoom})`}>
                    
                    {/* Grid */}
                    <g opacity="0.1">
                        {Array.from({ length: 41 }).map((_, i) => (
                            <React.Fragment key={i}>
                                <line x1="-2000" y1={(i - 20) * 50} x2="2000" y2={(i - 20) * 50} stroke="#000" width="1" />
                                <line x1={(i - 20) * 50} y1="-2000" x2={(i - 20) * 50} y2="2000" stroke="#000" width="1" />
                            </React.Fragment>
                        ))}
                        <line x1="-2000" y1="0" x2="2000" y2="0" stroke="#000" strokeWidth="2" />
                        <line x1="0" y1="-2000" x2="0" y2="2000" stroke="#000" strokeWidth="2" />
                    </g>

                    {/* RENDER MECHANISMS */}
                    {config.mechanisms.map(m => {
                        const { p1, p2, j1, j2, aux, effector, isValid } = calculateLinkage(m, angle);
                        const isSelected = m.id === selectedId;
                        const opacity = isSelected ? 1 : 0.6;
                        const color = m.color;
                        const yokeSlotHalfHeight = m.type === 'yoke' ? Math.abs(m.sliderOffset) + m.crankLength + 30 : 0;
                        
                        let rockerAngleDeg = 0;
                        if (m.type === '4bar' || m.type === 'quick-return') {
                            rockerAngleDeg = Math.atan2(j2.y - p2.y, j2.x - p2.x) * 180 / Math.PI;
                        }

                        return (
                            <g key={m.id} opacity={opacity}>
                                {/* Anchor P1 Visualization */}
                                <g transform={`translate(${p1.x}, ${p1.y})`}>
                                     <g transform={`rotate(${crankDeg * (m.speed1 ?? 1)})`}>
                                        <g fill={m.type === '5bar' ? "#d97706" : "#f59e0b"} stroke={m.type === '5bar' ? "#78350f" : "#b45309"} strokeWidth="2">
                                             <GearPath radius={m.crankLength + 10} teeth={14} />
                                        </g>
                                        <circle cx="0" cy="0" r="4" fill="#475569" stroke="white" />
                                     </g>
                                     <circle cx="0" cy="0" r="12" fill="transparent" stroke={isSelected ? "white" : "transparent"} strokeWidth="2" strokeDasharray="2 2" className="cursor-move" />
                                     
                                     {isSelected && m.type !== 'crank' && (
                                         <g transform={`rotate(${m.groundAngle || 0})`}>
                                             <line x1="0" y1="0" x2="100" y2="0" stroke={color} strokeWidth="1" strokeDasharray="4 4" />
                                             <circle cx="100" cy="0" r="6" fill="white" stroke={color} strokeWidth="2" className="cursor-grab" />
                                         </g>
                                     )}
                                </g>

                                {(m.type === '4bar' || m.type === 'quick-return') && m.showOutputGear && isValid && (
                                    <g transform={`translate(${p2.x}, ${p2.y}) rotate(${rockerAngleDeg})`}>
                                        <g fill="#f59e0b" stroke="#b45309" strokeWidth="2">
                                            <GearPath radius={m.outputGearRadius || 40} teeth={12} />
                                        </g>
                                        <circle cx="0" cy="0" r="4" fill="#475569" stroke="white" />
                                    </g>
                                )}

                                <line x1={p1.x} y1={p1.y} x2={j1.x} y2={j1.y} stroke="#78350f" strokeWidth="4" strokeLinecap="round" />
                                <circle cx={j1.x} cy={j1.y} r={4} fill={color} />

                                {isValid ? (
                                    <>
                                        {m.type === '4bar' && (
                                            <>
                                                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#cbd5e1" strokeWidth="12" strokeLinecap="round" />
                                                <line x1={p2.x} y1={p2.y} x2={j2.x} y2={j2.y} stroke="#475569" strokeWidth="8" strokeLinecap="round" />
                                                <path d={`M ${j1.x} ${j1.y} L ${j2.x} ${j2.y} L ${effector.x} ${effector.y} Z`} fill={`${color}20`} stroke={color} strokeWidth="1" />
                                                <line x1={j1.x} y1={j1.y} x2={j2.x} y2={j2.y} stroke={color} strokeWidth="8" strokeLinecap="round" />
                                                <circle cx={p2.x} cy={p2.y} r={8} fill="#94a3b8" stroke="white" strokeWidth="2" className="cursor-grab" />
                                                <circle cx={j2.x} cy={j2.y} r={6} fill="white" stroke="#334155" strokeWidth="2" className="cursor-grab" />
                                            </>
                                        )}

                                        {m.type === '5bar' && aux && (
                                            <>
                                                <g transform={`translate(${p2.x}, ${p2.y}) rotate(${(crankDeg * (m.speed2 ?? (m.gearRatio || 1))) + ((m.phase ?? 0) * 180 / Math.PI)})`}>
                                                     <g fill="#f59e0b" stroke="#b45309" strokeWidth="2">
                                                        <GearPath 
                                                            radius={m.rockerLength + 10} 
                                                            teeth={Math.max(3, Math.round(14 * (m.rockerLength / m.crankLength)))} 
                                                        />
                                                     </g>
                                                     <circle cx="0" cy="0" r="4" fill="#475569" stroke="white" />
                                                </g>
                                                <line x1={p2.x} y1={p2.y} x2={aux.x} y2={aux.y} stroke="#78350f" strokeWidth="4" strokeLinecap="round" />
                                                <circle cx={aux.x} cy={aux.y} r={4} fill={color} className="cursor-grab" />
                                                
                                                {isSelected && (
                                                     <circle cx={aux.x} cy={aux.y} r={8} fill="transparent" stroke="white" strokeWidth="2" strokeDasharray="2,2" className="cursor-grab"/>
                                                )}

                                                <line x1={j1.x} y1={j1.y} x2={effector.x} y2={effector.y} stroke="#475569" strokeWidth="6" strokeLinecap="round" />
                                                <line x1={aux.x} y1={aux.y} x2={j2.x} y2={j2.y} stroke="#475569" strokeWidth="6" strokeLinecap="round" />

                                                <circle cx={p2.x} cy={p2.y} r={8} fill="transparent" stroke="#94a3b8" strokeWidth="2" className="cursor-grab" />
                                                <circle cx={j2.x} cy={j2.y} r={5} fill="white" stroke="#334155" strokeWidth="2" className="cursor-grab" />
                                            </>
                                        )}

                                        {(m.type === 'piston' || m.type === 'yoke' || m.type === 'quick-return') && (
                                            <>
                                               {m.type === 'piston' && (
                                                   <>
                                                        <g transform={`translate(${p1.x}, ${p1.y}) rotate(${m.groundAngle || 0}) translate(0, ${m.sliderOffset})`}>
                                                            <line x1="-1000" y1="12" x2="1000" y2="12" stroke="#94a3b8" strokeWidth="2" opacity={0.5}/>
                                                            <line x1="-1000" y1="-12" x2="1000" y2="-12" stroke="#94a3b8" strokeWidth="2" opacity={0.5}/>
                                                        </g>
                                                        <path d={`M ${j1.x} ${j1.y} L ${j2.x} ${j2.y} L ${effector.x} ${effector.y} Z`} fill={`${color}20`} stroke={color} strokeWidth="1" />
                                                        <line x1={j1.x} y1={j1.y} x2={j2.x} y2={j2.y} stroke={color} strokeWidth="8" strokeLinecap="round" />
                                                        <rect x={j2.x - 20} y={j2.y - 10} width="40" height="20" fill="#334155" rx="2" transform={`rotate(${m.groundAngle||0} ${j2.x} ${j2.y})`} />
                                                   </>
                                               )}

                                                {m.type === 'yoke' && (
                                                    <>
                                                        <g transform={`translate(${p1.x}, ${p1.y}) rotate(${m.groundAngle || 0}) translate(0, ${m.sliderOffset})`}>
                                                            <line x1="-1000" y1="0" x2="1000" y2="0" stroke="#cbd5e1" strokeWidth="4" strokeDasharray="8 8" />
                                                        </g>
                                                        <g transform={`translate(${j2.x}, ${j2.y}) rotate(${m.groundAngle||0})`}>
                                                            <rect x="-40" y="-10" width="80" height="20" fill={color} rx="4" />
                                                            <rect x="-15" y={-yokeSlotHalfHeight} width="30" height={yokeSlotHalfHeight * 2} rx="4" fill="none" stroke={color} strokeWidth="4" />
                                                            <line x1="0" y1={-yokeSlotHalfHeight + 10} x2="0" y2={yokeSlotHalfHeight - 10} stroke="#fef3c7" strokeWidth="14" strokeLinecap="round" />
                                                        </g>
                                                        <circle cx={j1.x} cy={j1.y} r={7} fill="#78350f" />
                                                    </>
                                                )}
                                                
                                                {m.type === 'quick-return' && (
                                                    <>
                                                        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#cbd5e1" strokeWidth="8" strokeLinecap="round" />
                                                        <line x1={j2.x} y1={j2.y} x2={effector.x} y2={effector.y} stroke={color} strokeWidth="4" strokeLinecap="round" />
                                                        <path d={`M ${p2.x} ${p2.y} L ${j2.x} ${j2.y} L ${effector.x} ${effector.y} Z`} fill={`${color}10`} stroke="none" />
                                                        <line x1={p2.x} y1={p2.y} x2={j2.x} y2={j2.y} stroke="#475569" strokeWidth="10" strokeLinecap="round" />
                                                        <circle cx={p2.x} cy={p2.y} r={8} fill="#94a3b8" stroke="white" strokeWidth="2" />
                                                        <circle cx={j1.x} cy={j1.y} r={5} fill="white" stroke="#78350f" strokeWidth="2" />
                                                    </>
                                                )}
                                            </>
                                        )}

                                        {m.type !== 'crank' && (
                                             <circle cx={effector.x} cy={effector.y} r={6 / zoom} fill="#ef4444" stroke="white" strokeWidth={2/zoom} className="cursor-grab" />
                                        )}
                                    </>
                                ) : (
                                    <g transform={`translate(${j1.x + 20}, ${j1.y})`}>
                                        <text x="0" y="0" fill="red" fontSize="10">Invalid</text>
                                    </g>
                                )}

                                {isSelected && isValid && (
                                    <circle cx={j1.x} cy={j1.y} r={8} fill="transparent" stroke="white" strokeWidth="2" strokeDasharray="2,2"/>
                                )}
                            </g>
                        );
                    })}

                    {showTrace && Object.entries(traces).map(([id, trace]: [string, Point[]]) => (
                        trace.length > 1 && (
                            <path 
                                key={id}
                                d={`M ${trace.map(p => `${p.x},${p.y}`).join(' L ')}`} 
                                fill="none" 
                                stroke="white" 
                                strokeWidth={3 / zoom} 
                                opacity="0.9" 
                                strokeLinecap="round" 
                                strokeLinejoin="round"
                                style={{ filter: 'drop-shadow(0px 0px 3px rgba(0,0,0,0.5))' }}
                            />
                        )
                    ))}

                    {userPath.length > 0 && (
                        <polyline 
                            points={userPath.map(p => `${p.x},${p.y}`).join(' ')} 
                            fill="none" 
                            stroke="#6366f1" 
                            strokeWidth={4 / zoom} 
                            strokeDasharray="8,6" 
                            strokeLinecap="round" 
                            opacity={0.8}
                            pointerEvents="none" 
                        />
                    )}

                </g>
            </svg>
        </div>
    );
};