/**
 * Podcast brick — title, rich-text description, and Video/Spotify/Apple
 * links. A community brick rendered inside the MLOps Community slot.
 */

import { Section, Heading, Text, Link, Hr } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { BODY, LINK, DIVIDER } from './_shared.js';

interface PodcastProps extends Record<string, unknown> {
  title: string;
  description: string;
  video_link: string;
  spotify_link: string;
  apple_link: string;
}

export const PodcastBlock: EmailBlockEntry<PodcastProps> = {
  componentId: 'podcast',
  label: 'Podcast (brick)',
  category: 'MLOps Template',
  fields: {
    title: { type: 'text', label: 'Title' },
    description: { type: 'richtext', label: 'Description' },
    video_link: { type: 'text', label: 'Video link' },
    spotify_link: { type: 'text', label: 'Spotify link' },
    apple_link: { type: 'text', label: 'Apple link' },
  },
  defaultProps: { title: '', description: '', video_link: '', spotify_link: '', apple_link: '' },
  Component: ({ title, description, video_link, spotify_link, apple_link, _last }) => (
    <Section style={{ padding: 0 }}>
      {title ? (
        <Heading as="h3" style={{ margin: '0 0 8px', fontSize: '24px', fontWeight: 'bold', color: '#000', lineHeight: 1.2 }}>
          {title}
        </Heading>
      ) : null}
      <RichText value={description} style={BODY} />
      <Text style={{ ...BODY, marginTop: '8px' }}>
        <strong>
          {video_link ? (
            <Link href={video_link} style={LINK}>
              Video
            </Link>
          ) : null}
          {spotify_link ? (
            <>
              {' || '}
              <Link href={spotify_link} style={LINK}>
                Spotify
              </Link>
            </>
          ) : null}
          {apple_link ? (
            <>
              {' || '}
              <Link href={apple_link} style={LINK}>
                Apple
              </Link>
            </>
          ) : null}
        </strong>
      </Text>
      {_last ? null : <Hr style={DIVIDER} />}
    </Section>
  ),
};
