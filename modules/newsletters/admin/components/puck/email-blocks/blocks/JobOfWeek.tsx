/**
 * Job of the Week email block — a grey card listing featured jobs.
 *
 * Native react-email port of the legacy `job_of_week` Mustache block, so
 * its scalar text fields (header, job title/company/location) are inline-
 * editable and it edits through Puck fields. `jobs` is an array field; each
 * job's `description` is HTML rendered via dangerouslySetInnerHTML (same
 * constraint as ContentSection — the inline rich-text editor for HTML
 * fields is shared, parked work, so description edits in the sidebar).
 *
 * componentId === the legacy block_type ('job_of_week') so the existing
 * migrated edition content (which stores { header_title?, jobs[] }) maps
 * straight onto these props, and the editor/export pick this component over
 * the Mustache block_def of the same key.
 */

import { Section, Text, Link, Hr } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { normalizeRichText } from '../rich-text.js';

interface Job extends Record<string, unknown> {
  job_title: string;
  company: string;
  location?: string;
  apply_link: string;
  description?: string;
}

interface JobOfWeekProps extends Record<string, unknown> {
  header_title: string;
  jobs: Job[];
  jobs_board_url: string;
}

const LINK = { textDecoration: 'underline', color: '#4086c6' } as const;
const DIVIDER_STYLE = { border: 0, borderTop: '1px solid #bbb', margin: '10px 20px' } as const;

export const JobOfWeekBlock: EmailBlockEntry<JobOfWeekProps> = {
  componentId: 'job_of_week',
  label: 'Job of the Week',
  category: 'Content',
  fields: {
    header_title: { type: 'text', label: 'Header' },
    jobs: {
      type: 'array',
      label: 'Jobs',
      arrayFields: {
        job_title: { type: 'text', label: 'Job Title' },
        company: { type: 'text', label: 'Company' },
        location: { type: 'text', label: 'Location' },
        apply_link: { type: 'text', label: 'Apply Link' },
        description: { type: 'custom', customFormat: 'richtext', label: 'Description' } as Field,
      },
      defaultItemProps: {
        job_title: 'Job title',
        company: 'Company',
        location: '',
        apply_link: '',
        description: '',
      },
    } as Field,
    jobs_board_url: { type: 'text', label: 'Jobs board URL' },
  },
  defaultProps: {
    header_title: 'Job of the week',
    jobs: [],
    jobs_board_url: 'https://go.mlops.community/NL_Jobs_Board',
  },
  Component: ({
    header_title = 'Job of the week',
    jobs,
    jobs_board_url = 'https://go.mlops.community/NL_Jobs_Board',
  }) => {
    const list = Array.isArray(jobs) ? jobs : [];
    return (
      <Section
        style={{
          backgroundColor: '#d7d7d7',
          borderRadius: '15px',
          width: '650px',
          maxWidth: '650px',
          margin: '0 auto',
          color: '#000',
          paddingTop: '5px',
        }}
      >
        <Text
          style={{
            margin: 0,
            padding: '20px 20px 0',
            color: '#000',
            fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
            fontSize: '17px',
            lineHeight: 1.2,
          }}
        >
          <strong>💡{header_title}</strong>
        </Text>

        {list.map((job, i) => (
          <Section key={i}>
            <Text style={{ margin: 0, padding: '20px 15px 0 20px', fontSize: '16px', color: '#555', lineHeight: 1.5 }}>
              <strong>
                <Link href={job.apply_link} style={LINK}>
                  {job.job_title}
                </Link>
                {' // '}
                {job.company}
                {job.location ? ` (${job.location})` : ''}
              </strong>
            </Text>
            {job.description ? (
              <div
                style={{ padding: '8px 15px 0 20px', fontSize: '16px', color: '#555', lineHeight: 1.5 }}
                dangerouslySetInnerHTML={{ __html: normalizeRichText(job.description) }}
              />
            ) : null}
            {i < list.length - 1 ? <Hr style={DIVIDER_STYLE} /> : null}
          </Section>
        ))}

        <Hr style={DIVIDER_STYLE} />

        <Text style={{ margin: 0, padding: '10px 15px 10px 20px', fontSize: '16px', color: '#555', lineHeight: 1.5 }}>
          {'Find more roles on our new '}
          <strong>
            <Link href={jobs_board_url} style={LINK}>
              jobs board
            </Link>
          </strong>
          {' - and if you want to post a role, get in touch.'}
        </Text>
      </Section>
    );
  },
};
