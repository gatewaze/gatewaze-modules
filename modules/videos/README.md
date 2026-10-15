# Videos

Video masters, shorts and scheduled publication. Editors upload against a talk
or an episode, Gatewaze holds the file, and publication to a platform is a
separate scheduled act handled by the `videos-publisher-*` modules.

The full design is in `gatewaze-roadmap/specs/spec-videos-publishing-and-platform-metrics.md`.
This file covers the two things an operator has to set up by hand.

## Where masters are stored

Masters and shorts go to an S3-compatible bucket when these five variables
are set on the API and worker pods. Thumbnails, and every asset written before
migration 014, stay on Supabase Storage.

| Variable | Example |
|---|---|
| `VIDEO_S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `VIDEO_S3_REGION` | `us-west-004` |
| `VIDEO_S3_BUCKET` | `aaif-video-masters` |
| `VIDEO_S3_ACCESS_KEY_ID` | an application key restricted to that bucket |
| `VIDEO_S3_SECRET_ACCESS_KEY` | its secret |

All five or none. With any missing, new masters go to Supabase's private
`video-masters` bucket as before. Each `video_assets` row records which store
holds it (`storage_provider`), so switching the variables on does not move or
break existing files.

The bucket needs a CORS rule allowing `PUT`, `GET`, `HEAD` and `POST` from the
admin origin with `ETag` exposed, because the editor's browser uploads
straight to it on a presigned URL. The key should be restricted to the one
bucket.

Why not Supabase for everything: Supabase charges $0.09 per GB to read, and
the thumbnail pipeline reads every master once. Backblaze B2 reads are free up
to three times the stored amount a month, and storage is about a third of the
price.

## Getting masters for talks that only exist on YouTube

YouTube serves nothing above 360p without a browser session, so the right way
to get a channel's originals is Google Takeout, delivered to a Drive folder.

1. On the Google account that owns the channel, run Takeout for YouTube with
   "videos" selected, and have it delivered to Google Drive. The export is a
   folder of video files named after their titles plus a `videos.csv` with
   the YouTube ids.
2. Share that folder with the import identity. Either a service account
   (`VIDEO_DRIVE_SERVICE_ACCOUNT_JSON`, the key file's JSON as one string;
   share the folder with its `client_email`) or an OAuth refresh token
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, the
   same names the newsletter Google Docs import uses).
3. In the admin, open Video imports, paste the folder link, and optionally an
   event id to limit matching to that event's videos. The worker streams each
   file into the master store and attaches it to the existing YouTube video by
   id (from the CSV) or by a unique title match. Unmatched files become
   unassigned videos for triage.

The import is operator-triggered, never scheduled, and stops at
`drive_import_run_cap_bytes` (300 GB by default). Re-run to continue; files
already imported are skipped.

The YouTube import on the same page is the fallback for a talk with no
original. It pulls the one progressive stream YouTube offers, which is 360p,
and attaches it to the existing video row.
