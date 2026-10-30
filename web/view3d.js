import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const HEIGHT_SCALE = 2;
const TRACK_HALF_WIDTH = 7.5;
const TRACK_SAMPLES = 1600;
const KERB_WIDTH = 1.8;
const RUNOFF_WIDTH = 30;
const STREET_RUNOFF = 4;
const STREET_CIRCUITS = /Monaco|Singapore|Azerbaijan|Saudi|Las Vegas|Miami/;
const TERRAIN_SEGMENTS = 260;
const ROAD_CLEARANCE = 6;
const VERGE_WIDTH = 34;
const CURVE_SPAN = 8;
const CORNER_REACH = 42;
const SHARP_BEND = 0.012; // 1 / metres, about an 80 m radius
const ROOM_MAX = 120;
const MIN_ROOM = 13;
const ROOM_STRIDE = 8;
const PIT_LENGTH = 330;
const PIT_LANE_WIDTH = 5.5;
const PIT_LANE_MARGIN = 8; // seconds either side of the stop
const PIT_LANE_MAX_SECONDS = 60;
const WIDE_LAYOUT = 900;
const VIEW_LIFT = 0.13; // raises the action clear of the panels along the bottom
const STAND_LIMIT = 8;
const GRASS_TILE = 64;
const ROAD_SMOOTHING = 16; // metres
const VERGE_SMOOTHING = 28; // samples along the track
const OVERVIEW_TILT = 0.95;
const TV_STATIONS = 22;
const TREES = 1500;
const SPECTATORS = 3200;
const SLOW_FRAME_MS = 30;
const SLOW_FRAME_LIMIT = 45;
const NEAREST_WINDOW = 60;
const WHEEL_RADIUS = 0.36;
const COMPOUND = { SOFT: 0xe8251f, MEDIUM: 0xffd100, HARD: 0xf4f4f4, INTERMEDIATE: 0x2fbf63, WET: 0x2f7fe0, UNKNOWN: 0x888888 };
const CROWD = [0xe8251f, 0xf4f4f4, 0x1d6fe0, 0xffd100, 0xff7a1a, 0x1fb86a, 0x202024, 0xd92f8f];

function seededRandom(seed) {
  let value = seed % 2147483647 || 1;
  return () => {
    value = (value * 16807) % 2147483647;
    return value / 2147483647;
  };
}

function smoothLoop(values, radius = 4) {
  return values.map((_, index) => {
    let total = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      total += values[(index + offset + values.length) % values.length];
    }
    return total / (radius * 2 + 1);
  });
}

// Three box passes approximate a gaussian, so nothing kinks where the window ends.
function gentle(values, radius) {
  return smoothLoop(smoothLoop(smoothLoop(values, radius), radius), radius);
}

function canvasTexture(width, height, paint, repeat = true) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function speckle(context, width, height, count, colors, size, random) {
  for (let index = 0; index < count; index += 1) {
    context.fillStyle = colors[Math.floor(random() * colors.length)];
    context.fillRect(random() * width, random() * height, size * random() + 0.5, size * random() + 0.5);
  }
}

function makeTextures() {
  const random = seededRandom(1234);
  const asphalt = canvasTexture(512, 512, (context, width, height) => {
    context.fillStyle = "#4a4c50";
    context.fillRect(0, 0, width, height);
    speckle(context, width, height, 26000, ["#3b3d41", "#56585c", "#626467", "#2f3134"], 2.2, random);
    context.fillStyle = "rgba(20,20,22,.2)";
    for (const y of [120, 196, 316, 392]) context.fillRect(0, y, width, 26);
  });
  const grass = canvasTexture(512, 512, (context, width, height) => {
    context.fillStyle = "#559c45";
    context.fillRect(0, 0, width, height);
    speckle(context, width, height, 26000, ["#4d9340", "#5fa84d", "#488a3b", "#68b055"], 2.5, random);
  });
  const gravel = canvasTexture(256, 256, (context, width, height) => {
    context.fillStyle = "#cdb98f";
    context.fillRect(0, 0, width, height);
    speckle(context, width, height, 14000, ["#b9a47a", "#dccba5", "#a8936a"], 2.4, random);
  });
  const banner = canvasTexture(2048, 128, (context, width, height) => {
    const fields = ["#e8251f", "#f4f4f4", "#14161a", "#ffd100", "#1d6fe0", "#14161a"];
    const inks = ["#ffffff", "#14161a", "#ffffff", "#14161a", "#ffffff", "#ffd100"];
    const words = ["LIGHTS OUT", "OPENF1", "BOX BOX", "UNDERCUT", "SECTOR 3", "DRS"];
    const step = width / fields.length;
    context.font = "800 62px Saira, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    fields.forEach((field, index) => {
      context.fillStyle = field;
      context.fillRect(index * step, 0, step, height);
      context.fillStyle = inks[index];
      context.fillText(words[index], index * step + step / 2, height / 2 + 4);
    });
  });
  return { asphalt, grass, gravel, banner };
}

