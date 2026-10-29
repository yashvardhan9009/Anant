import { describe, it, expect } from 'vitest';
import { validEarthTile } from '../server/earth';
import { parseCoordinates } from '../src/earth/places';
import { terrariumHeight, resampleHeights } from '../src/earth/terrain';

describe('Earth data boundaries', () => {
  it('accepts only coordinates inside the available tile pyramid', () => {
    expect(validEarthTile(14, 16383, 16383)).toBe(true);
    for (const tile of [[15, 0, 0], [0, 1, 0], [2, -1, 0], [1, 0, 2], [2.5, 0, 0], [NaN, 0, 0]]) expect(validEarthTile(...tile as [number, number, number])).toBe(false);
  });
  it('parses latitude before longitude and rejects out-of-range input', () => {
    expect(parseCoordinates('18.94, 72.83')).toMatchObject({ lat: 18.94, lon: 72.83 });
    expect(parseCoordinates('91, 12')).toBeUndefined();
    expect(parseCoordinates('20, 181')).toBeUndefined();
    expect(parseCoordinates('Mumbai')).toBeUndefined();
  });
  it('decodes signed fractional heights without RGB colour conversion', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(128, 10, 128)).toBe(10.5);
    expect(terrariumHeight(127, 255, 0)).toBe(-1);
    const grid = new Uint8ClampedArray([128,0,0,255, 128,10,0,255, 128,20,0,255, 128,30,0,255]);
    expect([...resampleHeights(grid, 2, 3)]).toEqual([0,5,10,10,15,20,20,25,30]);
  });
});
