// Test stub for @gatewaze/shared/modules (not vendored into this workspace). Only the credential
// crypto helpers that the imported lib graph references are provided; they are never invoked by the
// route handlers under test here.
export const encryptSecret = (s: string) => ({ ciphertext: `enc:${s}`, last4: s.slice(-4) });
export const decryptSecret = (c: string) => String(c).replace(/^enc:/, '');
export const getLast4 = (s: string) => String(s).slice(-4);
