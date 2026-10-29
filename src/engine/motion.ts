/** Exact integration of an exponentially damped velocity over a frame. */
export function dampedMotion(velocity: number, target: number, response: number, dt: number) {
  if (dt <= 0) return { velocity, distance: 0 };
  const decay = Math.exp(-response * dt);
  return { velocity: target + (velocity - target) * decay,
    distance: target * dt + (velocity - target) * (1 - decay) / response };
}

export function resolveObstacles(x: number, z: number, obstacles: readonly { x: number; z: number; r: number }[], radius = .28) {
  for (let pass = 0; pass < 3; pass++) for (const obstacle of obstacles) {
    const dx = x - obstacle.x, dz = z - obstacle.z, distance = Math.hypot(dx, dz), limit = obstacle.r + radius;
    if (distance < limit) {
      x = obstacle.x + (distance > .0001 ? dx / distance : 1) * limit;
      z = obstacle.z + (distance > .0001 ? dz / distance : 0) * limit;
    }
  }
  return { x, z };
}
