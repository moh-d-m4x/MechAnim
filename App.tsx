import React, { useState, useEffect, useRef } from 'react';
import { Canvas } from './components/Canvas';
import { Controls, OptimizationOptions } from './components/Controls';
import { TrackingModal } from './components/TrackingModal';
import { GlobalConfig, MechanismConfig, Point, MechanismType } from './types';
import { evaluateFitness, mutateConfig, generateSmartConfig, getBounds, localRefine5bar } from './utils/optimizer';
import { generateCurvePoints } from './utils/kinematics';
import { generateSVG, generateDXF } from './utils/exporter';
import { Info, X } from 'lucide-react';

const App: React.FC = () => {
    const initialId = 'mech-1';

    // Initial Configuration with one 4-bar
    const [config, setConfig] = useState<GlobalConfig>({
        speed: 1,
        rotation: 0,
        mechanisms: [{
            id: initialId,
            type: '4bar',
            visible: true,
            color: '#3b82f6',
            groundLength: 180,
            crankLength: 50,
            couplerLength: 180,
            rockerLength: 120,
            sliderOffset: 0,
            couplerPointDist: 80,
            couplerPointAngle: 45
        }]
    });

    const [selectedId, setSelectedId] = useState<string | null>(initialId);
    const [angle, setAngle] = useState(0);

    const [presets, setPresets] = useState<{ name: string, conf: GlobalConfig }[]>([
        {
            name: "Two-Gear Drawing Machine",
            conf: {
                speed: 1,
                rotation: 0,
                mechanisms: [{
                    id: 'p_geared',
                    type: '5bar',
                    visible: true,
                    color: '#eab308', // Brass/Gold
                    groundLength: 120,
                    crankLength: 60,
                    rockerLength: 40, // Secondary gear radius
                    couplerLength: 180,
                    rodLength: 100, // Secondary arm
                    sliderOffset: 0,
                    couplerPointDist: 100, // Extension
                    couplerPointAngle: 0,
                    speed1: 1,
                    speed2: 1.5
                }]
            }
        },
        {
            name: "Crank-Rocker",
            conf: {
                speed: 1,
                rotation: 0,
                mechanisms: [{ id: 'p1', type: '4bar', visible: true, color: '#3b82f6', groundLength: 180, crankLength: 50, couplerLength: 180, rockerLength: 120, sliderOffset: 0, couplerPointDist: 80, couplerPointAngle: 45 }]
            }
        },
        {
            name: "Piston Pusher",
            conf: {
                speed: 1,
                rotation: 0,
                mechanisms: [{ id: 'p2', type: 'piston', visible: true, color: '#10b981', groundLength: 0, crankLength: 60, couplerLength: 160, rockerLength: 0, sliderOffset: 40, couplerPointDist: 0, couplerPointAngle: 0 }]
            }
        },
        {
            name: "Scotch Yoke",
            conf: {
                speed: 1,
                rotation: 0,
                mechanisms: [{ id: 'p3', type: 'yoke', visible: true, color: '#f59e0b', groundLength: 0, crankLength: 50, couplerLength: 0, rockerLength: 0, sliderOffset: 0, couplerPointDist: 50, couplerPointAngle: 0 }]
            }
        }
    ]);

    const [isPlaying, setIsPlaying] = useState(true);
    const [showTrace, setShowTrace] = useState(true);

    // New States for Drawing & AI
    const [isDrawMode, setIsDrawMode] = useState(false);
    const [userPath, setUserPath] = useState<Point[]>([]);
    const [isOptimizing, setIsOptimizing] = useState(false);
    const [optDuration, setOptDuration] = useState(0);

    const [showHelp, setShowHelp] = useState(false);
    const [showTrackingModal, setShowTrackingModal] = useState(false);
    const requestRef = useRef<number | null>(null);

    // Animation Loop
    const animate = (time: number) => {
        if (isPlaying && !isDrawMode && !isOptimizing) {
            setAngle(prev => (prev + config.speed * 0.05) % (Math.PI * 16));
        }
        requestRef.current = requestAnimationFrame(animate);
    };

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [isPlaying, config.speed, isDrawMode, isOptimizing]);

    const handleExportSVG = () => {
        const svgContent = generateSVG(config, angle);
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `mechanim_export_${Date.now()}.svg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleExportDXF = () => {
        const dxfContent = generateDXF(config, angle);
        const blob = new Blob([dxfContent], { type: 'application/dxf' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `mechanim_export_${Date.now()}.dxf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const runSingleTypeOptimization = async (
        mechType: MechanismType,
        targetPath: Point[],
        seedMech: MechanismConfig,
        timePerType: number = 0 // milliseconds, 0 = use default generations
    ): Promise<{ type: MechanismType; config: MechanismConfig; score: number } | null> => {
        // Scale parameters based on time budget (Option 1: Duration scaling)
        // Base: 800 candidates at 0 duration, scale up with more time
        const BASE_CANDIDATES = 800;
        const BASE_POPULATION = 60;
        const DEFAULT_GENERATIONS = 80;

        // Scale candidates with duration: more time = more exploration
        // At 2s per type: 800, at 6s: 1600, at 12s: 2400
        const scaleFactor = timePerType > 0 ? Math.max(1, timePerType / 2000) : 1;
        const PRE_COMPUTE_SIZE = Math.min(3000, Math.floor(BASE_CANDIDATES * scaleFactor));
        const POPULATION_SIZE = Math.min(100, Math.floor(BASE_POPULATION * Math.sqrt(scaleFactor)));

        // Generate candidates for this specific type
        let candidates: MechanismConfig[] = [];
        for (let i = 0; i < PRE_COMPUTE_SIZE; i++) {
            candidates.push(generateSmartConfig(targetPath, mechType, undefined));
        }

        // Score and sort candidates
        const scoredCandidates = candidates.map(m => ({
            mech: m,
            score: evaluateFitness(m, targetPath)
        }));

        const validCandidates = scoredCandidates.filter(s => s.score < 1e8);
        const poolSource = validCandidates.length > 0 ? validCandidates : scoredCandidates;
        poolSource.sort((a, b) => a.score - b.score);

        let population: MechanismConfig[] = poolSource.slice(0, POPULATION_SIZE).map(s => s.mech);
        while (population.length < POPULATION_SIZE) {
            population.push(generateSmartConfig(targetPath, mechType, undefined));
        }

        let globalBest = population[0];
        let globalBestScore = evaluateFitness(globalBest, targetPath);

        // Evolutionary optimization - time-based or generation-based
        const startTime = Date.now();
        const isTimeBound = timePerType > 0;
        let generation = 0;

        while (true) {
            if (isTimeBound) {
                if (Date.now() - startTime >= timePerType) break;
            } else {
                if (generation >= DEFAULT_GENERATIONS) break;
            }

            const scored = population.map(m => ({
                mech: m,
                score: evaluateFitness(m, targetPath)
            }));
            scored.sort((a, b) => a.score - b.score);

            if (scored[0].score < globalBestScore) {
                globalBestScore = scored[0].score;
                globalBest = scored[0].mech;
            }

            const nextGen: MechanismConfig[] = [];
            for (let i = 0; i < POPULATION_SIZE * 0.15; i++) nextGen.push(scored[i].mech);

            const survivors = scored.slice(0, POPULATION_SIZE / 2);
            while (nextGen.length < POPULATION_SIZE) {
                if (Math.random() < 0.10) {
                    nextGen.push(generateSmartConfig(targetPath, mechType, undefined));
                } else {
                    const parent = survivors[Math.floor(Math.random() * survivors.length)].mech;
                    let progress = 0;
                    if (isTimeBound) progress = (Date.now() - startTime) / timePerType;
                    else progress = generation / DEFAULT_GENERATIONS;
                    const temperature = Math.max(0.05, 1.0 - Math.pow(progress, 0.5));
                    nextGen.push(mutateConfig(parent, temperature, true)); // fixedType = true
                }
            }
            population = nextGen;
            generation++;

            // Allow UI updates
            if (generation % 10 === 0) {
                await new Promise(r => setTimeout(r, 5));
            }
        }

        // Local refinement for 5-bar (deeper refinement)
        if (globalBest.type === '5bar') {
            globalBest = localRefine5bar(globalBest, targetPath, 40);
            globalBestScore = evaluateFitness(globalBest, targetPath);
        }

        return { type: mechType, config: globalBest, score: globalBestScore };
    };

    const runOptimization = async (options: OptimizationOptions = {}) => {
        if (userPath.length < 3) {
            alert("Please draw a path first!");
            return;
        }
        if (!selectedId) {
            alert("Please select a part to optimize.");
            return;
        }

        setIsOptimizing(true);
        setIsPlaying(false);

        const { forcedType, excludeCurrent, testAllTypes, seedMechanism } = options;
        const targetMechIndex = config.mechanisms.findIndex(m => m.id === selectedId);
        if (targetMechIndex === -1) {
            setIsOptimizing(false);
            return;
        }

        const seedMech = config.mechanisms[targetMechIndex];

        // If testAllTypes is enabled, run optimization for each type IN PARALLEL and pick the best
        if (testAllTypes) {
            const allTypes: MechanismType[] = ['4bar', 'piston', 'yoke', 'quick-return', '5bar'];

            // Each type gets the FULL duration (running in parallel means total time ≈ duration)
            const totalTimeMs = optDuration * 1000;
            const timePerType = totalTimeMs; // Full duration for each type since they run in parallel

            // Option 3: Run all type optimizations in PARALLEL using Promise.all
            const optimizationPromises = allTypes.map(mechType =>
                runSingleTypeOptimization(mechType, userPath, seedMech, timePerType)
            );

            // Wait for all parallel optimizations to complete
            const results = await Promise.all(optimizationPromises);

            // Filter out nulls and sort by score
            const typeResults = results.filter((r): r is { type: MechanismType; config: MechanismConfig; score: number } => r !== null);
            typeResults.sort((a, b) => a.score - b.score);

            if (typeResults.length > 0) {
                const bestResult = typeResults[0];
                setConfig(prev => ({
                    ...prev,
                    mechanisms: prev.mechanisms.map((m, i) =>
                        i === targetMechIndex
                            ? { ...bestResult.config, id: seedMech.id, color: seedMech.color }
                            : m
                    )
                }));
            }

            setIsOptimizing(false);
            setIsPlaying(true);
            return;
        }

        const excludedType = excludeCurrent ? seedMech.type : undefined;
        const isTypeMismatch = forcedType && forcedType !== seedMech.type;

        // --- PRE-OPTIMIZATION: MONTE CARLO SEARCH ---
        // Option 1: Scale candidates with duration for better exploration
        const BASE_COMPUTE_SIZE = 2000;
        const BASE_POPULATION = 100;
        const timeLimitMs = optDuration * 1000;
        const scaleFactor = timeLimitMs > 0 ? Math.max(1, timeLimitMs / 5000) : 1; // 5s baseline
        const PRE_COMPUTE_SIZE = Math.min(5000, Math.floor(BASE_COMPUTE_SIZE * scaleFactor));
        const POPULATION_SIZE = Math.min(150, Math.floor(BASE_POPULATION * Math.sqrt(scaleFactor)));

        let initialCandidates: MechanismConfig[] = [];

        // 1. Add User Seed / Preset with MASSIVE FREEDOM
        if (seedMechanism) {
            const bounds = userPath.length > 0 ? getBounds(userPath) : { cx: 0, cy: 0, w: 200, h: 200 };
            const pathSize = Math.max(bounds.w, bounds.h) || 200;

            // Generate 500 variations of the preset placed RANDOMLY around the canvas
            for (let i = 0; i < 500; i++) {
                const cand = { ...seedMechanism, id: Math.random().toString(36).substr(2, 9) };

                cand.anchorX = bounds.cx + (Math.random() - 0.5) * pathSize * 4.0;
                cand.anchorY = bounds.cy + (Math.random() - 0.5) * pathSize * 4.0;
                cand.groundAngle = Math.random() * 360;

                const currentSize = cand.crankLength + cand.couplerLength + (cand.rockerLength || 0);
                const targetSize = pathSize * (0.5 + Math.random() * 2.0);
                const scaleRatio = targetSize / Math.max(10, currentSize);

                cand.groundLength *= scaleRatio;
                cand.crankLength *= scaleRatio;
                cand.couplerLength *= scaleRatio;
                cand.rockerLength *= scaleRatio;
                if (cand.rodLength) cand.rodLength *= scaleRatio;
                if (cand.sliderOffset) cand.sliderOffset *= scaleRatio;
                cand.couplerPointDist *= scaleRatio;
                if (cand.outputGearRadius) cand.outputGearRadius *= scaleRatio;

                if (cand.type === '5bar') {
                    const minArm = (cand.groundLength + cand.crankLength + cand.rockerLength) * 0.6;
                    cand.couplerLength = Math.max(cand.couplerLength, minArm);
                    cand.rodLength = Math.max(cand.rodLength || 100, minArm);

                    // PRESERVE the original speed ratios - they are the "recipe" for the curve shape
                    if (seedMechanism.speed1 !== undefined) cand.speed1 = seedMechanism.speed1;
                    if (seedMechanism.speed2 !== undefined) cand.speed2 = seedMechanism.speed2;

                    // But vary the phase to explore different orientations of the same curve
                    cand.phase = (seedMechanism.phase ?? 0) + (Math.random() - 0.5) * Math.PI;
                }

                initialCandidates.push(cand);
            }
        } else if (!excludeCurrent && !isTypeMismatch) {
            initialCandidates.push(seedMech);
            for (let i = 0; i < 20; i++) {
                initialCandidates.push(mutateConfig(seedMech, 0.5, !!forcedType));
            }
        }

        for (let i = 0; i < PRE_COMPUTE_SIZE; i++) {
            initialCandidates.push(generateSmartConfig(userPath, forcedType, excludedType));
        }

        const scoredCandidates = initialCandidates.map(m => ({
            mech: m,
            score: evaluateFitness(m, userPath)
        }));

        const validCandidates = scoredCandidates.filter(s => s.score < 1e8);
        const poolSource = validCandidates.length > 0 ? validCandidates : scoredCandidates;

        poolSource.sort((a, b) => a.score - b.score);

        let population: MechanismConfig[] = poolSource.slice(0, POPULATION_SIZE).map(s => s.mech);

        while (population.length < POPULATION_SIZE) {
            population.push(generateSmartConfig(userPath, forcedType, excludedType));
        }

        let globalBest = population[0];
        let globalBestScore = evaluateFitness(globalBest, userPath);

        // --- EVOLUTIONARY OPTIMIZATION ---
        const DEFAULT_GENERATIONS = 100;
        const startTime = Date.now();
        const timeLimit = optDuration * 1000;
        const isTimeBound = timeLimit > 0;
        let generation = 0;

        while (true) {
            if (isTimeBound) {
                if (Date.now() - startTime >= timeLimit) break;
            } else {
                if (generation >= DEFAULT_GENERATIONS) break;
            }

            const scored = population.map(m => ({
                mech: m,
                score: evaluateFitness(m, userPath)
            }));

            scored.sort((a, b) => a.score - b.score);

            const bestOfGen = scored[0].mech;
            const bestGenScore = scored[0].score;

            if (bestGenScore < globalBestScore) {
                globalBestScore = bestGenScore;
                globalBest = bestOfGen;
            }

            setConfig(prev => ({
                ...prev,
                mechanisms: prev.mechanisms.map((m, i) => i === targetMechIndex ? { ...bestOfGen, id: seedMech.id, color: seedMech.color } : m)
            }));

            const nextGen: MechanismConfig[] = [];
            for (let i = 0; i < POPULATION_SIZE * 0.15; i++) nextGen.push(scored[i].mech);

            const survivors = scored.slice(0, POPULATION_SIZE / 2);

            while (nextGen.length < POPULATION_SIZE) {
                if (Math.random() < 0.10) {
                    nextGen.push(generateSmartConfig(userPath, forcedType, excludedType));
                } else {
                    const parent = survivors[Math.floor(Math.random() * survivors.length)].mech;
                    let progress = 0;
                    if (isTimeBound) progress = (Date.now() - startTime) / timeLimit;
                    else progress = generation / DEFAULT_GENERATIONS;
                    const temperature = Math.max(0.05, 1.0 - Math.pow(progress, 0.5));
                    nextGen.push(mutateConfig(parent, temperature, !!forcedType, excludedType));
                }
            }

            population = nextGen;
            generation++;

            await new Promise(r => setTimeout(r, 10));
        }

        // Local gradient refinement for 5-bar mechanisms
        if (globalBest.type === '5bar') {
            globalBest = localRefine5bar(globalBest, userPath, 30);
        }

        setConfig(prev => ({
            ...prev,
            mechanisms: prev.mechanisms.map((m, i) => i === targetMechIndex ? { ...globalBest, id: seedMech.id, color: seedMech.color } : m)
        }));

        setIsOptimizing(false);
        setIsPlaying(true);
    };

    const savePreset = () => {
        const name = prompt("Name this setup:", "My Design " + (presets.length + 1));
        if (name) {
            setPresets([...presets, { name, conf: JSON.parse(JSON.stringify(config)) }]);
        }
    };

    const loadPreset = (newConf: GlobalConfig) => {
        const freshMechs = newConf.mechanisms.map(m => ({ ...m, id: Math.random().toString(36).substr(2, 9) }));
        setConfig({ ...newConf, mechanisms: freshMechs });
        if (freshMechs.length > 0) setSelectedId(freshMechs[0].id);
    };

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-slate-200 font-sans">
            <div className="w-80 flex-shrink-0 h-full z-20 relative">
                <Controls
                    config={config}
                    setConfig={setConfig}
                    selectedId={selectedId}
                    setSelectedId={setSelectedId}
                    isPlaying={isPlaying}
                    setIsPlaying={setIsPlaying}
                    showTrace={showTrace}
                    setShowTrace={setShowTrace}
                    isDrawMode={isDrawMode}
                    toggleDrawMode={() => setIsDrawMode(!isDrawMode)}
                    clearUserPath={() => setUserPath([])}
                    onOptimize={runOptimization}
                    isOptimizing={isOptimizing}
                    presets={presets}
                    onSavePreset={savePreset}
                    onLoadPreset={loadPreset}
                    optimizationDuration={optDuration}
                    setOptimizationDuration={setOptDuration}
                    onExportSVG={handleExportSVG}
                    onExportDXF={handleExportDXF}
                    onOpenTracking={() => setShowTrackingModal(true)}
                    angle={angle}
                    setAngle={setAngle}
                />
            </div>

            <main className="flex-1 flex flex-col h-full relative shadow-inner">
                <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-2">
                    <button
                        onClick={() => setShowHelp(!showHelp)}
                        className="w-8 h-8 flex items-center justify-center bg-white rounded-full shadow-md border border-slate-300 hover:bg-slate-50 text-slate-600 transition-colors"
                        title="Visual Editor Help"
                    >
                        {showHelp ? <X size={16} /> : <Info size={16} />}
                    </button>

                    {showHelp && (
                        <div className="bg-white/90 backdrop-blur p-4 rounded-xl border border-slate-300 shadow-lg max-w-xs select-none animate-in fade-in slide-in-from-top-2 duration-200">
                            <h3 className="font-bold text-slate-800 text-sm mb-2">Editor Instructions</h3>
                            <ul className="text-xs text-slate-600 space-y-2 pl-2">
                                <li className="flex gap-2">
                                    <span className="font-bold bg-slate-200 rounded px-1">Modify</span>
                                    <span>Drag joints to change lengths.</span>
                                </li>
                                <li className="flex gap-2">
                                    <span className="font-bold bg-slate-200 rounded px-1">Move</span>
                                    <span>Drag anchor points (center of gears) to move parts.</span>
                                </li>
                                <li className="flex gap-2">
                                    <span className="font-bold bg-slate-200 rounded px-1">Zoom/Pan</span>
                                    <span>Scroll to zoom, Middle-click drag to pan.</span>
                                </li>
                                <li className="flex gap-2">
                                    <span className="font-bold bg-slate-200 rounded px-1">Shift + Draw</span>
                                    <span>Draw straight lines.</span>
                                </li>
                            </ul>
                        </div>
                    )}
                </div>

                <div className="flex-1 p-0 md:p-4 flex items-center justify-center overflow-hidden bg-slate-300/50">
                    <div className="w-full h-full max-w-6xl max-h-[900px] transition-all duration-300">
                        <Canvas
                            config={config}
                            setConfig={setConfig}
                            selectedId={selectedId}
                            setSelectedId={setSelectedId}
                            isPlaying={isPlaying}
                            showTrace={showTrace}
                            isDrawMode={isDrawMode}
                            userPath={userPath}
                            setUserPath={setUserPath}
                            angle={angle}
                            setAngle={setAngle}
                        />
                    </div>
                </div>
            </main>

            {/* Tracking Modal */}
            <TrackingModal
                isOpen={showTrackingModal}
                onClose={() => setShowTrackingModal(false)}
                onTransfer={(path) => {
                    // Transfer tracked path to userPath for optimization
                    setUserPath(path);
                    setShowTrackingModal(false);
                }}
            />
        </div>
    );
};

export default App;
