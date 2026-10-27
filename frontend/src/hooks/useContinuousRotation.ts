import { useState } from 'react';

/**
 * The angle to draw for a rotation that is stored as 0, 90, 180 or 270.
 *
 * A CSS transition from 270deg to 0deg turns back through 270 degrees, so a page
 * rotated clockwise over and over spins the wrong way once it passes a full turn.
 * This keeps a running angle that moves by the shortest step instead, so each
 * click turns the page a quarter in the direction it was turned.
 */
export function useContinuousRotation(rotation: number): number {
  const [state, setState] = useState({ base: rotation, angle: rotation });
  if (state.base !== rotation) {
    let step = (((rotation - state.base) % 360) + 360) % 360;
    if (step > 180) step -= 360;
    setState({ base: rotation, angle: state.angle + step });
    return state.angle + step;
  }
  return state.angle;
}
