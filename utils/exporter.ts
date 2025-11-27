
import { GlobalConfig, MechanismConfig, Point } from '../types';
import { calculateLinkage, generateCurvePoints } from './kinematics';

// --- DXF HELPER FUNCTIONS ---

const dxfHeader = () => `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n`;
const dxfFooter = () => `0\nENDSEC\n0\nEOF\n`;

const dxfLine = (x1: number, y1: number, x2: number, y2: number, layer: string = "0", color: number = 7) => {
    return `0\nLINE\n8\n${layer}\n62\n${color}\n10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}\n`;
};

const dxfCircle = (cx: number, cy: number, r: number, layer: string = "0", color: number = 7) => {
    return `0\nCIRCLE\n8\n${layer}\n62\n${color}\n10\n${cx}\n20\n${cy}\n40\n${r}\n`;
};

const dxfPolyline = (points: Point[], layer: string = "TRACE", color: number = 3) => {
    let s = `0\nLWPOLYLINE\n8\n${layer}\n62\n${color}\n100\nAcDbEntity\n100\nAcDbPolyline\n90\n${points.length}\n70\n0\n`;
    points.forEach(p => {
        s += `10\n${p.x}\n20\n${p.y}\n`;
    });
    return s;
};

// --- SVG HELPER FUNCTIONS ---

const getGearPathD = (radius: number, teeth: number) => {
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
    return d;
};

// --- EXPORT FUNCTIONS ---

export const generateDXF = (config: GlobalConfig, angle: number): string => {
    let content = dxfHeader();

    // 1. Trace Paths (Green)
    config.mechanisms.forEach(m => {
        if (m.type !== 'crank') {
            const { points } = generateCurvePoints(m, 100);
            if (points.length > 1) {
                content += dxfPolyline(points, "TRACE_" + m.id.toUpperCase(), 3); 
            }
        }
    });

    // 2. Mechanism Geometry (Current Frame)
    config.mechanisms.forEach(m => {
        const state = calculateLinkage(m, angle);
        const { p1, p2, j1, j2, aux, effector, isValid } = state;
        
        if (!isValid) return;

        const MECH_LAYER = "MECH_" + m.id.toUpperCase();

        // Crank Arm (Common)
        content += dxfLine(p1.x, p1.y, j1.x, j1.y, MECH_LAYER, 1); 
        content += dxfCircle(p1.x, p1.y, 5, "JOINTS", 7);

        if (m.type === '4bar') {
            content += dxfLine(p1.x, p1.y, p2.x, p2.y, "GROUND", 8);
            content += dxfLine(p2.x, p2.y, j2.x, j2.y, MECH_LAYER, 1);
            content += dxfLine(j1.x, j1.y, j2.x, j2.y, MECH_LAYER, 1);
            // Effector Triangle/Extension
            content += dxfLine(j1.x, j1.y, effector.x, effector.y, MECH_LAYER, 1);
            content += dxfLine(j2.x, j2.y, effector.x, effector.y, MECH_LAYER, 1);
            content += dxfCircle(p2.x, p2.y, 5, "JOINTS", 7);
        } 
        else if (m.type === '5bar' && aux) {
            content += dxfLine(p1.x, p1.y, p2.x, p2.y, "GROUND", 8);
            // Secondary Crank
            content += dxfLine(p2.x, p2.y, aux.x, aux.y, MECH_LAYER, 1);
            // Rods
            content += dxfLine(j1.x, j1.y, effector.x, effector.y, MECH_LAYER, 1);
            content += dxfLine(aux.x, aux.y, j2.x, j2.y, MECH_LAYER, 1);
            // Inner segment (virtual or real depending on design)
            content += dxfLine(j2.x, j2.y, effector.x, effector.y, MECH_LAYER, 1);
            content += dxfCircle(p2.x, p2.y, 5, "JOINTS", 7);
        }
        else if (m.type === 'piston') {
            content += dxfLine(j1.x, j1.y, j2.x, j2.y, MECH_LAYER, 1);
            // Track line
            const trackAngle = (m.groundAngle || 0) * Math.PI / 180;
            const tx = Math.cos(trackAngle) * 100;
            const ty = Math.sin(trackAngle) * 100;
            content += dxfLine(j2.x - tx, j2.y - ty, j2.x + tx, j2.y + ty, "GROUND", 8);
        }
        else if (m.type === 'yoke') {
            content += dxfLine(j2.x - 40, j2.y, j2.x + 40, j2.y, MECH_LAYER, 1); // Plate
        }
        else if (m.type === 'quick-return') {
            content += dxfLine(p1.x, p1.y, p2.x, p2.y, "GROUND", 8);
            content += dxfLine(p2.x, p2.y, j2.x, j2.y, MECH_LAYER, 1);
            content += dxfLine(j2.x, j2.y, effector.x, effector.y, MECH_LAYER, 1);
        }

        // Joint Circles
        content += dxfCircle(j1.x, j1.y, 3, "JOINTS", 7);
        if (j2) content += dxfCircle(j2.x, j2.y, 3, "JOINTS", 7);
        content += dxfCircle(effector.x, effector.y, 3, "EFFECTOR", 7);
    });

    content += dxfFooter();
    return content;
};

