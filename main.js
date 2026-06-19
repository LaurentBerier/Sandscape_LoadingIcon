import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// --- Feel / tuning -----------------------------------------------------------
// The spin NEVER stops: a slow baseline creep that accelerates into a fast whirl
// through each (short) morph, then eases back to the creep. It is phase-locked to
// exactly one full turn per loop, so the figure-8 hold always re-centers on the
// same non-mirrored corner-on "S" for Sandscape (it keeps creeping, never stops).
const SLOW_BASE = 0.1;           // baseline spin (rad/s) during holds — slow, never 0
const MORPH_SPIN_BONUS = 10.111; // peak extra rad/s during the (fast) morph whirl
const SPIN_BASE_YAW = 3.827;     // phase so the figure-8 hold centers on the corner-on "S"
const SPIN_TRACK_TAU = 0.12;     // s, how tightly spin tracks the locked target / re-settles
const SEQUENCE_SPEED = 1.25;     // playback rate of the whole morph+spin loop (>1 = faster)
const DRAG_YAW_SENS = 0.0095;    // rad per px of horizontal drag
const DRAG_PITCH_SENS = 0.006;   // rad per px of vertical drag
const PICK_RADIUS = 1.85;        // world-space grab radius around the mark
const fullTurn = Math.PI * 2;

// Re-pose applied ONLY to the stacked figure-8 state (scaled by the morph's
// logoPose, so the single cube is left exactly as it was). It swings the cubes
// off corner-on toward the logo's 3/4 "front-face" perspective, then leans the
// stack so the two boxes read as the Sandscape "S".
const DOUBLE_YAW_OFFSET = -0.42;   // rad: rotate toward face-on (wide front, narrow side)
const DOUBLE_PITCH_OFFSET = 0.10;  // rad: ease the downward tilt a touch
const DOUBLE_ROLL_OFFSET = 0.02;   // rad: keep the stacked cubes upright (cancels the base lean)

const canvas = document.querySelector('#loader-canvas');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030106);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const cameraFrustum = 22.9;        // ~10% smaller mark than 20.8
const MARK_OFFSET_Y = 1.4;         // raise the mark a bit above center (world units)
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(0, 0, 10);

// HDR + 4x MSAA render target so the neon filaments stay crisp going into bloom.
const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  samples: 4,
});
const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.58,
  0.6,
  0.08,
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const clock = new THREE.Clock();

// Steady backdrop (never rotates with the mark).
const grid = createDiagonalGrid();
grid.position.z = -3;
scene.add(grid);

const haze = createPurpleHaze();
haze.position.set(0, MARK_OFFSET_Y, -0.5);
scene.add(haze);

// Pose rig: an outer group leans the whole figure in screen space (roll), an
// inner rig pitches it down and spins it around its vertical axis.
const tiltGroup = new THREE.Group();
tiltGroup.position.y = MARK_OFFSET_Y;
scene.add(tiltGroup);
const spinRig = new THREE.Group();
tiltGroup.add(spinRig);

const cubeSize = 1.24;
const cubeLines = createCubeLines(cubeSize);
const singleTargets = createSingleCube();
const stackOffset = new THREE.Vector3(0.34, 0.70, -0.10); // upper cube; lower mirrors it
const doubleTargets = createDoubleCube();
const linePositions = new Float32Array(singleTargets);
let lastMorphAmount = -1;

// A restrained neon build: a thin near-white filament, a violet body, and a soft
// deep-violet aura. Kept lean so the bloom stays elegant rather than blown out.
const coreLines = createLineLayer(linePositions, 0xefe6ff, 1.3, 0.9);
const glowLines = createLineLayer(linePositions, 0xa64dff, 2.8, 0.42);
const auraLines = createLineLayer(linePositions, 0x6a1fff, 5.6, 0.1);
spinRig.add(auraLines, glowLines, coreLines);

