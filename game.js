import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js";

const canvas = document.querySelector("#maze");
const shell = document.querySelector("#game-shell");
const intro = document.querySelector("#intro");
const ending = document.querySelector("#ending");
const beginButton = document.querySelector("#begin");
const againButton = document.querySelector("#again");
const hintButton = document.querySelector("#hint");
const status = document.querySelector("#status");
const fallback = document.querySelector("#fallback");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const COLS = 9;
const ROWS = 11;
const CELL_SIZE = 1;
const START = { x: 1, y: ROWS - 2 };
const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

let renderer;
let scene;
let camera;
let player;
let playerLight;
let goal;
let goalCell;
let grid;
let mazeGroup;
let hintGroup;
let starField;
let position = { ...START };
let targetWorld = new THREE.Vector3();
let moveStartWorld = new THREE.Vector3();
let moveProgress = 1;
let gameStarted = false;
let gameWon = false;
let hintVisible = false;
let pointerStart = null;
let lastTime = 0;
let wallBumps = 0;

function seededRandom(initialSeed) {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
}

function shuffle(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function generateMaze() {
  const random = seededRandom(randomSeed());
  const maze = Array.from({ length: ROWS }, () => Array(COLS).fill(1));

  function carve(x, y) {
    maze[y][x] = 0;
    const steps = shuffle(
      [
        { x: 0, y: -2 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
        { x: -2, y: 0 },
      ],
      random,
    );

    for (const step of steps) {
      const nextX = x + step.x;
      const nextY = y + step.y;
      const inside = nextX > 0 && nextX < COLS - 1 && nextY > 0 && nextY < ROWS - 1;

      if (inside && maze[nextY][nextX] === 1) {
        maze[y + step.y / 2][x + step.x / 2] = 0;
        carve(nextX, nextY);
      }
    }
  }

  carve(START.x, START.y);
  return maze;
}

function key(cell) {
  return `${cell.x},${cell.y}`;
}

function findFarthestCell(start) {
  const queue = [start];
  const distance = new Map([[key(start), 0]]);
  let farthest = start;
  let farthestSeparated = null;

  while (queue.length) {
    const current = queue.shift();
    if (distance.get(key(current)) > distance.get(key(farthest))) farthest = current;
    const separation = Math.abs(current.x - start.x) + Math.abs(current.y - start.y);
    if (
      separation >= 6 &&
      (!farthestSeparated || distance.get(key(current)) > distance.get(key(farthestSeparated)))
    ) {
      farthestSeparated = current;
    }

    for (const direction of Object.values(DIRECTIONS)) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      const nextKey = key(next);
      if (grid[next.y]?.[next.x] === 0 && !distance.has(nextKey)) {
        distance.set(nextKey, distance.get(key(current)) + 1);
        queue.push(next);
      }
    }
  }

  const cell = farthestSeparated || farthest;
  return { cell, distance: distance.get(key(cell)), reachableCells: distance.size };
}

function worldFromCell(cell) {
  return new THREE.Vector3(
    (cell.x - (COLS - 1) / 2) * CELL_SIZE,
    0.42,
    (cell.y - (ROWS - 1) / 2) * CELL_SIZE,
  );
}

function createHeartGeometry(scale = 0.023) {
  const points = [];
  for (let index = 0; index < 48; index += 1) {
    const t = (index / 48) * Math.PI * 2;
    points.push(
      new THREE.Vector2(
        16 * Math.sin(t) ** 3,
        13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      ),
    );
  }

  const shape = new THREE.Shape(points);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 3.2,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 1.5,
    bevelThickness: 1.4,
  });
  geometry.center();
  geometry.scale(scale, scale, scale);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function createStars() {
  const count = reducedMotion ? 90 : 180;
  const positions = new Float32Array(count * 3);
  const random = seededRandom(22082026);

  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (random() - 0.5) * 28;
    positions[index * 3 + 1] = 1 + random() * 8;
    positions[index * 3 + 2] = (random() - 0.5) * 28;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xeab2c7,
    size: 0.035,
    transparent: true,
    opacity: 0.44,
    depthWrite: false,
  });
  return new THREE.Points(geometry, material);
}

function disposeMazeGroup() {
  if (!mazeGroup) return;
  const geometries = new Set();
  const materials = new Set();

  mazeGroup.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
    else if (object.material) materials.add(object.material);
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  scene.remove(mazeGroup);
}

