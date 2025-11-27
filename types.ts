
export type MechanismType = 'crank' | '4bar' | 'piston' | 'yoke' | 'quick-return' | '5bar';

export interface Point {
    x: number;
    y: number;
}

export interface MechanismConfig {
    id: string;
    type: MechanismType;
    visible: boolean;
    color: string;
    
    // Position & Orientation
    anchorX?: number; // X position of the main crank pivot
    anchorY?: number; // Y position of the main crank pivot
    groundAngle?: number; // Angle of the ground link (radians or degrees depending on usage, usually degrees in config)

    // Dimensions
    crankLength: number;
    groundLength: number; 
    couplerLength: number;
    rockerLength: number; 
    sliderOffset: number; 
    couplerPointDist: number; 
    couplerPointAngle: number; 
    
    // 5-Bar / Advanced
    speed1?: number;
    speed2?: number;
    gearRatio?: number;
    rodLength?: number;
    phase?: number; // Phase offset for the secondary gear (radians)

    // Visuals
    showOutputGear?: boolean;
    outputGearRadius?: number;
}

export interface GlobalConfig {
    speed: number;
    mechanisms: MechanismConfig[];
}

export interface JointState {
    p1: Point; 
    p2: Point; 
    j1: Point; 
    j2: Point; 
    aux?: Point; // Used for 5-bar secondary crank tip
    effector: Point; 
    isValid: boolean; 
}