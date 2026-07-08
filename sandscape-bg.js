import * as THREE from 'three';

/*
 * A subtle 3D "sandscape": a violet dune field receding into the dark with a
 * slow wind-drift. It lives in its OWN scene + perspective camera so it can have
 * real depth and a soft horizon, and is rendered BEHIND the neon mark without
 * touching the mark's orthographic framing, bloom, or pointer interaction.
 *
 * The dunes are displaced on the GPU (layered sine "octaves") so the whole field
 * animates for free — nothing is recomputed on the CPU per frame.
 */

const VERT = /* glsl */ `
  uniform float uTime;
  varying float vHeight;
  varying float vDist;

  // Layered sine "dunes" — cheap, smooth, endlessly drifting. p = (x, z).
  float duneHeight(vec2 p) {
    float h = 0.0;
    h += sin(p.x * 0.16 + sin(p.y * 0.06) * 1.7) * 1.35;   // long rolling ridges
    h += sin(p.y * 0.20 - uTime * 0.30) * 0.95;            // crests drift into the distance
    h += sin((p.x * 0.44 + p.y * 0.33) - uTime * 0.12) * 0.38;
    h += sin(p.x * 0.85 - p.y * 0.55 + uTime * 0.18) * 0.18; // fine wind ripples
    return h;
  }

  void main() {
    vec3 pos = position;                 // geometry is pre-rotated into the XZ plane (y ~ 0)
    float h = duneHeight(vec2(pos.x, pos.z));
    pos.y += h;
    vHeight = h;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vec4 view = viewMatrix * world;
    vDist = -view.z;                     // distance from camera, for the fog
    gl_Position = projectionMatrix * view;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uCrest;
  uniform vec3 uFog;
  varying float vHeight;
  varying float vDist;

  void main() {
    // Lift the crests, keep the troughs near-black.
    float crest = smoothstep(0.1, 1.7, vHeight);
    vec3 col = mix(uBase, uCrest, crest);

    // Faint topographic contour lines riding the height field — echoes the
    // wireframe motif of the mark without being busy.
    float band = abs(fract(vHeight * 0.85 + 0.5) - 0.5);
    col += uCrest * smoothstep(0.05, 0.0, band) * 0.22;

    // Distance fog: far dunes melt into the dark so the horizon stays soft.
    float fog = clamp(1.0 - exp(-vDist * 0.056), 0.0, 1.0);
    col = mix(col, uFog, fog);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createSandscapeBackground() {
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x030106);
  scene.background = sky;

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(0, 2.4, 9);
  camera.lookAt(0, 1.15, -28); // graze just above the dunes toward the horizon

  const toLinear = (hex) => new THREE.Color(hex).convertSRGBToLinear();

  const uniforms = {
    uTime: { value: 0 },
    uBase: { value: toLinear(0x100819) },  // deep, barely-there violet in the troughs
    uCrest: { value: toLinear(0x7e39d1) }, // brand violet on the ridges, held back so the mark stays the hero
    uFog: { value: toLinear(0x030106) },   // fade dunes into the sky
  };

  const geometry = new THREE.PlaneGeometry(140, 260, 150, 200);
  geometry.rotateX(-Math.PI / 2); // lay the plane flat; y is now "up" for the dunes

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const dunes = new THREE.Mesh(geometry, material);
  dunes.position.z = -70;         // push the field out ahead of the camera
  dunes.frustumCulled = false;
  scene.add(dunes);

  return {
    scene,
    camera,
    /** Advance the wind-drift. Pass monotonic seconds. */
    update(time) {
      uniforms.uTime.value = time;
    },
    /** Keep the perspective correct on window resize. */
    setAspect(aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
  };
}
