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

## The studio

After a master is uploaded, "Open in studio" on the video (or
`/videos/studio/<video id>`) runs one analysis pass over it and then lets the
editor finish the video by hand:

1. The worker (`videos:studio-analyse`) copies the master to its disk, samples
   a frame every 10 seconds (widening the interval so a long video never takes
   more than 300), scores a dozen frames with a vision model, cuts the speaker
   out of the best ones with birefnet and EVF-SAM, verifies up to two slide
   panels at full resolution, builds a filmstrip, and drafts three headlines
   from the agenda text. The rules it applies are the ones found on the
   AGNTCon EU set: a cut-out must be a close shot (the figure at least half
   the frame tall), with no projector glare on the face and no bright screen
   behind the head; a panel must be a legible, interesting slide with nobody
   in it; a headline may not contain a number the abstract does not.
2. The editor picks a speaker frame, a headline (or types one), the speaker's
   size and position, whether the slides show, where the video starts and
   ends, and whether the talk card goes in front.
3. Approve (`videos:studio-finalize`) renders the thumbnail at 1280x720 in
   Chromium from the same markup the page showed, sets it on the video, and,
   when a trim or the card was asked for, writes a new master: the trim is a
   stream copy from the original, the card is encoded to the master's own
   parameters and joined by stream copy, and the join is re-encoded only if
   that does not verify. The previous master's row is marked superseded; its
   object stays.

It needs `FAL_API_KEY` on the API and the worker, and the worker needs
`ffmpeg-static` and `puppeteer-core` (declared in this module's package.json,
so the image bake and the dev container's start-up install both pick them up)
plus the pinned system Chromium. The brand art, the fonts and the music sting
live in `templates/`; swap the files there for another brand. Working images
(cut-outs, slide panels, the filmstrip, the thumbnail) go to the public
`media` bucket under `video-studio/<video>/<studio>/`, the same bucket every
thumbnail is served from; they are replaced on a re-run. Sampled frames and
the talk's abstract are sent to Fal, and through it to Google's Gemini, to be
scored and drafted. The recording itself never leaves the worker.

Two settings: `studio_max_master_bytes` (8 GB by default; a bigger master is
refused rather than filling the pod) and `studio_sample_every_seconds`.

## Upload batches

For a whole folder of masters, "Upload batches" issues one person a folder
in the master bucket (`batches/<id>/`) and a Backblaze application key that
can only write and list under that folder, for a chosen number of days (7 by
default, 30 at most). No read, no delete, no share. The page shows the
connection bundle once: a Cyberduck link that opens connected to the folder,
an rclone config and command for an AV team, and the plain fields. The key
is never stored; the row keeps its id only.

Every five minutes (or on "Check the folder now") the worker lists each open
batch's folder and adopts every finished upload: a video row titled from the
file name, attached to the batch's event and, when a session title matches,
to that talk; a server-side copy of the object under `batch-import/`,
recorded as a ready master carrying the batch id, the source path and the
source ETag; and a studio pass queued. The copy is deliberate: Backblaze
treats an S3 delete as a hide and `writeFiles` allows it, so the uploader can
hide their own uploads but never touch an adopted master. A later upload
under the same name is flagged on the batch page, not adopted, and the bucket
keeps hidden and replaced versions under `batches/` for 30 days. "Mark
complete" deletes the key; an expired key closes the batch on the next tick.

It needs `VIDEO_B2_KEY_ID` and `VIDEO_B2_KEY` on the API and worker: an
account-level Backblaze key with `listKeys`, `writeKeys`, `deleteKeys` and
`listBuckets`, used for nothing but minting and deleting batch keys. Name
the files after the talks for the agenda match to work.

## Uploading from the command line

For a file too large to push through a browser tab, tick "Upload from the
command line" on the upload step. The mint then returns, per file, a curl
line with a presigned PUT good for 12 hours (S3 stores only). Run it from the
folder that holds the file, then press Check: the server HEADs the object and
applies the same size and content-type checks the browser path does.

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
   id (a `[videoId]` suffix in the filename, as yt-dlp's `[%(id)s]` template
   writes, or Takeout's CSV) or by a unique title match. Unmatched files
   become unassigned videos for triage.

The same import works for a folder of files downloaded with yt-dlp, which is
the practical route when Takeout is not available: name them
`%(title)s [%(id)s].%(ext)s` and the id match is exact.

### Files shipped straight to the bucket

When a laptop cannot hold the whole set, a local yt-dlp run can ship each
finished file straight into the master bucket under `local-import/<id>/`,
with `--write-info-json` so the YouTube title, description, upload date,
duration and chapters travel beside it. Then, in Video imports, "Adopt from
bucket" with the event id. Nothing is moved: each object gets an asset row,
the video row is created or filled in from the metadata, and the talk is
attached from the recap's existing match for that YouTube id or, failing
that, a unique title match against the event's agenda sessions. Objects over
three hours are adopted as livestreams and left for the clipping pipeline.
There is no size cap on this path, because the bytes are already there.

The import is operator-triggered, never scheduled, and stops at
`drive_import_run_cap_bytes` (300 GB by default). Re-run to continue; files
already imported are skipped.

The YouTube import on the same page is the fallback for a talk with no
original. It pulls the one progressive stream YouTube offers, which is 360p,
and attaches it to the existing video row.