function buildMazeScene() {
  disposeMazeGroup();
  mazeGroup = new THREE.Group();
  scene.add(mazeGroup);

  let goalResult;
  let attempts = 0;
  do {
    grid = generateMaze();
    goalResult = findFarthestCell(START);
    attempts += 1;
  } while ((goalResult.distance < 18 || goalResult.reachableCells < 39) && attempts < 16);

  goalCell = goalResult.cell;
  const openCellCount = grid.flat().filter((cell) => cell === 0).length;
  if (goalResult.reachableCells !== openCellCount || goalResult.distance === 0) {
    throw new Error("Maze generation produced an unreachable route.");
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(COLS + 4, ROWS + 4),
    new THREE.MeshStandardMaterial({ color: 0x160b13, roughness: 0.88, metalness: 0.04 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.06;
  mazeGroup.add(floor);

  const wallCells = [];
  const pathCells = [];
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      if (grid[y][x] === 1) wallCells.push({ x, y });
      else pathCells.push({ x, y });
    }
  }

  const pathGeometry = new THREE.BoxGeometry(0.82, 0.035, 0.82);
  const pathMaterial = new THREE.MeshStandardMaterial({
    color: 0x351522,
    emissive: 0x16060d,
    emissiveIntensity: 0.65,
    roughness: 0.82,
  });
  const paths = new THREE.InstancedMesh(pathGeometry, pathMaterial, pathCells.length);
  const pathMatrix = new THREE.Matrix4();
  pathCells.forEach((cell, index) => {
    const world = worldFromCell(cell);
    pathMatrix.makeTranslation(world.x, -0.015, world.z);
    paths.setMatrixAt(index, pathMatrix);
  });
  paths.instanceMatrix.needsUpdate = true;
  mazeGroup.add(paths);

  const wallGeometry = new THREE.BoxGeometry(0.91, 0.72, 0.91);
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x562238,
    emissive: 0x210b15,
    emissiveIntensity: 0.62,
    roughness: 0.74,
    metalness: 0.08,
  });
  const walls = new THREE.InstancedMesh(wallGeometry, wallMaterial, wallCells.length);
  const matrix = new THREE.Matrix4();

  wallCells.forEach((cell, index) => {
    const world = worldFromCell(cell);
    matrix.makeTranslation(world.x, 0.3, world.z);
    walls.setMatrixAt(index, matrix);
  });
  walls.instanceMatrix.needsUpdate = true;
  mazeGroup.add(walls);

  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xb64f76, transparent: true, opacity: 0.42 });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeometry), lineMaterial);
  wallCells.forEach((cell) => {
    const edge = edges.clone();
    const world = worldFromCell(cell);
    edge.position.set(world.x, 0.3, world.z);
    mazeGroup.add(edge);
  });

  player = new THREE.Mesh(
    createHeartGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xff5f98,
      toneMapped: false,
    }),
  );
  targetWorld.copy(worldFromCell(START));
  moveStartWorld.copy(targetWorld);
  player.position.copy(targetWorld);
  player.position.y = 0.54;
  player.rotation.z = Math.PI;
  mazeGroup.add(player);

  playerLight = new THREE.PointLight(0xff4f8f, 3.8, 3.2, 2);
  playerLight.position.copy(player.position).add(new THREE.Vector3(0, 0.8, 0));
  mazeGroup.add(playerLight);

  const goalWorld = worldFromCell(goalCell);
  goal = new THREE.Group();
  goal.position.set(goalWorld.x, 0.05, goalWorld.z);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.045, 12, 48),
    new THREE.MeshBasicMaterial({ color: 0xffc2d7, transparent: true, opacity: 0.8, toneMapped: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.12;
  goal.add(ring);

  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.42, 2.7, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xff7cac,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  beacon.position.y = 1.35;
  goal.add(beacon);

  const goalHeart = new THREE.Mesh(
    createHeartGeometry(0.014),
    new THREE.MeshBasicMaterial({ color: 0xffc1d6, toneMapped: false }),
  );
  goalHeart.position.y = 0.62;
  goalHeart.rotation.z = Math.PI;
  goal.add(goalHeart);

  const goalLight = new THREE.PointLight(0xff9abc, 7, 5.5, 2);
  goalLight.position.y = 1.1;
  goal.add(goalLight);
  mazeGroup.add(goal);

  hintGroup = new THREE.Group();
  mazeGroup.add(hintGroup);

  position = { ...START };
  moveProgress = 1;
}

function init() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.34;

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x09050c, 0.055);
    camera = new THREE.PerspectiveCamera(46, 1, 0.1, 60);
    camera.position.set(0, 15.5, 14.5);
    camera.lookAt(0, 0, -0.25);

    scene.add(new THREE.HemisphereLight(0xf0c4d4, 0x1a0a14, 2.35));
    const keyLight = new THREE.DirectionalLight(0xffd3e2, 2.1);
    keyLight.position.set(-4, 9, 6);
    scene.add(keyLight);

    starField = createStars();
    scene.add(starField);
    buildMazeScene();
    resize();
    renderer.setAnimationLoop(animate);
  } catch (error) {
    console.error(error);
    fallback.hidden = false;
    canvas.hidden = true;
  }
}

function resize() {
  if (!renderer) return;
  const bounds = shell.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;

  const portrait = height > width;
  camera.fov = portrait ? (width < 350 ? 56 : 51) : 43;
  camera.position.set(0, portrait ? 17.2 : 14.5, portrait ? 15.8 : 16.5);
  camera.lookAt(0, 0, portrait ? -0.25 : 0);
  camera.updateProjectionMatrix();
}

function setStatus(message, bumped = false) {
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("bump", bumped);
  if (bumped) window.setTimeout(() => status.classList.remove("bump"), 220);
}

