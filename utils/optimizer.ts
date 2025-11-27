
import { MechanismConfig, Point, MechanismType } from '../types';
import { generateCurvePoints } from './kinematics';

const MECHANISM_TYPES: MechanismType[] = ['4bar', 'piston', 'yoke', 'quick-return', '5bar'];

// Ratios that create clean, closed Lissajous/Rose curves. 
const HARMONIC_RATIOS = [1, 2, 3, 4, 0.5, 0.25, 1.5, 0.666, 2.5, 0.4, 1.333, 0.75, 1.25, 0.8, -1, -2, -3, -4, -0.5, -0.25, -1.5, -0.666, -2.5, -0.4, -1.333, -0.75, -1.25, -0.8];

export const getBounds = (points: Point[]) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    points.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    });
    return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
};

export const evaluateFitness = (config: MechanismConfig, targetPath: Point[]): number => {
    // For 5-bar, we need more points to check for loop closure and detail
    const resolution = config.type === '5bar' ? 120 : 60;
    const { points: generatedPath, percentValid } = generateCurvePoints(config, resolution); 

    // CRITICAL: Heavy penalty for any invalidity (breaking/locking)
    if (percentValid < 1) {
        return 1e9 + (1.0 - percentValid) * 1e9;
    }
    
    if (generatedPath.length < 10) return 1e9;

    // Bidirectional Chamfer Distance
    let forwardError = 0;
    for (const pg of generatedPath) {
        let minD = Infinity;
        for (const pt of targetPath) {
            const d = (pg.x - pt.x)**2 + (pg.y - pt.y)**2;
            if (d < minD) minD = d;
        }
        forwardError += minD;
    }
    forwardError /= generatedPath.length;

    let backwardError = 0;
    for (const pt of targetPath) {
        let minD = Infinity;
        for (const pg of generatedPath) {
            const d = (pt.x - pg.x)**2 + (pt.y - pg.y)**2;
            if (d < minD) minD = d;
        }
        backwardError += minD;
    }
    backwardError /= targetPath.length;

    // Extra penalty for curves that don't close their loop (messy scribbles)
    let closurePenalty = 0;
    if (config.type === '5bar' && generatedPath.length > 0) {
        const start = generatedPath[0];
        const end = generatedPath[generatedPath.length - 1];
        const gap = (start.x - end.x)**2 + (start.y - end.y)**2;
        if (gap > 50) closurePenalty = gap * 20; 
    }

    return forwardError + backwardError + closurePenalty;
};

// Enforce 5-bar geometric constraints
const enforceFiveBarConstraints = (conf: MechanismConfig) => {
    if (conf.type !== '5bar') return conf;

    const maxSeparation = Math.abs(conf.groundLength) + Math.abs(conf.crankLength) + Math.abs(conf.rockerLength);
    const currentTotalArm = Math.abs(conf.couplerLength) + Math.abs(conf.rodLength || 100);
    const minTotalArm = maxSeparation * 1.15;

    if (currentTotalArm < minTotalArm) {
        const diff = minTotalArm - currentTotalArm;
        conf.couplerLength += diff / 2;
        conf.rodLength = (conf.rodLength || 100) + diff / 2;
    }

    const armDiff = Math.abs(conf.couplerLength - (conf.rodLength || 100));
    const minSeparation = Math.max(0, Math.abs(conf.groundLength) - Math.abs(conf.crankLength) - Math.abs(conf.rockerLength));
    
    if (armDiff > minSeparation) {
         const avg = (conf.couplerLength + (conf.rodLength || 100)) / 2;
         conf.couplerLength = (conf.couplerLength + avg) / 2;
         conf.rodLength = ((conf.rodLength || 100) + avg) / 2;
    }
    
    return conf;
};

