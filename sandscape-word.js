import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * The "Sandscape" wordmark as real extruded 3D text, sitting under the spinning
 * mark. It gently rocks (orbits ±15° around its vertical axis) so the depth of
 * the letters reads without ever drawing focus from the mark. Lives in the mark
 * scene (orthographic) and picks up the shared bloom, so it glows like the mark.
 *
 * The letters are a bright violet with a glossy clearcoat over a small violet
 * environment map, so reflections sweep across them as they turn — that sheen
 * plus an emissive floor keeps the word legible even as purple on near-black.
 */

const FONT_URL =
  'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/fonts/helvetiker_bold.typeface.json';

const WORD = 'Sandscape';
const SIZE = 1.1;
const DEPTH = 0.32;
const TRACKING = 0.14;                            // extra gap between letters (world units)
const WORD_Y = -1.85;                             // tucked up close under the raised mark
const ORBIT_AMPLITUDE = THREE.MathUtils.degToRad(15); // ±15° rocking
const ORBIT_RATE = 0.6;                           // rad/s → ~10.5s per full back-and-forth
const STATIC_PITCH = -0.06;                       // a hair of downward tilt for dimension

// A small violet-tinted reflection probe: a bright sky fading to a dark floor
// with a couple of hotspots. Prefiltered so the clearcoat has something glossy
// to reflect (its highlights slide across the letters as they rock).
function makeReflectiveEnv(renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.0, '#cbaaff'); // bright violet-white "sky"
  grad.addColorStop(0.45, '#5a2ea8');
  grad.addColorStop(1.0, '#080410'); // dark floor
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 128);

  for (const [x, y, r, a] of [[70, 42, 62, 0.9], [190, 28, 46, 0.7]]) {
    const spot = ctx.createRadialGradient(x, y, 0, x, y, r);
    spot.addColorStop(0, `rgba(255, 255, 255, ${a})`);
    spot.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, 256, 128);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  pmrem.dispose();
  return env;
}

// Lay the word out glyph-by-glyph so we can add tracking (TextGeometry has no
// letter-spacing option). Advance by each glyph's natural width + TRACKING.
function buildWordGeometry(font) {
  const scale = SIZE / font.data.resolution;
  const parts = [];
  let cursorX = 0;

  for (const ch of WORD) {
    const geometry = new TextGeometry(ch, {
      font,
      size: SIZE,
      depth: DEPTH,
      curveSegments: 5,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.025,
      bevelSegments: 3,
    });
    geometry.translate(cursorX, 0, 0);
    parts.push(geometry);

    const glyph = font.data.glyphs[ch];
    const advance = (glyph ? glyph.ha : font.data.resolution * 0.5) * scale;
    cursorX += advance + TRACKING;
  }

  const merged = mergeGeometries(parts);
  parts.forEach((geometry) => geometry.dispose());
  merged.center(); // rock around the word's true center
  return merged;
}

export function createSandscapeWord(scene, renderer) {
  // A pivot group so we can rock the word around its own centered axis.
  const group = new THREE.Group();
  group.position.y = WORD_Y;
  group.rotation.x = STATIC_PITCH;
  scene.add(group);

  // Lights rake across the extruded sides. They only affect this (lit) mesh.
  const key = new THREE.DirectionalLight(0xf0e2ff, 2.8);
  key.position.set(-4, 5, 6);
  const rim = new THREE.DirectionalLight(0x8a4dff, 2.3);
  rim.position.set(5, -1, -3);
  const ambient = new THREE.AmbientLight(0x3a2168, 0.9);
  scene.add(key, rim, ambient);

  const material = new THREE.MeshPhysicalMaterial({
    color: 0x8f4dff,        // bright brand violet
    emissive: 0x3a12b0,     // glow floor so the word stays legible on black + feeds bloom
    emissiveIntensity: 0.85,
    metalness: 0.3,
    roughness: 0.32,
    clearcoat: 1.0,         // glossy reflective coat
    clearcoatRoughness: 0.18,
    envMap: makeReflectiveEnv(renderer),
    envMapIntensity: 1.3,
  });

  const loader = new FontLoader();
  loader.load(
    FONT_URL,
    (font) => {
      const mesh = new THREE.Mesh(buildWordGeometry(font), material);
      group.add(mesh);
    },
    undefined,
    (error) => {
      console.warn('Sandscape wordmark: font failed to load', error);
    },
  );

  return {
    /** Subtle looping orbit. Pass monotonic seconds. */
    update(elapsed) {
      group.rotation.y = Math.sin(elapsed * ORBIT_RATE) * ORBIT_AMPLITUDE;
    },
  };
}