function pathFromCurrent() {
  const queue = [{ ...position }];
  const visited = new Set([key(position)]);
  const parents = new Map();

  while (queue.length) {
    const current = queue.shift();
    if (current.x === goalCell.x && current.y === goalCell.y) {
      const path = [current];
      let cursor = current;
      while (parents.has(key(cursor))) {
        cursor = parents.get(key(cursor));
        path.push(cursor);
      }
      return path.reverse();
    }

    for (const direction of Object.values(DIRECTIONS)) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      if (grid[next.y]?.[next.x] === 0 && !visited.has(key(next))) {
        visited.add(key(next));
        parents.set(key(next), current);
        queue.push(next);
      }
    }
  }
  return [];
}

function updateHintPath() {
  while (hintGroup.children.length) {
    const child = hintGroup.children.pop();
    child.geometry.dispose();
    child.material.dispose();
  }

  if (!hintVisible) return;
  const path = pathFromCurrent().slice(1, -1);
  path.forEach((cell, index) => {
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.06, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffa4c3,
        transparent: true,
        opacity: 0.28 + (index / Math.max(1, path.length)) * 0.34,
        depthWrite: false,
      }),
    );
    const world = worldFromCell(cell);
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(world.x, 0.015, world.z);
    hintGroup.add(dot);
  });
}

function tryMove(directionName) {
  if (!gameStarted || gameWon || moveProgress < 1) return;
  const direction = DIRECTIONS[directionName];
  const next = { x: position.x + direction.x, y: position.y + direction.y };

  if (grid[next.y]?.[next.x] !== 0) {
    wallBumps += 1;
    setStatus(wallBumps >= 3 && !hintVisible ? "Need a little hint?" : "Not this way", true);
    player.rotation.y += 0.2;
    return;
  }

  moveStartWorld.copy(player.position);
  position = next;
  targetWorld.copy(worldFromCell(position));
  targetWorld.y = 0.54;
  moveProgress = 0;
  setStatus(hintVisible ? "Follow the glowing path" : "Follow the light");
  updateHintPath();

  if (position.x === goalCell.x && position.y === goalCell.y) {
    window.setTimeout(winGame, reducedMotion ? 80 : 360);
  }
}

function winGame() {
  if (gameWon) return;
  gameWon = true;
  setStatus("You found your way home");
  window.setTimeout(() => {
    ending.classList.add("visible");
    ending.setAttribute("aria-hidden", "false");
  }, reducedMotion ? 50 : 520);
}

function resetGame() {
  gameWon = false;
  wallBumps = 0;
  hintVisible = false;
  hintButton.classList.remove("active");
  buildMazeScene();
  updateHintPath();
  setStatus("Follow the light");
}

function animate(time = 0) {
  const delta = Math.min(time - lastTime || 16, 40);
  lastTime = time;

  if (moveProgress < 1) {
    moveProgress = Math.min(1, moveProgress + delta / 170);
    const eased = 1 - (1 - moveProgress) ** 3;
    player.position.lerpVectors(moveStartWorld, targetWorld, eased);
    player.position.y = 0.54 + Math.sin(moveProgress * Math.PI) * 0.22;
  }

  const pulse = reducedMotion ? 0 : Math.sin(time * 0.003);
  player.scale.setScalar(1 + pulse * 0.035);
  playerLight.intensity = 3.6 + pulse * 0.55;
  playerLight.position.copy(player.position).add(new THREE.Vector3(0, 0.7, 0));

  if (goal) {
    goal.rotation.y = reducedMotion ? 0 : time * 0.00055;
    goal.scale.setScalar(1 + (reducedMotion ? 0 : Math.sin(time * 0.0024) * 0.04));
  }
  if (starField && !reducedMotion) starField.rotation.y = time * 0.000025;

  renderer.render(scene, camera);
}

beginButton.addEventListener("click", () => {
  gameStarted = true;
  intro.classList.remove("visible");
});

againButton.addEventListener("click", () => {
  ending.classList.remove("visible");
  ending.setAttribute("aria-hidden", "true");
  resetGame();
});

hintButton.addEventListener("click", () => {
  if (!gameStarted || gameWon) return;
  hintVisible = !hintVisible;
  hintButton.classList.toggle("active", hintVisible);
  setStatus(hintVisible ? "Follow the glowing path" : "Follow the light");
  updateHintPath();
});

document.querySelectorAll(".direction").forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    tryMove(button.dataset.direction);
  });
});

shell.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) return;
  pointerStart = { x: event.clientX, y: event.clientY };
});

shell.addEventListener("pointerup", (event) => {
  if (!pointerStart || event.target.closest("button")) {
    pointerStart = null;
    return;
  }

  const deltaX = event.clientX - pointerStart.x;
  const deltaY = event.clientY - pointerStart.y;
  pointerStart = null;
  if (Math.hypot(deltaX, deltaY) < 24) return;

  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    tryMove(deltaX > 0 ? "right" : "left");
  } else {
    tryMove(deltaY > 0 ? "down" : "up");
  }
});

shell.addEventListener("pointercancel", () => {
  pointerStart = null;
});

window.addEventListener("resize", resize);
window.addEventListener("orientationchange", resize);
window.visualViewport?.addEventListener("resize", resize);

init();
