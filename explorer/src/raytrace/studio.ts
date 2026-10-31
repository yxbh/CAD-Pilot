// The ray-traced view's light: Studio's soft boxes drawn as an equirectangular HDR around the model, as VAULTaway's
// photo mode draws its studios (see the README's provenance). The path tracer samples it directly, so every reflection
// and shadow comes from the same boxes.
import { DataTexture, EquirectangularReflectionMapping, FloatType, LinearFilter, LinearSRGBColorSpace, RGBAFormat, Vector3 } from "three";

type Softbox = { toward: [number, number, number]; radius: number; intensity: number; color: [number, number, number] };

// Directions on the model's axes (Z up), placed as Studio's lights are: a key light front right above, a broad box
// behind left, a cool side box at the right and a dim fill front left.
const SOFTBOXES: Softbox[] = [
  { toward: [1.4, -1.8, 2.5], radius: 0.32, intensity: 9, color: [1, 0.96, 0.9] },
  { toward: [-0.9, 1.2, 1.6], radius: 0.5, intensity: 3.2, color: [1, 0.97, 0.93] },
  { toward: [1.4, -0.8, 0.9], radius: 0.28, intensity: 2.6, color: [0.86, 0.93, 1] },
  { toward: [-1.8, -0.5, 1.1], radius: 0.4, intensity: 0.9, color: [0.8, 0.88, 1] },
];
// The walls' own glow above and below the horizon, so shadows stay readable.
const WALLS = { above: [0.16, 0.18, 0.21], below: [0.07, 0.08, 0.09] };

/**
 * The studio as a 512×256 equirectangular texture in three.js's Y-up layout; the traced scene turns it a quarter turn
 * about X (environmentRotation) so its up is the model's +Z.
 */
export function softboxStudio(): DataTexture {
  const width = 512, height = 256, data = new Float32Array(width * height * 4);
  const boxes = SOFTBOXES.map((box) => ({ ...box, direction: new Vector3(...box.toward).normalize() }));
  const world = new Vector3();
  for (let row = 0; row < height; row++) {
    const elevation = ((row + 0.5) / height - 0.5) * Math.PI;
    for (let column = 0; column < width; column++) {
      const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
      // The texel's direction, Y up, turned to the model's Z up: (x, y, z) to (x, -z, y).
      const [x, y, z] = [Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)];
      world.set(x, -z, y);
      const wall = world.z > 0 ? WALLS.above.map((value) => value * (1 + world.z)) : WALLS.below;
      const color = [...wall];
      for (const box of boxes) {
        const angle = Math.acos(Math.min(1, world.dot(box.direction)));
        if (angle >= box.radius) continue;
        // Soft edges over the outer quarter of each box.
        const weight = box.intensity * Math.min(1, (box.radius - angle) / (box.radius * 0.25));
        for (let channel = 0; channel < 3; channel++) color[channel] += box.color[channel] * weight;
      }
      data.set([...color, 1], (row * width + column) * 4);
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
