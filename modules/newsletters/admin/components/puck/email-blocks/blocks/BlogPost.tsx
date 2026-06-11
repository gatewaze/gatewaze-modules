/**
 * Blog Post brick — title, rich-text description, and a "Read the blog" link.
 * A community brick rendered inside the MLOps Community slot.
 */

import { Section, Heading, Text, Link, Hr } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { BODY, LINK, BRICK_TITLE, DIVIDER } from './_shared.js';

interface BlogPostProps extends Record<string, unknown> {
  title: string;
  description: string;
  blog_link: string;
  link_text: string;
}

export const BlogPostBlock: EmailBlockEntry<BlogPostProps> = {
  componentId: 'blog_post',
  label: 'Blog Post (brick)',
  category: 'Community',
  fields: {
    title: { type: 'text', label: 'Title' },
    description: { type: 'richtext', label: 'Description' },
    blog_link: { type: 'text', label: 'Blog link' },
    link_text: { type: 'text', label: 'Link text' },
  },
  defaultProps: { title: '', description: '', blog_link: '', link_text: 'Read the blog' },
  Component: ({ title, description, blog_link, link_text }) => (
    <Section style={{ padding: '0 15px' }}>
      {title ? (
        <Heading as="h3" style={BRICK_TITLE}>
          {title}
        </Heading>
      ) : null}
      <RichText value={description} style={BODY} />
      {blog_link ? (
        <Text style={{ ...BODY, marginTop: '8px' }}>
          <strong>
            <Link href={blog_link} style={LINK}>
              {link_text || 'Read the blog'}
            </Link>
          </strong>
        </Text>
      ) : null}
      <Hr style={DIVIDER} />
    </Section>
  ),
};