export const generateSVG = (config: GlobalConfig, angle: number): string => {
    const W = 800;
    const H = 600;
    const OFFSET_X = 400;
    const OFFSET_Y = 300;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="background-color: #f8fafc">`;
    
    // Apply coordinate transformation to match the canvas
    svg += `<g transform="translate(${OFFSET_X}, ${OFFSET_Y}) scale(1, -1)">`;

    // 1. Traces
    config.mechanisms.forEach(m => {
        if (m.type !== 'crank') {
            const { points } = generateCurvePoints(m, 100);
            if (points.length > 1) {
                const d = `M ${points.map(p => `${p.x},${p.y}`).join(' L ')}`;
                svg += `<path d="${d}" fill="none" stroke="${m.color}" stroke-width="2" opacity="0.5" stroke-linejoin="round" stroke-linecap="round" />`;
            }
        }
    });

    // 2. Mechanisms
    config.mechanisms.forEach(m => {
        const state = calculateLinkage(m, angle);
        const { p1, p2, j1, j2, aux, effector, isValid } = state;

        if (!isValid) return;

        const crankDeg = (angle * 180) / Math.PI;

        // Anchors & Gears
        svg += `<g transform="translate(${p1.x}, ${p1.y}) rotate(${crankDeg * (m.speed1 ?? 1)})">`;
        svg += `<path d="${getGearPathD(m.crankLength + 10, 14)}" fill="#f59e0b" stroke="#b45309" stroke-width="2" />`;
        svg += `<circle cx="0" cy="0" r="4" fill="#475569" stroke="white" />`;
        svg += `</g>`;

        // Output Gear for 5-bar
        if (m.type === '5bar' && aux) {
             const rot = (crankDeg * (m.speed2 ?? (m.gearRatio || 1))) + ((m.phase ?? 0) * 180 / Math.PI);
             const teeth = Math.max(3, Math.round(14 * (m.rockerLength / m.crankLength)));
             svg += `<g transform="translate(${p2.x}, ${p2.y}) rotate(${rot})">`;
             svg += `<path d="${getGearPathD(m.rockerLength + 10, teeth)}" fill="#f59e0b" stroke="#b45309" stroke-width="2" />`;
             svg += `<circle cx="0" cy="0" r="4" fill="#475569" stroke="white" />`;
             svg += `</g>`;
        }

        // Arms
        svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${j1.x}" y2="${j1.y}" stroke="#78350f" stroke-width="4" stroke-linecap="round" />`;

        if (m.type === '4bar') {
            svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#cbd5e1" stroke-width="12" stroke-linecap="round" />`;
            svg += `<line x1="${p2.x}" y1="${p2.y}" x2="${j2.x}" y2="${j2.y}" stroke="#475569" stroke-width="8" stroke-linecap="round" />`;
            svg += `<path d="M ${j1.x} ${j1.y} L ${j2.x} ${j2.y} L ${effector.x} ${effector.y} Z" fill="${m.color}" fill-opacity="0.2" stroke="${m.color}" stroke-width="1" />`;
            svg += `<line x1="${j1.x}" y1="${j1.y}" x2="${j2.x}" y2="${j2.y}" stroke="${m.color}" stroke-width="8" stroke-linecap="round" />`;
            svg += `<circle cx="${p2.x}" cy="${p2.y}" r="8" fill="#94a3b8" stroke="white" stroke-width="2" />`;
        } 
        else if (m.type === '5bar' && aux) {
             svg += `<line x1="${p2.x}" y1="${p2.y}" x2="${aux.x}" y2="${aux.y}" stroke="#78350f" stroke-width="4" stroke-linecap="round" />`;
             svg += `<line x1="${j1.x}" y1="${j1.y}" x2="${effector.x}" y2="${effector.y}" stroke="#475569" stroke-width="6" stroke-linecap="round" />`;
             svg += `<line x1="${aux.x}" y1="${aux.y}" x2="${j2.x}" y2="${j2.y}" stroke="#475569" stroke-width="6" stroke-linecap="round" />`;
        }
        else if (m.type === 'piston') {
             svg += `<path d="M ${j1.x} ${j1.y} L ${j2.x} ${j2.y} L ${effector.x} ${effector.y} Z" fill="${m.color}" fill-opacity="0.2" stroke="${m.color}" stroke-width="1" />`;
             svg += `<line x1="${j1.x}" y1="${j1.y}" x2="${j2.x}" y2="${j2.y}" stroke="${m.color}" stroke-width="8" stroke-linecap="round" />`;
             svg += `<rect x="${j2.x - 20}" y="${j2.y - 10}" width="40" height="20" fill="#334155" rx="2" transform="rotate(${m.groundAngle||0} ${j2.x} ${j2.y})" />`;
        }
        else if (m.type === 'quick-return') {
            svg += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#cbd5e1" stroke-width="8" stroke-linecap="round" />`;
            svg += `<line x1="${j2.x}" y1="${j2.y}" x2="${effector.x}" y2="${effector.y}" stroke="${m.color}" stroke-width="4" stroke-linecap="round" />`;
            svg += `<path d="M ${p2.x} ${p2.y} L ${j2.x} ${j2.y} L ${effector.x} ${effector.y} Z" fill="${m.color}" fill-opacity="0.1" />`;
            svg += `<line x1="${p2.x}" y1="${p2.y}" x2="${j2.x}" y2="${j2.y}" stroke="#475569" stroke-width="10" stroke-linecap="round" />`;
        }

        // Joints
        svg += `<circle cx="${j1.x}" cy="${j1.y}" r="4" fill="${m.color}" />`;
        if (aux) svg += `<circle cx="${aux.x}" cy="${aux.y}" r="4" fill="${m.color}" />`;
        if (j2) svg += `<circle cx="${j2.x}" cy="${j2.y}" r="5" fill="white" stroke="#334155" stroke-width="2" />`;
        svg += `<circle cx="${effector.x}" cy="${effector.y}" r="6" fill="#ef4444" stroke="white" stroke-width="2" />`;
    });

    svg += `</g></svg>`;
    return svg;
};