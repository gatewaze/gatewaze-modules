import { describe, it, expect } from 'vitest';
import { faceOf, sized } from '../event-pages/_components/_lib/gallery-face';

const plain = {
  url: 'https://cdn/photo.jpg',
  variants: { thumb: 'https://cdn/photo.jpg?width=350', medium: 'https://cdn/photo.jpg?width=800' },
};
const improved = {
  url: 'https://cdn/enhanced.jpg',
  variants: { thumb: 'https://cdn/enhanced.jpg?width=350', medium: 'https://cdn/enhanced.jpg?width=800' },
  enhanced: true,
  original: { url: 'https://cdn/photo.jpg', thumb: 'https://cdn/photo.jpg?width=350', medium: 'https://cdn/photo.jpg?width=800' },
};
const booth = { ...improved, selfie: 'https://cdn/selfie.jpg' };

describe('which picture a tile shows', () => {
  it('shows the right size for the space it is in', () => {
    expect(faceOf(plain, 350)).toContain('width=350');
    expect(faceOf(plain, 1200)).toContain('width=800');
  });

  it('shows the enhanced copy where the album is showing them', () => {
    expect(faceOf(improved, 1200)).toContain('enhanced.jpg');
    expect(faceOf(improved, 350)).toContain('enhanced.jpg');
  });

  // The whole point of the switch: seeing what was done.
  it('shows the photograph as it was taken when asked', () => {
    expect(faceOf(improved, 1200, { enhanced: false })).toBe('https://cdn/photo.jpg?width=800');
    expect(faceOf(improved, 350, { enhanced: false })).toBe('https://cdn/photo.jpg?width=350');
  });

  it('has nothing to switch to on a photograph that was never enhanced', () => {
    expect(faceOf(plain, 1200, { enhanced: false })).toContain('photo.jpg');
    expect(faceOf(plain, 1200, { enhanced: true })).toContain('photo.jpg');
  });

  it('shows the selfie under x-ray, whatever else is asked for', () => {
    for (const choice of [{ xray: true }, { xray: true, enhanced: true }, { xray: true, enhanced: false }]) {
      expect(faceOf(booth, 1200, choice)).toContain('selfie.jpg');
    }
    // And nothing changes for a booth picture with no selfie kept.
    expect(faceOf(improved, 1200, { xray: true })).toContain('enhanced.jpg');
  });

  it('asks the CDN for a size without doubling a query it already has', () => {
    expect(sized('https://cdn/s.jpg', 350)).toBe('https://cdn/s.jpg?width=350&quality=80');
    expect(sized('https://cdn/s.jpg?width=800', 350)).toBe('https://cdn/s.jpg?width=800');
  });
});
