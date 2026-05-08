// @ts-nocheck — vitest types resolved at workspace install time
/**
 * tsx-decomposer — verify the parser handles the AST patterns the
 * Barebone templates lean on (Tailwind/Html/Body/Container wrappers,
 * Section + Row + Column + Img + Heading + Text + Button JSX,
 * conditional `{x ? <foo/> : null}` renders).
 */
import { describe, expect, it } from 'vitest';
import { decomposeBareboneTsx } from '../parse.js';

describe('decomposeBareboneTsx', () => {
  it('strips Tailwind/Html/Body wrappers and emits the Section subtree', () => {
    const src = `
      import { Body, Container, Heading, Html, Section, Tailwind, Text } from '@react-email/components';
      export const MyEmail = () => (
        <Tailwind config={cfg}>
          <Html>
            <Body>
              <Container>
                <Section style={{ padding: '20px', backgroundColor: '#F3F4F6' }}>
                  <Heading as="h1" style={{ textAlign: 'center' }}>Hello</Heading>
                  <Text>Welcome to the show.</Text>
                </Section>
              </Container>
            </Body>
          </Html>
        </Tailwind>
      );
      export default MyEmail;
    `;
    const out = decomposeBareboneTsx(src);
    expect(out.warnings).toEqual([]);
    expect(out.blocks).toEqual([
      {
        type: 'section',
        props: {
          padding: '20px',
          background: '#F3F4F6',
          align: 'left',
          rounded: '0',
          children: [
            { type: 'heading', props: { text: 'Hello', level: 'h1', align: 'center' } },
            { type: 'text', props: { text: 'Welcome to the show.', align: 'left' } },
          ],
        },
      },
    ]);
  });

  it('unwraps a single top-level Container so the editor sees Sections directly', () => {
    const src = `
      import { Body, Container, Html, Section, Tailwind } from '@react-email/components';
      export const X = () => (
        <Tailwind><Html><Body>
          <Container>
            <Section style={{ padding: '10px' }} />
            <Section style={{ padding: '20px' }} />
          </Container>
        </Body></Html></Tailwind>
      );
      export default X;
    `;
    const out = decomposeBareboneTsx(src);
    expect(out.blocks.length).toBe(2);
    expect(out.blocks[0].type).toBe('section');
    expect(out.blocks[1].type).toBe('section');
  });

  it('extracts Img src/alt/width', () => {
    const src = `
      import { Body, Container, Html, Img, Section, Tailwind } from '@react-email/components';
      export default () => (
        <Tailwind><Html><Body><Container><Section>
          <Img src="https://cdn.example.com/hero.png" alt="Hero" width={520} />
        </Section></Container></Body></Html></Tailwind>
      );
    `;
    const out = decomposeBareboneTsx(src);
    const sec = out.blocks[0];
    expect(sec.type).toBe('section');
    const children = sec.props.children as Array<{ type: string; props: Record<string, unknown> }>;
    expect(children[0]).toEqual({
      type: 'img',
      props: { src: 'https://cdn.example.com/hero.png', alt: 'Hero', width: '520', align: 'center' },
    });
  });

  it('extracts Button text + href', () => {
    const src = `
      import { Body, Button, Container, Html, Section, Tailwind } from '@react-email/components';
      export default () => (
        <Tailwind><Html><Body><Container><Section>
          <Button href="https://example.com/dash">Open dashboard</Button>
        </Section></Container></Body></Html></Tailwind>
      );
    `;
    const out = decomposeBareboneTsx(src);
    const children = out.blocks[0].props.children as Array<{ type: string; props: Record<string, unknown> }>;
    expect(children[0]).toEqual({
      type: 'button',
      props: { button_text: 'Open dashboard', button_url: 'https://example.com/dash' },
    });
  });

  it('unwraps `{cond ? <foo/> : null}` to its truthy branch', () => {
    const src = `
      import { Body, Container, Heading, Html, Section, Tailwind } from '@react-email/components';
      export default ({ subtitle }) => (
        <Tailwind><Html><Body><Container>
          <Section>
            {subtitle ? <Heading as="h2">Conditional</Heading> : null}
          </Section>
        </Container></Body></Html></Tailwind>
      );
    `;
    const out = decomposeBareboneTsx(src);
    const children = out.blocks[0].props.children as Array<{ type: string; props: Record<string, unknown> }>;
    expect(children[0].type).toBe('heading');
    expect(children[0].props.text).toBe('Conditional');
  });

  it('emits a warning + Section placeholder for unknown components', () => {
    const src = `
      import { Body, Container, Html, Section, Tailwind } from '@react-email/components';
      function HelperBullet() { return null; }
      export default () => (
        <Tailwind><Html><Body><Container>
          <Section>
            <HelperBullet />
          </Section>
        </Container></Body></Html></Tailwind>
      );
    `;
    const out = decomposeBareboneTsx(src);
    expect(out.warnings.some((w) => w.includes('HelperBullet'))).toBe(true);
    const children = out.blocks[0].props.children as Array<{ type: string }>;
    expect(children[0].type).toBe('section');
  });

  it('preserves multi-line text via {var} interpolation as `{var}` placeholder', () => {
    const src = `
      import { Body, Container, Heading, Html, Section, Tailwind } from '@react-email/components';
      export default ({ companyName }) => (
        <Tailwind><Html><Body><Container>
          <Section>
            <Heading as="h1">Welcome to {companyName}</Heading>
          </Section>
        </Container></Body></Html></Tailwind>
      );
    `;
    const out = decomposeBareboneTsx(src);
    const children = out.blocks[0].props.children as Array<{ type: string; props: { text?: string } }>;
    expect(children[0].props.text).toBe('Welcome to {companyName}');
  });
});
