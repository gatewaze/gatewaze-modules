/**
 * Re-export the platform's secret-envelope helpers under a stable name
 * inside this module, so call sites import from one place instead of
 * deep-linking into `@gatewaze/shared/modules/secrets`.
 *
 * Centralising the import surface also makes mocking trivial in tests.
 */

export {
  encryptSecret,
  decryptSecret,
  getLast4,
  maskSecret,
  isEncryptionConfigured,
} from '@gatewaze/shared/modules';