export const generateSmartConfig = (targetPath?: Point[], forcedType?: MechanismType, excludedType?: MechanismType): MechanismConfig => {
    let cx = 0, cy = 0, scale = 100;
    
    if (targetPath && targetPath.length > 0) {
        const bounds = getBounds(targetPath);
        cx = bounds.cx;
        cy = bounds.cy;
        scale = Math.max(bounds.w, bounds.h);
    }

    const s = (factor: number) => scale * factor * (0.5 + Math.random());
    
    let availableTypes = MECHANISM_TYPES;
    if (forcedType) {
        availableTypes = [forcedType];
    } else if (excludedType) {
        availableTypes = MECHANISM_TYPES.filter(t => t !== excludedType);
    }
    
    const type = availableTypes[Math.floor(Math.random() * availableTypes.length)];

    let anchorX = cx + (Math.random() - 0.5) * scale * 3.0;
    let anchorY = cy + (Math.random() - 0.5) * scale * 3.0;

    const config: MechanismConfig = {
        id: Math.random().toString(36).substr(2, 9),
        type: type,
        visible: true,
        color: '#3b82f6',
        
        anchorX: anchorX,
        anchorY: anchorY,
        groundAngle: Math.random() * 360,
        
        groundLength: s(0.8), 
        crankLength: s(0.3), 
        couplerLength: s(1.0),
        rockerLength: s(0.8),
        
        sliderOffset: 0,
        couplerPointDist: s(0.5),
        couplerPointAngle: Math.random() * 360,
        
        speed1: 1,
        speed2: 1, 
        rodLength: s(1.0),
        phase: Math.random() * Math.PI * 2
    };

    // Type-specific initialization
    if (type === 'yoke') {
        config.sliderOffset = (Math.random() - 0.5) * s(0.5);
    } else if (type === 'piston') {
        config.sliderOffset = (Math.random() - 0.5) * s(0.5);
        config.couplerLength = Math.abs(config.sliderOffset) + config.crankLength + s(0.5);
    } else if (type === 'quick-return') {
        config.sliderOffset = (Math.random() - 0.5) * s(1.0);
        config.groundLength = Math.max(s(0.5), config.crankLength + 10);
        config.rockerLength = s(1.5);
    } else if (type === '5bar') {
        config.speed1 = 1;
        const dir = Math.random() > 0.5 ? 1 : -1;
        const deviation = (Math.random() - 0.5) * 0.2;
        config.speed2 = (config.speed1 * dir) + deviation;

        config.groundLength = s(0.6); 
        config.crankLength = s(0.3);
        config.rockerLength = s(0.3); 

        const gearMidX = config.anchorX! + (Math.cos(0) * config.groundLength) / 2;
        const gearMidY = config.anchorY! + (Math.sin(0) * config.groundLength) / 2;
        const distToTarget = Math.hypot(cx - gearMidX, cy - gearMidY);

        const avgArmLen = distToTarget * (1.0 + Math.random() * 0.4); 
        config.couplerLength = avgArmLen;
        config.rodLength = avgArmLen;
        config.couplerPointDist = Math.random() * s(0.5); 
        
        enforceFiveBarConstraints(config);
    }

    return config;
};

