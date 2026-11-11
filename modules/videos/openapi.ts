// OpenAPI contribution for /api/v1/videos, merged by the host into
// /api/v1/openapi.json.

const limit = { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } };
const offset = { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } };
const fields = {
  name: 'fields',
  in: 'query',
  schema: { type: 'string' },
  description: 'Comma-separated field list (sparse fieldset). Unknown fields are ignored.',
};
const errors = {
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
  429: { $ref: '#/components/responses/RateLimited' },
};

export const VIDEOS_OPENAPI = {
  tag: { name: 'Videos', description: 'Published, public videos and what they are linked to' },
  paths: {
    '/': {
      get: {
        summary: 'List published, public videos, newest first',
        operationId: 'listVideos',
        parameters: [
          { name: 'channel', in: 'query', schema: { type: 'string' }, description: 'YouTube channel id (UC…)' },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['full', 'short', 'clip', 'trailer', 'livestream'] } },
          { name: 'event', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Only videos linked to this event (first 200 links)' },
          { name: 'podcast_episode', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Only videos linked to this podcast episode' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search title and description (partial match)' },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Published on or after (RFC 3339)' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Published on or before (RFC 3339)' },
          { name: 'topics', in: 'query', schema: { type: 'string' }, description: 'Comma-separated topic filter (overlap match)' },
          fields,
          limit,
          offset,
        ],
        responses: { 200: { description: 'Paginated list of videos' }, ...errors },
      },
    },
    '/{id}': {
      get: {
        summary: 'Get a video by Gatewaze id or YouTube video id, with what it is linked to',
        operationId: 'getVideo',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Video UUID or 11-character YouTube video id' },
          fields,
        ],
        responses: { 200: { description: 'Video' }, 404: { $ref: '#/components/responses/NotFound' }, ...errors },
      },
    },
  },
  schemas: {
    Video: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        provider: { type: 'string' },
        provider_video_id: { type: 'string' },
        url: { type: ['string', 'null'], format: 'uri' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        thumbnail_url: { type: ['string', 'null'], format: 'uri' },
        duration_seconds: { type: ['integer', 'null'] },
        published_at: { type: ['string', 'null'], format: 'date-time' },
        channel_id: { type: ['string', 'null'] },
        channel_title: { type: ['string', 'null'] },
        kind: { type: 'string', enum: ['full', 'short', 'clip', 'trailer', 'livestream'] },
        topics: { type: 'array', items: { type: 'string' } },
        content_category: { type: ['string', 'null'] },
        subjects: {
          type: 'array',
          description: 'Detail endpoint only: the events, talks, agenda entries and podcast episodes the video is linked to',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['event', 'podcast_episode', 'talk', 'agenda_entry'] },
              id: { type: 'string', format: 'uuid' },
            },
          },
        },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
      },
    },
  },
};
