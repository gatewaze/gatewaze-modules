/**
 * Client-only re-exports — keeps admin/components free of server-side
 * imports (express, multer, etc.) for clean Vite bundling.
 */

export type {
  AccessLevel,
  HostMediaItem,
  HostMediaAlbum,
  HostMediaUploadResult,
  HostMediaListResponse,
  YoutubeUploadStatus,
  MediaPatchField,
  AlbumWriteField,
} from '../types/index.js';

export { MEDIA_PATCH_FIELDS, ALBUM_WRITE_FIELDS } from '../types/index.js';