function ribbon(samples, left, right, { colorOf, uvLength = 1, uvWidth = 1, include = () => true } = {}) {
  const positions = [];
  const colors = [];
  const uvs = [];
  const color = new THREE.Color();
  let travelled = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const next = (index + 1) % samples.length;
    const step = samples[index].distanceTo(samples[next]);
    if (include(index)) {
      const corners = [left(index), right(index), left(next), left(next), right(index), right(next)];
      const us = [travelled, travelled, travelled + step, travelled + step, travelled, travelled + step];
      const vs = [0, 1, 0, 0, 1, 1];
      if (colorOf) color.set(colorOf(index));
      corners.forEach((corner, cornerIndex) => {
        positions.push(corner.x, corner.y, corner.z);
        uvs.push(us[cornerIndex] / uvLength, vs[cornerIndex] * uvWidth);
        if (colorOf) colors.push(color.r, color.g, color.b);
      });
    }
    travelled += step;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (colorOf) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Builds a smooth skin through rounded cross sections placed along the length of the car.
function loft(sections, ring = 18, power = 3.2) {
  const positions = [];
  const indices = [];
  sections.forEach(({ z, width, height, y, x = 0 }) => {
    for (let index = 0; index < ring; index += 1) {
      const angle = (index / ring) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        x + (width / 2) * Math.sign(cos) * Math.abs(cos) ** (2 / power),
        y + (height / 2) * Math.sign(sin) * Math.abs(sin) ** (2 / power),
        z,
      );
    }
  });
  for (let section = 0; section < sections.length - 1; section += 1) {
    for (let index = 0; index < ring; index += 1) {
      const a = section * ring + index;
      const b = section * ring + ((index + 1) % ring);
      const c = a + ring;
      const d = b + ring;
      indices.push(a, c, b, b, c, d);
    }
  }
  for (const [section, flip] of [[0, false], [sections.length - 1, true]]) {
    for (let index = 1; index < ring - 1; index += 1) {
      const base = section * ring;
      if (flip) indices.push(base, base + index + 1, base + index);
      else indices.push(base, base + index, base + index + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function plate(width, height, length, x, y, z, rotateX = 0) {
  const geometry = new THREE.BoxGeometry(width, height, length);
  if (rotateX) geometry.rotateX(rotateX);
  geometry.translate(x, y, z);
  return geometry;
}

function strut(from, to, radius = 0.018) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const geometry = new THREE.CylinderGeometry(radius, radius, start.distanceTo(end), 6);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize()));
  const middle = start.add(end).multiplyScalar(0.5);
  geometry.translate(middle.x, middle.y, middle.z);
  return geometry;
}

// One shared set of geometry for all cars, proportioned from a current F1 car (5.5 m by 2 m).
function carParts() {
  const body = loft([
    { z: 2.72, width: 0.2, height: 0.08, y: 0.2 },
    { z: 2.42, width: 0.27, height: 0.14, y: 0.23 },
    { z: 1.85, width: 0.3, height: 0.22, y: 0.32 },
    { z: 1.3, width: 0.38, height: 0.3, y: 0.42 },
    { z: 0.85, width: 0.56, height: 0.38, y: 0.46 },
    { z: 0.3, width: 0.7, height: 0.44, y: 0.45 },
    { z: -0.3, width: 0.72, height: 0.56, y: 0.48 },
    { z: -0.75, width: 0.56, height: 0.78, y: 0.56 },
    { z: -1.25, width: 0.42, height: 0.66, y: 0.5 },
    { z: -1.85, width: 0.28, height: 0.42, y: 0.4 },
    { z: -2.3, width: 0.16, height: 0.22, y: 0.32 },
  ]);
  const pod = (side) => loft([
    { z: 0.42, width: 0.1, height: 0.2, y: 0.32, x: side * 0.5 },
    { z: 0.2, width: 0.42, height: 0.34, y: 0.34, x: side * 0.56 },
    { z: -0.35, width: 0.44, height: 0.36, y: 0.35, x: side * 0.58 },
    { z: -1.0, width: 0.34, height: 0.28, y: 0.32, x: side * 0.5 },
    { z: -1.65, width: 0.16, height: 0.16, y: 0.26, x: side * 0.34 },
  ], 14, 2.6);
  const floor = loft([
    { z: 1.05, width: 0.5, height: 0.04, y: 0.08 },
    { z: 0.55, width: 1.45, height: 0.05, y: 0.09 },
    { z: -1.0, width: 1.6, height: 0.05, y: 0.09 },
    { z: -1.75, width: 1.3, height: 0.05, y: 0.11 },
  ], 12, 6);

  const halo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.3, 0.68, -0.25),
    new THREE.Vector3(-0.26, 0.8, 0.3),
    new THREE.Vector3(0, 0.84, 0.56),
    new THREE.Vector3(0.26, 0.8, 0.3),
    new THREE.Vector3(0.3, 0.68, -0.25),
  ]), 24, 0.03, 8);

  const paint = [body, pod(-1), pod(1)];
  const carbon = [
    floor,
    halo,
    strut([0, 0.6, 0.58], [0, 0.84, 0.56], 0.03),
    plate(1.95, 0.025, 0.24, 0, 0.13, 2.62),
    plate(1.55, 0.02, 0.2, 0, 0.21, 2.44, -0.35),
    plate(1.45, 0.02, 0.16, 0, 0.3, 2.28, -0.6),
    plate(0.03, 0.34, 0.62, -0.98, 0.25, 2.52),
    plate(0.03, 0.34, 0.62, 0.98, 0.25, 2.52),
    plate(1.04, 0.025, 0.36, 0, 0.98, -2.42, 0.18),
    plate(1.0, 0.02, 0.16, 0, 1.08, -2.62, 0.5),
    plate(0.9, 0.02, 0.2, 0, 0.5, -2.46, 0.2),
    plate(0.03, 0.82, 0.86, -0.54, 0.72, -2.4),
    plate(0.03, 0.82, 0.86, 0.54, 0.72, -2.4),
    plate(0.04, 0.5, 0.14, -0.12, 0.74, -2.34),
    plate(0.04, 0.5, 0.14, 0.12, 0.74, -2.34),
    plate(0.16, 0.08, 0.14, 0, 0.98, -0.42),
  ];
  for (const side of [-1, 1]) {
    carbon.push(
      strut([side * 0.3, 0.46, 1.5], [side * 0.8, 0.36, 1.7]),
      strut([side * 0.2, 0.3, 1.25], [side * 0.8, 0.26, 1.72]),
      strut([side * 0.2, 0.3, 2.0], [side * 0.8, 0.26, 1.72]),
      strut([side * 0.26, 0.42, -1.7], [side * 0.7, 0.38, -1.8]),
      strut([side * 0.22, 0.24, -1.45], [side * 0.7, 0.26, -1.82]),
      strut([side * 0.2, 0.24, -2.1], [side * 0.7, 0.26, -1.82]),
    );
  }

  const tyre = (width) => {
    const geometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, width, 28, 1);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  };
  const hub = new THREE.CylinderGeometry(0.215, 0.215, 0.44, 18);
  hub.rotateZ(Math.PI / 2);
  const band = new THREE.TorusGeometry(0.28, 0.012, 8, 32);
  band.rotateY(Math.PI / 2);
  return {
    paint, carbon, hub, band,
    tyres: { front: tyre(0.32), rear: tyre(0.42) },
    wheels: [
      { x: -0.82, z: 1.72, front: true, side: -1 }, { x: 0.82, z: 1.72, front: true, side: 1 },
      { x: -0.78, z: -1.8, front: false, side: -1 }, { x: 0.78, z: -1.8, front: false, side: 1 },
    ],
    helmet: new THREE.SphereGeometry(0.125, 18, 14),
    light: new THREE.BoxGeometry(0.1, 0.1, 0.03),
  };
}

function labelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  context.fillStyle = "#0d0e12";
  context.fillRect(8, 8, 144, 48);
  context.font = "800 36px Saira, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.fillText(text, 80, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, transparent: true }));
  sprite.scale.set(0.05, 0.02, 1);
  sprite.renderOrder = 3;
  return sprite;
}

function dotSprite(color) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(32, 32, 26, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 7;
  context.strokeStyle = "#ffffff";
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false, transparent: true }));
  sprite.scale.set(0.024, 0.024, 1);
  sprite.renderOrder = 2;
  return sprite;
}

export function createView3D(canvas, { carAt, isOut, positionAt, tyreAt, focus }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  let pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.3, 60000);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.enableDamping = false;
  controls.addEventListener("change", () => { if (mode === "overview") draw(); });
  controls.addEventListener("start", () => { cameraMoved = true; });

  const sunDirection = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(215));
  const sky = new Sky();
  sky.scale.setScalar(45000);
  sky.material.toneMapped = false;
  Object.assign(sky.material.uniforms.turbidity, { value: 2.2 });
  Object.assign(sky.material.uniforms.rayleigh, { value: 1.4 });
  Object.assign(sky.material.uniforms.mieCoefficient, { value: 0.0012 });
  Object.assign(sky.material.uniforms.mieDirectionalG, { value: 0.7 });
  sky.material.uniforms.sunPosition.value.copy(sunDirection);
  scene.add(sky);

  const envScene = new THREE.Scene();
  const envSky = sky.clone();
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.14;
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.04;
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 900 });
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xdce9f7, 0x6d7f5c, 1.5));

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.4, 30);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const textures = makeTextures();
  const parts = carParts();
  const carbon = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.42, metalness: 0.35 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.88 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.28, metalness: 0.9 });
  const compoundBands = Object.fromEntries(Object.entries(COMPOUND).map(([name, color]) => [
    name, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
  ]));
  const world = new THREE.Group();
  scene.add(world);

  let race = null;
  let built = null;
  let mode = "overview";
  let station = -1;
  let lastDraw = 0;
  let lastT = 0;
  let cameraMoved = false;
  let cameraHeading = 0;
  let slowFrames = 0;
  let useBloom = true;

  function draw() {
    if (useBloom) composer.render();
    else renderer.render(scene, camera);
  }

  function clearWorld() {
    world.traverse((object) => {
      if (!object.userData.owned) return;
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material?.map && !Object.values(textures).includes(material.map)) material.map.dispose();
        material?.dispose();
      });
    });
    world.clear();
    built?.paints.forEach((material) => material.dispose());
    built = null;
  }

  function owned(mesh, parent = world) {
    mesh.userData.owned = true;
    parent.add(mesh);
    return mesh;
  }

  function buildRoute() {
    const { x, y, z } = race.track;
    const cx = (Math.min(...x) + Math.max(...x)) / 2;
    const cy = (Math.min(...y) + Math.max(...y)) / 2;
    const lowest = Math.min(...z);
    const curve = new THREE.CatmullRomCurve3(x.map((px, index) => new THREE.Vector3(
      px - cx,
      (z[index] - lowest) * HEIGHT_SCALE,
      -(y[index] - cy),
    )), true, "centripetal");
    curve.arcLengthDivisions = TRACK_SAMPLES * 2;
    const samples = curve.getSpacedPoints(TRACK_SAMPLES).slice(0, -1);
    const count = samples.length;
    const step = curve.getLength() / count;
    // Stored heights are rounded, which would show as ripples in the road once they are scaled up.
    const road = gentle(samples.map((point) => point.y), Math.max(Math.round(ROAD_SMOOTHING / step), 1));
    samples.forEach((point, index) => { point.y = road[index]; });
    const sides = samples.map((_, index) => {
      const ahead = samples[(index + 6) % count].clone().sub(samples[(index - 6 + count) % count]);
      return new THREE.Vector3(ahead.z, 0, -ahead.x).normalize();
    });

    // Positive bend means the road curves towards the +side direction.
    const bend = samples.map((point, index) => {
      const out = samples[(index + CURVE_SPAN) % count].clone().sub(point).setY(0).normalize();
      const into = point.clone().sub(samples[(index - CURVE_SPAN + count) % count]).setY(0).normalize();
      return out.sub(into).dot(sides[index]) / (CURVE_SPAN * step);
    });
    const corner = Float32Array.from(samples, (_, index) => {
      let peak = 0;
      for (let offset = -CORNER_REACH; offset <= CORNER_REACH; offset += 3) {
        const value = Math.abs(bend[(index + offset + count) % count]);
        peak = Math.max(peak, Math.min(value / SHARP_BEND, 1) * (1 - Math.abs(offset) / (CORNER_REACH + 1)));
      }
      return peak;
    });

    let span = 0;
    for (const point of samples) span = Math.max(span, Math.abs(point.x), Math.abs(point.z));
    const anchors = samples.map((point, index) => ({ point, index })).filter(({ index }) => index % 6 === 0);

    // How far the land runs on each side before it meets another part of the circuit.
    const room = [-1, 1].map((direction) => {
      const rough = [];
      for (let index = 0; index < count; index += ROOM_STRIDE) {
        const point = samples[index];
        const side = sides[index];
        const curling = Math.sign(bend[index]) === direction ? 0.8 / Math.max(Math.abs(bend[index]), 1e-4) : Infinity;
        let free = Math.min(ROOM_MAX, curling);
        for (let distance = 14; distance < free; distance += 6) {
          const x2 = point.x + side.x * distance;
          const z2 = point.z + side.z * distance;
          const blocked = anchors.some((anchor) => {
            const apart = Math.abs(anchor.index - index);
            if (Math.min(apart, count - apart) < 40) return false;
            return (anchor.point.x - x2) ** 2 + (anchor.point.z - z2) ** 2 < distance * distance * 0.8;
          });
          if (blocked) {
            free = distance;
            break;
          }
        }
        rough.push(free);
      }
      return Array.from({ length: count }, (_, index) => {
        const slot = index / ROOM_STRIDE;
        const low = Math.floor(slot) % rough.length;
        const high = (low + 1) % rough.length;
        return Math.max(Math.min(rough[low], rough[high]), MIN_ROOM);
      });
    });
    const spare = room.map((values) => smoothLoop(values.map((_, index) => {
      let tightest = Infinity;
      for (let offset = -14; offset <= 14; offset += 2) tightest = Math.min(tightest, values[(index + offset + count) % count]);
      return tightest;
    }), 14));

    const route = { cx, cy, samples, sides, span, bend, corner, room: spare, step };
    route.coarse = samples.filter((_, index) => index % 5 === 0);
    route.edge = TRACK_HALF_WIDTH + KERB_WIDTH;
    route.gravelOf = (direction, index) => {
      const outside = Math.sign(bend[index]) !== direction;
      const free = Math.max(spare[direction < 0 ? 0 : 1][index] - route.edge - 8, 0);
      const width = STREET_CIRCUITS.test(race.meta.name) ? STREET_RUNOFF : RUNOFF_WIDTH;
      return outside ? Math.min(width * corner[index], free) : 0;
    };
    const gravel = [-1, 1].map((direction) => smoothLoop(samples.map((_, index) => route.gravelOf(direction, index)), 18));
    route.gravel = (direction, index) => gravel[direction < 0 ? 0 : 1][index];
    route.barrier = (direction, index) => Math.min(
      route.edge + 3.5 + route.gravel(direction, index),
      Math.max(spare[direction < 0 ? 0 : 1][index] - 4, route.edge + 1.5),
    );
    route.verge = (direction, index) => Math.min(route.barrier(direction, index) + VERGE_WIDTH, spare[direction < 0 ? 0 : 1][index]);
    return route;
  }

  function offsetOf(route, index, distance, lift = 0) {
    const point = route.samples[index];
    return point.clone().addScaledVector(route.sides[index], distance).setY(point.y + lift);
  }

  // Finds the side and section of track where cars actually leave for the pit lane.
  function findPitLane(route) {
    const spots = [];
    for (const driver of race.drivers) {
      for (const stop of driver.pits) {
        const state = carAt(driver, stop.t + 10);
        const x = state.x - route.cx;
        const z = -(state.y - route.cy);
        let best = 0;
        let bestDistance = Infinity;
        route.samples.forEach((point, index) => {
          const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        });
        const away = new THREE.Vector3(x - route.samples[best].x, 0, z - route.samples[best].z);
        spots.push({ index: best, side: away.dot(route.sides[best]) });
      }
    }
    if (!spots.length) return { index: 0, side: 1, length: 90 };
    const count = route.samples.length;
    const shifted = spots.map(({ index }) => (index + count / 2) % count).sort((a, b) => a - b);
    const index = Math.round(shifted[Math.floor(shifted.length / 2)] - count / 2 + count) % count;
    const side = spots.reduce((total, spot) => total + Math.sign(spot.side), 0) >= 0 ? 1 : -1;
    return { index, side, length: Math.round(PIT_LENGTH / route.step) };
  }

  function nearPits(route, index) {
    const count = route.samples.length;
    const apart = Math.abs(index - route.pit.index);
    return Math.min(apart, count - apart) < route.pit.length;
  }

  // The height of the grass strip beside the road, which eases from road level down to the land.
  function vergeAt(route, direction, index, distance) {
    const road = route.samples[index];
    const reach = route.verge(direction, index);
    const land = route.bank[direction < 0 ? 0 : 1][index];
    const blend = THREE.MathUtils.smoothstep(distance, route.edge - 1, reach);
    const point = road.clone().addScaledVector(route.sides[index], direction * distance);
    point.y = road.y + (land - road.y) * blend - 0.05;
    return point;
  }

  function buildTerrain(route) {
    const size = route.span * 3.8;
    const geometry = new THREE.PlaneGeometry(size, size, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    const anchors = route.samples.filter((_, index) => index % 12 === 0);
    const nearestRoad = (x, z) => {
      let weight = 0;
      let total = 0;
      let nearest = Infinity;
      let height = 0;
      for (const point of anchors) {
        const distance = (point.x - x) ** 2 + (point.z - z) ** 2 + 400;
        if (distance < nearest) {
          nearest = distance;
          height = point.y;
        }
        const influence = 1 / (distance * distance);
        weight += influence;
        total += point.y * influence;
      }
      return { reach: Math.sqrt(nearest), height, far: total / weight };
    };
    const landFrom = ({ reach, height, far }) => {
      const blend = Math.min(reach / 170, 1);
      return height * (1 - blend) + far * blend;
    };
    route.landAt = (x, z) => landFrom(nearestRoad(x, z));
    // Under the verges the land is lowered, so it can never show through or bury the road.
    route.groundAt = (x, z) => {
      const near = nearestRoad(x, z);
      const lowered = Math.min(Math.max((VERGE_WIDTH + 34 - near.reach) / 22, 0), 1);
      return landFrom(near) - lowered * ROAD_CLEARANCE;
    };
    const positions = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index);
      const z = positions.getZ(index);
      positions.setY(index, route.groundAt(x, z));
      uvs.setXY(index, x / GRASS_TILE, z / GRASS_TILE);
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ map: textures.grass, roughness: 0.96 });
    owned(new THREE.Mesh(geometry, material)).receiveShadow = true;

    let lowest = Infinity;
    for (let index = 0; index < positions.count; index += 1) lowest = Math.min(lowest, positions.getY(index));
    const horizonGeometry = new THREE.CircleGeometry(route.span * 16, 64);
    const horizon = owned(new THREE.Mesh(horizonGeometry, new THREE.MeshStandardMaterial({ color: 0x4c8f3f, roughness: 1 })));
    horizon.rotation.x = -Math.PI / 2;
    horizon.position.y = lowest - 3;
  }

  function worldGrassUv(geometry) {
    const positions = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    for (let index = 0; index < positions.count; index += 1) {
      uvs.setXY(index, positions.getX(index) / GRASS_TILE, positions.getZ(index) / GRASS_TILE);
    }
    return geometry;
  }

  // Land height at the outer edge of each verge, smoothed along the lap so the banks flow with the road.
  function measureBanks(route) {
    route.bank = [-1, 1].map((direction) => gentle(route.samples.map((road, index) => {
      const reach = route.verge(direction, index);
      return route.landAt(road.x + route.sides[index].x * direction * reach, road.z + route.sides[index].z * direction * reach);
    }), VERGE_SMOOTHING));
  }

  function buildSurfaces(route) {
    measureBanks(route);
    const { samples, corner } = route;
    const side = (distance, lift) => (index) => offsetOf(route, index, distance, lift);

    const asphalt = textures.asphalt.clone();
    asphalt.needsUpdate = true;
    const surfaceMaterial = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide });
    const surface = owned(new THREE.Mesh(ribbon(samples, side(-TRACK_HALF_WIDTH, 0.12), side(TRACK_HALF_WIDTH, 0.12), { uvLength: 34 }), surfaceMaterial));
    surface.receiveShadow = true;

    const lines = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
    const edgeColor = (index) => {
      if (corner[index] < 0.45) return 0xf4f4f4;
      return Math.floor(index / 2) % 2 ? 0xe8251f : 0xf8f8f8;
    };
    const grassMaterial = new THREE.MeshStandardMaterial({ map: textures.grass, roughness: 0.96, side: THREE.DoubleSide });
    const street = STREET_CIRCUITS.test(race.meta.name);
    const gravelMaterial = new THREE.MeshStandardMaterial({
      map: street ? asphalt : textures.gravel, color: street ? 0xb9bcc2 : 0xffffff, roughness: 1, side: THREE.DoubleSide,
    });

    for (const direction of [-1, 1]) {
      owned(new THREE.Mesh(ribbon(samples,
        side(direction * TRACK_HALF_WIDTH, 0.16),
        side(direction * route.edge, 0.16),
        { colorOf: edgeColor }), lines)).receiveShadow = true;

      owned(new THREE.Mesh(worldGrassUv(ribbon(samples,
        (index) => vergeAt(route, direction, index, route.edge),
        (index) => vergeAt(route, direction, index, route.verge(direction, index)))), grassMaterial)).receiveShadow = true;

      owned(new THREE.Mesh(worldGrassUv(ribbon(samples,
        (index) => vergeAt(route, direction, index, route.verge(direction, index)),
        (index) => vergeAt(route, direction, index, route.verge(direction, index)).setY(route.groundAt(
          samples[index].x + route.sides[index].x * direction * route.verge(direction, index),
          samples[index].z + route.sides[index].z * direction * route.verge(direction, index),
        ) - 2))), grassMaterial));

      const hasGravel = (index) => route.gravel(direction, index) > 1.5 && route.gravel(direction, (index + 1) % samples.length) > 1.5;
      const gravel = owned(new THREE.Mesh(ribbon(samples,
        (index) => vergeAt(route, direction, index, route.edge).setY(vergeAt(route, direction, index, route.edge).y + 0.07),
        (index) => {
          const distance = route.edge + route.gravel(direction, index);
          const point = vergeAt(route, direction, index, distance);
          return point.setY(point.y + 0.07);
        }, { uvLength: 18, include: hasGravel }), gravelMaterial));
      gravel.receiveShadow = true;

      const banner = new THREE.MeshStandardMaterial({ map: textures.banner, roughness: 0.65, side: THREE.DoubleSide });
      const barrier = owned(new THREE.Mesh(ribbon(samples,
        (index) => {
          const point = vergeAt(route, direction, index, route.barrier(direction, index));
          return point.setY(point.y - 0.3);
        },
        (index) => {
          const point = vergeAt(route, direction, index, route.barrier(direction, index));
          return point.setY(point.y + 1.3);
        },
        { uvLength: direction * 150, include: (index) => direction !== route.pit.side || !nearPits(route, index) }), banner));
      barrier.castShadow = true;
    }

    const line = new THREE.Mesh(new THREE.BoxGeometry(TRACK_HALF_WIDTH * 2, 0.04, 1.4), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    const start = samples[0];
    line.position.set(start.x, start.y + 0.17, start.z);
    line.rotation.y = Math.atan2(route.sides[0].x, route.sides[0].z) - Math.PI / 2;
    owned(line);
    return surface;
  }

  // Traces the pit lane from the path a car really took through a stop.
  function buildPitLane(route) {
    const stops = race.drivers.flatMap((driver) => driver.pits.map((stop) => ({ driver, stop })))
      .filter(({ stop }) => stop.lane && stop.lane < PIT_LANE_MAX_SECONDS)
      .sort((a, b) => a.stop.lane - b.stop.lane);
    const chosen = stops[Math.floor(stops.length / 2)];
    if (!chosen) return;
    const { driver, stop } = chosen;
    const points = [];
    for (let t = stop.t - PIT_LANE_MARGIN; t <= stop.t + stop.lane + PIT_LANE_MARGIN; t += 0.5) {
      const state = carAt(driver, t);
      const x = state.x - route.cx;
      const z = -(state.y - route.cy);
      const nearest = route.coarse.reduce((best, point) => {
        const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
        return distance < best.distance ? { distance, y: point.y } : best;
      }, { distance: Infinity, y: 0 });
      const point = new THREE.Vector3(x, nearest.y + 0.1, z);
      if (!points.length || points[points.length - 1].distanceTo(point) > 1) points.push(point);
    }
    if (points.length < 12) return;
    const lane = new THREE.CatmullRomCurve3(points, false, "centripetal").getSpacedPoints(Math.round(points.length * 1.5));
    const sides = lane.map((_, index) => {
      const ahead = lane[Math.min(index + 2, lane.length - 1)].clone().sub(lane[Math.max(index - 2, 0)]);
      return new THREE.Vector3(ahead.z, 0, -ahead.x).normalize();
    });
    const edge = (distance) => (index) => lane[index].clone().addScaledVector(sides[index], distance);
    const material = new THREE.MeshStandardMaterial({ map: textures.asphalt, roughness: 0.85, side: THREE.DoubleSide });
    const surface = owned(new THREE.Mesh(ribbon(lane, edge(-PIT_LANE_WIDTH), edge(PIT_LANE_WIDTH), {
      uvLength: 34, include: (index) => index < lane.length - 1,
    }), material));
    surface.receiveShadow = true;
  }

  // A footprint only counts as clear if every corner of it stands well away from the road.
  function fits(route, index, direction, offset, length, depth) {
    const point = route.samples[index];
    const side = route.sides[index];
    const along = new THREE.Vector3(-side.z, 0, side.x);
    for (let across = -length / 2; across <= length / 2; across += 18) {
      for (let back = 0; back <= depth; back += 9) {
        const x = point.x + side.x * direction * (offset + back) + along.x * across;
        const z = point.z + side.z * direction * (offset + back) + along.z * across;
        const blocked = route.coarse.some((sample) => (sample.x - x) ** 2 + (sample.z - z) ** 2 < (route.edge + 7) ** 2);
        if (blocked) return false;
      }
    }
    return true;
  }

  function buildGrandstand(route, index, direction, offset, length, stand, seats, random) {
    const side = route.sides[index].clone().multiplyScalar(direction);
    const point = route.samples[index].clone().addScaledVector(side, offset);
    const base = route.groundAt(point.x, point.z);
    const group = new THREE.Group();
    group.position.set(point.x, base, point.z);
    group.rotation.y = Math.atan2(side.x, side.z);
    world.add(group);
    group.updateMatrix();
    const rows = 9;
    const riser = 1.4;
    for (let row = 0; row < rows; row += 1) {
      const height = (row + 1) * riser + 6;
      const tier = owned(new THREE.Mesh(new THREE.BoxGeometry(length, height, 1.8), stand), group);
      tier.position.set(0, height / 2 - 1, row * 1.8);
      tier.castShadow = true;
    }
    const top = rows * riser + 12;
    const roof = owned(new THREE.Mesh(new THREE.BoxGeometry(length + 3, 0.5, rows * 1.8 + 7), stand), group);
    roof.position.set(0, top, rows * 0.9 + 1);
    roof.rotation.x = 0.08;
    roof.castShadow = true;
    const postStep = length / Math.max(Math.round(length / 26), 1);
    for (let post = -length / 2; post <= length / 2 + 0.1; post += postStep) {
      const column = owned(new THREE.Mesh(new THREE.BoxGeometry(0.5, top, 0.5), stand), group);
      column.position.set(post, top / 2, rows * 1.8);
    }
    const color = new THREE.Color();
    const dummy = new THREE.Object3D();
    for (let row = 0; row < rows; row += 1) {
      for (let across = 0; across < length / 1.1 && seats.used < SPECTATORS; across += 1) {
        if (random() < 0.08) continue;
        dummy.position.set(-length / 2 + across * 1.1, (row + 1) * riser + 5.5, row * 1.8 - 0.3);
        dummy.updateMatrix();
        dummy.matrix.premultiply(group.matrix);
        seats.mesh.setMatrixAt(seats.used, dummy.matrix);
        seats.mesh.setColorAt(seats.used, color.set(CROWD[Math.floor(random() * CROWD.length)]));
        seats.used += 1;
      }
    }
  }

  function buildGrandstands(route) {
    const random = seededRandom(route.samples.length + Math.round(route.span));
    const stand = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.7 });
    const seats = {
      used: 0,
      mesh: owned(new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 1.05, 0.5), new THREE.MeshStandardMaterial({ roughness: 0.75 }), SPECTATORS)),
    };
    seats.mesh.frustumCulled = false;
    const count = route.samples.length;
    const order = route.bend.map((value, index) => ({ value: Math.abs(value), index })).sort((a, b) => b.value - a.value);
    const spots = [{ index: route.pit.index, direction: -route.pit.side, length: 170 }];
    for (const { index } of order) {
      if (spots.length >= STAND_LIMIT) break;
      const tooClose = spots.some((spot) => Math.min(Math.abs(spot.index - index), count - Math.abs(spot.index - index)) < 110);
      if (!tooClose) spots.push({ index, direction: Math.sign(route.bend[index]) === 1 ? -1 : 1, length: 90 });
    }
    for (const { index, direction, length } of spots) {
      const offset = route.verge(direction, index) + 6;
      if (fits(route, index, direction, offset, length, 22)) {
        buildGrandstand(route, index, direction, offset, length, stand, seats, random);
      }
    }
    seats.mesh.count = seats.used;
    seats.mesh.instanceMatrix.needsUpdate = true;
    if (seats.mesh.instanceColor) seats.mesh.instanceColor.needsUpdate = true;
  }

  function buildPitBuilding(route) {
    const { index, side: direction } = route.pit;
    const offset = route.edge + 30;
    if (!fits(route, index, direction, offset, 240, 18)) return;
    const side = route.sides[index].clone().multiplyScalar(direction);
    const point = route.samples[index].clone().addScaledVector(side, offset + 9);
    const group = new THREE.Group();
    group.position.set(point.x, route.groundAt(point.x, point.z), point.z);
    group.rotation.y = Math.atan2(side.x, side.z);
    world.add(group);
    const glass = new THREE.MeshStandardMaterial({ color: 0x83a5c4, roughness: 0.12, metalness: 0.75 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf1f2f4, roughness: 0.55 });
    const lower = owned(new THREE.Mesh(new THREE.BoxGeometry(240, 10, 18), white), group);
    lower.position.y = 3;
    lower.castShadow = true;
    const upper = owned(new THREE.Mesh(new THREE.BoxGeometry(240, 6, 15), glass), group);
    upper.position.y = 11;
    upper.castShadow = true;
    const cap = owned(new THREE.Mesh(new THREE.BoxGeometry(246, 0.8, 19), white), group);
    cap.position.y = 14.3;
  }

  function buildTrees(route) {
    const random = seededRandom(Math.round(route.span) * 7 + 3);
    const crown = new THREE.IcosahedronGeometry(7, 1);
    crown.scale(1, 1.35, 1);
    crown.translate(0, 13, 0);
    const trunk = new THREE.CylinderGeometry(0.7, 1, 8, 6);
    trunk.translate(0, 4, 0);
    const crowns = owned(new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), TREES));
    const trunks = owned(new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 }), TREES));
    crowns.castShadow = true;
    const spot = new THREE.Object3D();
    const color = new THREE.Color();
    const anchors = route.coarse;
    let planted = 0;
    for (let attempt = 0; attempt < TREES * 8 && planted < TREES; attempt += 1) {
      const x = (random() - 0.5) * route.span * 4.1;
      const z = (random() - 0.5) * route.span * 4.1;
      if (Math.sin(x / 190) + Math.cos(z / 160) < -0.2) continue;
      if (anchors.some((point) => (point.x - x) ** 2 + (point.z - z) ** 2 < 10000)) continue;
      spot.position.set(x, route.groundAt(x, z) - 0.5, z);
      spot.rotation.y = random() * 6;
      spot.scale.setScalar(0.75 + random() * 0.9);
      spot.updateMatrix();
      crowns.setMatrixAt(planted, spot.matrix);
      trunks.setMatrixAt(planted, spot.matrix);
      crowns.setColorAt(planted, color.setHSL(0.26 + random() * 0.08, 0.48, 0.24 + random() * 0.12));
      planted += 1;
    }
    crowns.count = trunks.count = planted;
  }

  function buildGantry(route) {
    const group = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.4, metalness: 0.5 });
    const width = (TRACK_HALF_WIDTH + 4) * 2;
    const add = (geometry, x, y) => {
      const mesh = owned(new THREE.Mesh(geometry, steel), group);
      mesh.position.set(x, y, 0);
      mesh.castShadow = true;
    };
    add(new THREE.BoxGeometry(width, 2.6, 1.1), 0, 8.5);
    add(new THREE.BoxGeometry(0.9, 9, 0.9), -width / 2, 4.5);
    add(new THREE.BoxGeometry(0.9, 9, 0.9), width / 2, 4.5);
    const lampGeometry = new THREE.SphereGeometry(0.8, 18, 14);
    const lamps = [-2, -1, 0, 1, 2].map((slot) => {
      const lamp = owned(new THREE.Mesh(lampGeometry, new THREE.MeshStandardMaterial({ color: 0x2a0806, emissive: 0xff1208, emissiveIntensity: 0 })), group);
      lamp.position.set(slot * 2.6, 8.5, 0.7);
      return lamp;
    });
    const point = route.samples[0];
    const side = route.sides[0];
    group.position.copy(point);
    group.rotation.y = Math.atan2(-side.z, side.x);
    world.add(group);
    return lamps;
  }

  function buildCars() {
    const paints = new Map();
    const cars = race.drivers.map((driver) => {
      if (!paints.has(driver.color)) {
        paints.set(driver.color, new THREE.MeshPhysicalMaterial({
          color: driver.color, roughness: 0.42, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2,
        }));
      }
      const paint = paints.get(driver.color);
      const group = new THREE.Group();
      const body = new THREE.Group();
      group.add(body);
      for (const geometry of parts.paint) {
        const mesh = new THREE.Mesh(geometry, paint);
        mesh.castShadow = true;
        body.add(mesh);
      }
      for (const geometry of parts.carbon) {
        const mesh = new THREE.Mesh(geometry, carbon);
        mesh.castShadow = true;
        body.add(mesh);
      }
      const helmet = new THREE.Mesh(parts.helmet, paint);
      helmet.position.set(0, 0.74, 0.12);
      body.add(helmet);
      const rainLight = owned(new THREE.Mesh(parts.light, new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1208, emissiveIntensity: 0 })), body);
      rainLight.position.set(0, 0.5, -2.56);

      const wheels = parts.wheels.map(({ x, z, front, side }) => {
        const pivot = new THREE.Group();
        pivot.position.set(x, WHEEL_RADIUS, z);
        const spin = new THREE.Group();
        pivot.add(spin);
        const tyre = new THREE.Mesh(front ? parts.tyres.front : parts.tyres.rear, rubber);
        tyre.castShadow = true;
        spin.add(tyre);
        const hub = new THREE.Mesh(parts.hub, rim);
        spin.add(hub);
        const band = new THREE.Mesh(parts.band, compoundBands.UNKNOWN);
        band.position.x = side * (front ? 0.163 : 0.213);
        spin.add(band);
        body.add(pivot);
        return { pivot, spin, band, front };
      });

      const label = owned(labelSprite(driver.code), group);
      const dot = owned(dotSprite(driver.color), group);
      dot.position.y = 2;
      world.add(group);
      return { driver, group, body, wheels, label, dot, rainLight, nearest: 0, heading: 0, lean: 0, pitch: 0, lastHeading: 0 };
    });
    return { cars, paints };
  }

  function placeOverview() {
    const { span } = built;
    const tall = Math.tan(THREE.MathUtils.degToRad(42) / 2);
    const wide = tall * camera.aspect;
    const distance = Math.max(span / wide, (span * 1.04) / tall) * 1.08;
    camera.fov = 42;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    camera.position.set(0, Math.sin(OVERVIEW_TILT) * distance, Math.cos(OVERVIEW_TILT) * distance);
    controls.minDistance = 30;
    controls.maxDistance = distance * 2;
    controls.update();
  }

  function nearestSample(car, x, z) {
    const { samples } = built;
    const count = samples.length;
    let best = car.nearest;
    let bestDistance = Infinity;
    const test = (index) => {
      const distance = (samples[index].x - x) ** 2 + (samples[index].z - z) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    };
    for (let offset = -NEAREST_WINDOW; offset <= NEAREST_WINDOW; offset += 1) test((car.nearest + offset + count) % count);
    if (bestDistance > 1600) for (let index = 0; index < count; index += 5) test(index);
    car.nearest = best;
    return best;
  }

  function moveCars(t, selected, showLabels, seconds) {
    const { cx, cy, samples } = built;
    const elapsed = Math.min(Math.abs(t - lastT), 2);
    // Fixed-size sprites still grow with a narrow lens, so undo the camera zoom.
    const zoom = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(42) / 2);
    for (const car of built.cars) {
      const { driver, group, label, dot } = car;
      const out = isOut(driver, t);
      group.visible = !out;
      if (out) continue;
      const state = carAt(driver, t);
      const x = state.x - cx;
      const z = -(state.y - cy);
      const index = nearestSample(car, x, z);
      const road = samples[index];
      const next = samples[(index + 1) % samples.length];
      const previous = samples[(index - 1 + samples.length) % samples.length];
      const across = next.clone().sub(previous);
      const along = THREE.MathUtils.clamp(((x - road.x) * across.x + (z - road.z) * across.z) / (across.x ** 2 + across.z ** 2 || 1), -0.5, 0.5);
      const height = road.y + (next.y - previous.y) * along + 0.14;
      group.position.set(x, seconds >= 1 ? height : group.position.y + (height - group.position.y) * (1 - Math.exp(-seconds * 18)), z);
      const heading = Math.atan2(state.dx, -state.dy);
      if (state.dx * state.dx + state.dy * state.dy > 0.25) car.heading = heading;
      group.rotation.y = car.heading;

      const ahead = samples[(index + 10) % samples.length];
      const behind = samples[(index - 10 + samples.length) % samples.length];
      const slope = Math.atan2(behind.y - ahead.y, behind.distanceTo(ahead) || 1);
      const turning = THREE.MathUtils.euclideanModulo(car.heading - car.lastHeading + Math.PI, Math.PI * 2) - Math.PI;
      car.lastHeading = car.heading;
      const blend = 1 - Math.exp(-seconds * 8);
      const brake = driver.brk[state.index] / 100;
      const power = driver.thr[state.index] / 100;
      const yaw = elapsed > 0 ? THREE.MathUtils.clamp(turning / elapsed, -1, 1) : 0;
      car.lean += (yaw * 0.035 - car.lean) * blend;
      car.pitch += ((brake * 0.018 - power * 0.008) - car.pitch) * blend;
      car.body.rotation.set(slope + car.pitch, 0, car.lean);

      const spin = ((driver.spd[state.index] / 3.6) * elapsed) / WHEEL_RADIUS;
      const tyre = compoundBands[tyreAt(driver, t).compound] ?? compoundBands.UNKNOWN;
      for (const wheel of car.wheels) {
        wheel.spin.rotation.x += spin;
        wheel.band.material = tyre;
        if (wheel.front) wheel.pivot.rotation.y = yaw * 0.4;
      }
      car.rainLight.material.emissiveIntensity = brake > 0.4 ? 45 : 0;

      const isSelected = selected.includes(driver.num);
      const far = mode === "overview" || mode === "helicopter";
      dot.visible = far;
      dot.scale.setScalar((isSelected ? 0.034 : 0.024) * zoom);
      label.scale.set(0.05 * zoom, 0.02 * zoom, 1);
      label.position.y = far ? 3 : 2.1;
      label.visible = isSelected || (showLabels && far && positionAt(driver, t) <= 3);
    }
  }

  function focusCar() {
    const driver = focus();
    return built.cars.find((candidate) => candidate.driver === driver) ?? built.cars[0];
  }

  function aimCamera(car, seconds) {
    const { position } = car.group;
    // Only the camera's direction is eased. Its position stays locked to the car, so no replay speed can outrun it.
    const turn = THREE.MathUtils.euclideanModulo(car.heading - cameraHeading + Math.PI, Math.PI * 2) - Math.PI;
    cameraHeading = seconds >= 1 ? car.heading : cameraHeading + turn * (1 - Math.exp(-seconds * 6));
    const forward = new THREE.Vector3(Math.sin(cameraHeading), 0, Math.cos(cameraHeading));
    const speed = car.driver.spd[Math.min(carAt(car.driver, lastT).index, car.driver.spd.length - 1)];
    const follow = 1 - Math.exp(-seconds * 7);
    if (mode === "chase") {
      camera.position.copy(position).addScaledVector(forward, -9.5).setY(position.y + 3.1);
      camera.fov += (58 + (speed / 340) * 16 - camera.fov) * follow;
      camera.lookAt(position.x + forward.x * 6, position.y + 1, position.z + forward.z * 6);
    } else if (mode === "onboard") {
      camera.position.copy(position).addScaledVector(forward, 0.55).setY(position.y + 1.18);
      camera.fov += (68 + (speed / 340) * 12 - camera.fov) * follow;
      const target = position.clone().addScaledVector(forward, 45).setY(position.y + 0.6);
      camera.lookAt(target);
    } else if (mode === "helicopter") {
      camera.position.copy(position).addScaledVector(forward, -70).setY(position.y + 62);
      camera.fov = 38;
      camera.lookAt(position);
    } else {
      const { samples, sides } = built;
      const step = Math.floor(samples.length / TV_STATIONS);
      const current = Math.round(car.nearest / step) % TV_STATIONS;
      if (current !== station) {
        station = current;
        const index = (current * step + Math.floor(step / 2)) % samples.length;
        const direction = current % 2 ? 1 : -1;
        camera.position.copy(samples[index]).addScaledVector(sides[index], direction * 56);
        camera.position.y = Math.max(samples[index].y, built.heightAt(camera.position.x, camera.position.z)) + 13;
      }
      const distance = camera.position.distanceTo(position);
      camera.fov = THREE.MathUtils.clamp((2 * Math.atan(11 / distance) * 180) / Math.PI, 9, 46);
      camera.lookAt(position.x, position.y + 0.7, position.z);
    }
    camera.updateProjectionMatrix();
  }

  function frameView() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const wide = width >= WIDE_LAYOUT && mode !== "overview";
    if (wide) camera.setViewOffset(width, height, 0, height * VIEW_LIFT, width, height);
    else camera.clearViewOffset();
  }

  function placeSun(target) {
    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(sunDirection, 420);
  }

  return {
    setRace(next) {
      if (race === next) return;
      clearWorld();
      race = next;
      const route = buildRoute();
      route.pit = findPitLane(route);
      buildTerrain(route);
      const surface = buildSurfaces(route);
      buildPitLane(route);
      buildGrandstands(route);
      buildPitBuilding(route);
      buildTrees(route);
      const lamps = buildGantry(route);
      const { cars, paints } = buildCars();
      built = { ...route, heightAt: route.groundAt, surface, lamps, cars, paints };
      scene.fog = new THREE.Fog(0xcfdce6, route.span * 3, route.span * 9);
      this.resize();
      placeOverview();
    },

    setCamera(next) {
      mode = next;
      station = -1;
      cameraMoved = false;
      controls.enabled = mode === "overview";
      if (built && mode === "overview") placeOverview();
      frameView();
      lastDraw = 0;
    },

    setLamps(count) {
      built?.lamps.forEach((lamp, index) => {
        lamp.material.emissiveIntensity = index < count ? 70 : 0;
      });
    },

    // How close the camera is to the followed car, used to mix its engine sound.
    presence() {
      if (!built) return 0;
      if (mode === "chase" || mode === "onboard") return 1;
      if (mode === "overview") return 0.3;
      return 1 / (1 + (camera.position.distanceTo(focusCar().group.position) / 90) ** 2);
    },

    render(t, selected, status, showLabels) {
      if (!built) return;
      const now = performance.now();
      const frame = now - lastDraw;
      const seconds = lastDraw ? Math.min(frame / 1000, 0.1) : 1;
      lastDraw = now;
      built.surface.material.color.set(status ? (status.kind === "RED" ? 0xffb0a8 : 0xffe680) : 0xffffff);
      moveCars(t, selected, showLabels, seconds);
      lastT = t;
      const car = focusCar();
      const overview = mode === "overview";
      sun.castShadow = !overview;
      if (!overview) {
        placeSun(car.group.position);
        aimCamera(car, seconds);
      }
      draw();
      if (useBloom && frame < 500) {
        slowFrames = frame > SLOW_FRAME_MS ? slowFrames + 1 : Math.max(slowFrames - 1, 0);
        if (slowFrames > SLOW_FRAME_LIMIT) {
          useBloom = false;
          pixelRatio = Math.min(pixelRatio, 1.25);
          renderer.setPixelRatio(pixelRatio);
          this.resize();
        }
      }
    },

    resize() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      camera.aspect = width / height;
      frameView();
      camera.updateProjectionMatrix();
      if (built && mode === "overview" && !cameraMoved) placeOverview();
    },
  };
}
