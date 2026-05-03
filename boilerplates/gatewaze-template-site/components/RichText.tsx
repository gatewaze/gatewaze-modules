/* @gatewaze:block name="rich-text" category="content" description="Rich text content with markdown support" */

interface RichTextProps {
  /** @gatewaze:format richtext */
  body: string;
}

export function RichText(props: RichTextProps) {
  return <div className="prose prose-neutral max-w-none" dangerouslySetInnerHTML={{ __html: props.body }} />;
}