// Invisible sphere used to hit-test "is the player clicking on the object".
const pickSphere = new THREE.Mesh(
  new THREE.SphereGeometry(PICK_RADIUS, 16, 12),
  new THREE.MeshBasicMaterial({ visible: false }),
);
pickSphere.position.y = MARK_OFFSET_Y;
scene.add(pickSphere);

const calmDuration = 2;
const morphDuration = 0.45;
const doubleHoldStart = calmDuration + morphDuration;
const doubleHoldEnd = doubleHoldStart + calmDuration;
const loopDuration = doubleHoldEnd + morphDuration;
const morphInt = (morphDuration * 2) / Math.PI; // integral of sin(pi*p) over one morph

// --- Runtime state -----------------------------------------------------------
let morphClock = 0;                // drives the single <-> double cycle (pauses on grab)
let spinAngle = SPIN_BASE_YAW;     // yaw; tracks the locked spin in auto, free while dragging
let prevSpinAngle = SPIN_BASE_YAW; // previous frame's yaw, for measuring spin speed
let userPitch = 0;                 // pitch offset contributed by dragging
let elapsed = 0;                   // monotonic seconds for breathing / pulse

let dragging = false;
let lastPointerX = 0;
let lastPointerY = 0;
const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

function createBoxLines(width, height, depth) {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const hd = depth * 0.5;
  const corners = [
    [-hw, -hh, -hd],
    [hw, -hh, -hd],
    [hw, hh, -hd],
    [-hw, hh, -hd],
    [-hw, -hh, hd],
    [hw, -hh, hd],
    [hw, hh, hd],
    [-hw, hh, hd],
  ];

  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  return pairs.flatMap(([start, end]) => [...corners[start], ...corners[end]]);
}

function createCubeLines(size) {
  return createBoxLines(size, size, size);
}

function translateEdges(edges, offset) {
  const translated = new Array(edges.length);

  for (let index = 0; index < edges.length; index += 3) {
    translated[index] = edges[index] + offset.x;
    translated[index + 1] = edges[index + 1] + offset.y;
    translated[index + 2] = edges[index + 2] + offset.z;
  }

  return translated;
}

function createLineLayer(positions, color, lineWidth, opacity) {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);

  const material = new LineMaterial({
    color,
    linewidth: lineWidth,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    alphaToCoverage: false,
  });

  const lines = new LineSegments2(geometry, material);
  lines.computeLineDistances();
  lines.frustumCulled = false;

  return lines;
}

function createSingleCube() {
  return [...cubeLines, ...cubeLines];
}

function createDoubleCube() {
  // Two same-orientation UPRIGHT cubes stepped along a diagonal so they interlock
  // at a shared waist and read as the Sandscape "S" / figure-8. The cubes keep the
  // reference's 3/4 pose; the stack offset (not a tilt) supplies the S.
  const upperCube = translateEdges(cubeLines, stackOffset);
  const lowerCube = translateEdges(cubeLines, stackOffset.clone().multiplyScalar(-1));

  return [...upperCube, ...lowerCube];
}

function createPurpleHaze() {
  const texture = new THREE.CanvasTexture(createRadialHazeCanvas());
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture,
    color: 0x9a45ff,
    transparent: true,
    opacity: 0.13,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.5, 3.5, 1);

  return sprite;
}