export const mutateConfig = (config: MechanismConfig, temperature: number = 1.0, fixedType: boolean = false, excludedType?: MechanismType): MechanismConfig => {
    const newConfig = { ...config };
    
    const mutate = (val: number, range: number = 0.2) => {
        const change = val * range * temperature * (Math.random() - 0.5) * 2;
        return val + change;
    };

    const mutateAbs = (val: number, amount: number) => {
        return val + (Math.random() - 0.5) * amount * temperature;
    }

    // Structure Mutation
    if (!fixedType && temperature > 0.3 && Math.random() < 0.15) {
        let types = MECHANISM_TYPES;
        if (excludedType) types = types.filter(t => t !== excludedType);
        types = types.filter(t => t !== config.type);
        
        if (types.length > 0) {
            newConfig.type = types[Math.floor(Math.random() * types.length)];
            if (newConfig.type === '5bar') {
                newConfig.speed1 = 1;
                const dir = Math.random() > 0.5 ? 1 : -1;
                newConfig.speed2 = dir; 
                newConfig.rodLength = newConfig.couplerLength;
            }
        }
    }

    // Global Scale Mutation
    if (Math.random() < 0.15) {
        const scaleFactor = 1.0 + (Math.random() - 0.5) * 0.5 * temperature;
        newConfig.groundLength *= scaleFactor;
        newConfig.crankLength *= scaleFactor;
        newConfig.couplerLength *= scaleFactor;
        newConfig.rockerLength *= scaleFactor;
        if (newConfig.rodLength) newConfig.rodLength *= scaleFactor;
        if (newConfig.sliderOffset) newConfig.sliderOffset *= scaleFactor;
        if (newConfig.couplerPointDist) newConfig.couplerPointDist *= scaleFactor;
        if (newConfig.outputGearRadius) newConfig.outputGearRadius *= scaleFactor;
    }

    // Position & Orientation
    if (Math.random() < 0.7) newConfig.anchorX = mutateAbs(newConfig.anchorX!, 150);
    if (Math.random() < 0.7) newConfig.anchorY = mutateAbs(newConfig.anchorY!, 150);
    if (Math.random() < 0.7) newConfig.groundAngle = mutateAbs(newConfig.groundAngle!, 60);

    // Dimension Mutation
    if (Math.random() < 0.7) newConfig.groundLength = mutate(newConfig.groundLength);
    if (Math.random() < 0.7) newConfig.couplerLength = mutate(newConfig.couplerLength);
    if (Math.random() < 0.7) newConfig.rockerLength = mutate(newConfig.rockerLength);
    if (Math.random() < 0.7) newConfig.couplerPointDist = mutate(newConfig.couplerPointDist);
    if (Math.random() < 0.7) newConfig.crankLength = mutate(newConfig.crankLength);
    
    // 5-Bar Specific Mutation
    if (newConfig.type === '5bar') {
        if (Math.random() < 0.7) newConfig.rodLength = mutate(newConfig.rodLength || 100);
        if (Math.random() < 0.6) {
            newConfig.phase = (newConfig.phase || 0) + (Math.random() - 0.5) * Math.PI * 0.5 * temperature;
        }
        if (Math.random() < 0.3) {
             const currentDiff = (newConfig.speed2 || 1) - (newConfig.speed1 || 1);
             const dir = currentDiff >= 0 ? 1 : -1;
             const jitter = (Math.random() - 0.5) * 0.05;
             let newSpeed2 = (newConfig.speed2 || 1) + jitter;
             const s1 = newConfig.speed1 || 1;
             const isCounter = (s1 > 0 && newSpeed2 < 0) || (s1 < 0 && newSpeed2 > 0);
             const targetBase = isCounter ? -s1 : s1;
             if (Math.abs(newSpeed2 - targetBase) > 0.1) {
                 newSpeed2 = targetBase + (newSpeed2 > targetBase ? 0.1 : -0.1);
             }
             newConfig.speed2 = newSpeed2;
        }
    }

    if (Math.random() < 0.7) newConfig.sliderOffset = mutateAbs(newConfig.sliderOffset, 30);
    if (Math.random() < 0.7) newConfig.couplerPointAngle = mutateAbs(newConfig.couplerPointAngle, 60);

    newConfig.groundLength = Math.max(5, Math.abs(newConfig.groundLength));
    newConfig.crankLength = Math.max(5, Math.abs(newConfig.crankLength));
    newConfig.couplerLength = Math.max(5, Math.abs(newConfig.couplerLength));
    newConfig.rockerLength = Math.max(5, Math.abs(newConfig.rockerLength));
    if (newConfig.rodLength) newConfig.rodLength = Math.max(5, Math.abs(newConfig.rodLength));

    if (newConfig.type === '5bar') {
        enforceFiveBarConstraints(newConfig);
    }

    return newConfig;
};