function createRadialHazeCanvas() {
  const hazeCanvas = document.createElement('canvas');
  const size = 256;
  hazeCanvas.width = size;
  hazeCanvas.height = size;

  const context = hazeCanvas.getContext('2d');
  const gradient = context.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
  gradient.addColorStop(0, 'rgba(210, 165, 255, 0.18)');
  gradient.addColorStop(0.24, 'rgba(150, 70, 255, 0.08)');
  gradient.addColorStop(0.58, 'rgba(78, 24, 165, 0.025)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return hazeCanvas;
}

function createDiagonalGrid() {
  const gridCanvas = document.createElement('canvas');
  const size = 256;
  gridCanvas.width = size;
  gridCanvas.height = size;

  const context = gridCanvas.getContext('2d');
  context.clearRect(0, 0, size, size);
  context.strokeStyle = 'rgba(150, 92, 255, 0.85)';
  context.lineWidth = 1;
  context.beginPath();

  const step = 32;
  for (let offset = -size; offset < size * 2; offset += step) {
    context.moveTo(offset, 0);
    context.lineTo(offset + size, size);
    context.moveTo(offset, size);
    context.lineTo(offset + size, 0);
  }
  context.stroke();

  const texture = new THREE.CanvasTexture(gridCanvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);
  texture.colorSpace = THREE.SRGBColorSpace;

  // Radial vignette: the grid only whispers behind the mark and fades to pure
  // black at the corners. Scaled/clamped to the central region of the big plane.
  const fade = new THREE.CanvasTexture(createGridFadeCanvas());
  fade.colorSpace = THREE.SRGBColorSpace;
  fade.wrapS = THREE.ClampToEdgeWrapping;
  fade.wrapT = THREE.ClampToEdgeWrapping;
  fade.repeat.set(4.25, 4.25);
  fade.offset.set(0.382, 0.382);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaMap: fade,
    transparent: true,
    opacity: 0.042,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  return new THREE.Mesh(new THREE.PlaneGeometry(48, 48), material);
}

function createGridFadeCanvas() {
  const fadeCanvas = document.createElement('canvas');
  const size = 256;
  fadeCanvas.width = size;
  fadeCanvas.height = size;

  const context = fadeCanvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, size, size);

  const gradient = context.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.45)');
  gradient.addColorStop(0.5, 'rgba(40, 40, 40, 0.04)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return fadeCanvas;
}

function easeInOutCubic(value) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

// 0 = single cube, 1 = figure-8. Fast, short morphs separated by calm holds.
function getMorph(time) {
  const t = time % loopDuration;

  if (t < calmDuration) {
    return 0;
  }
  if (t < doubleHoldStart) {
    return easeInOutCubic((t - calmDuration) / morphDuration);
  }
  if (t < doubleHoldEnd) {
    return 1;
  }
  return 1 - easeInOutCubic((t - doubleHoldEnd) / morphDuration);
}

// Accumulated spin-surge (integral of the morph's sin bump) from a loop's start
// up to time t-within-loop. Zero during holds, rising across each morph.
function surgeIntegralInLoop(t) {
  if (t <= calmDuration) {
    return 0;
  }
  if (t <= doubleHoldStart) {
    const p = (t - calmDuration) / morphDuration;
    return (morphDuration / Math.PI) * (1 - Math.cos(Math.PI * p));
  }
  if (t <= doubleHoldEnd) {
    return morphInt;
  }
  const p = (t - doubleHoldEnd) / morphDuration;
  return morphInt + (morphDuration / Math.PI) * (1 - Math.cos(Math.PI * p));
}

// The locked, never-stopping spin angle for a given cycle time: a slow baseline
// plus a fast surge through each morph, summing to exactly one turn per loop.
function spinFromClock(time) {
  const loops = Math.floor(time / loopDuration);
  const surge = loops * 2 * morphInt + surgeIntegralInLoop(time - loops * loopDuration);
  return SPIN_BASE_YAW + SLOW_BASE * time + MORPH_SPIN_BONUS * surge;
}

function updateMorph(morphAmount) {
  if (Math.abs(morphAmount - lastMorphAmount) < 0.0001) {
    return;
  }

  lastMorphAmount = morphAmount;

  for (let index = 0; index < linePositions.length; index += 1) {
    linePositions[index] = THREE.MathUtils.lerp(singleTargets[index], doubleTargets[index], morphAmount);
  }

  coreLines.geometry.setPositions(linePositions);
  glowLines.geometry.setPositions(linePositions);
  auraLines.geometry.setPositions(linePositions);

  haze.scale.setScalar(THREE.MathUtils.lerp(3.5, 4.5, morphAmount));
}

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (!dragging) {
    morphClock += dt * SEQUENCE_SPEED;
  }
  const morph = getMorph(morphClock);

  if (!dragging) {
    // Track the locked never-stopping spin: a slow creep through the holds that
    // accelerates into a fast whirl during the morph. Easing toward the nearest
    // wrapped copy keeps the figure-8 hold centered on the "S" and re-settles
    // smoothly after a drag.
    const target = spinFromClock(morphClock);
    const wrapped = target + Math.round((spinAngle - target) / fullTurn) * fullTurn;
    const ease = 1 - Math.exp(-dt / SPIN_TRACK_TAU);
    spinAngle += (wrapped - spinAngle) * ease;
    userPitch += (0 - userPitch) * ease;
  }

  const logoPose = easeInOutCubic(morph);
  const breathing = Math.sin(elapsed * 0.8) * 0.012;

  updateMorph(morph);

  // Outer group: a touch of screen-space lean (the diagonal offset already
  // supplies most of the figure-8 tilt).
  tiltGroup.rotation.z = -0.02 + Math.sin(elapsed * 0.5) * 0.008 + logoPose * DOUBLE_ROLL_OFFSET;
  // Inner rig: pitch down to an isometric look + the morph-driven spin. The
  // DOUBLE_* offsets re-pose only the stacked state (logoPose) into the logo's
  // 3/4 perspective, leaving the single corner-on cube untouched.
  spinRig.rotation.x = THREE.MathUtils.clamp(-0.6 + userPitch + logoPose * 0.05 + logoPose * DOUBLE_PITCH_OFFSET, -1.4, 0.25);
  spinRig.rotation.y = spinAngle + logoPose * DOUBLE_YAW_OFFSET;
  spinRig.scale.setScalar((1 + breathing) * THREE.MathUtils.lerp(1, 0.86, logoPose));

  // Glow is constant for the ENTIRE animation, with only a brief, very subtle
  // lift while it whirls (spin speed peaks for an instant during each morph).
  const spinSpeed = Math.abs(spinAngle - prevSpinAngle) / Math.max(dt, 1e-4);
  prevSpinAngle = spinAngle;
  const spinPulse = THREE.MathUtils.clamp(spinSpeed / 10, 0, 1);
  coreLines.material.opacity = 0.85;
  glowLines.material.opacity = 0.34 + spinPulse * 0.04;
  auraLines.material.opacity = 0.06 + spinPulse * 0.015;
  haze.material.opacity = 0.08 + spinPulse * 0.012;
  grid.material.opacity = 0.045;
  bloomPass.strength = 0.4 + spinPulse * 0.06;

  composer.render();
}

// --- Pointer control ---------------------------------------------------------
function pointerHitsObject(event) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObject(pickSphere).length > 0;
}

canvas.addEventListener('pointerdown', (event) => {
  if (!pointerHitsObject(event)) {
    return;
  }

  dragging = true;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.classList.add('grabbing');

  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (error) {
    /* pointer capture is best-effort */
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) {
    canvas.classList.toggle('grabbable', pointerHitsObject(event));
    return;
  }

  const deltaX = event.clientX - lastPointerX;
  const deltaY = event.clientY - lastPointerY;

  // Inverted on both axes (per user preference).
  spinAngle -= deltaX * DRAG_YAW_SENS;
  userPitch = THREE.MathUtils.clamp(userPitch - deltaY * DRAG_PITCH_SENS, -0.7, 0.7);

  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
});

function endDrag(event) {
  if (!dragging) {
    return;
  }

  dragging = false;
  canvas.classList.remove('grabbing');

  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch (error) {
    /* ignore */
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  const aspect = width / height;
  const frustum = width < 700 ? 28.4 : cameraFrustum;

  camera.left = (-frustum * aspect) / 2;
  camera.right = (frustum * aspect) / 2;
  camera.top = frustum / 2;
  camera.bottom = -frustum / 2;
  camera.updateProjectionMatrix();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  composer.setSize(width, height);
  bloomPass.setSize(width, height);
  coreLines.material.resolution.set(width, height);
  glowLines.material.resolution.set(width, height);
  auraLines.material.resolution.set(width, height);
}

window.addEventListener('resize', resize);
resize();
animate();
