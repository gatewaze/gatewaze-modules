-- Add AI Summary block template to all existing template collections.
-- This block supports ai_content field type with prompt/output/chat tabs.

INSERT INTO newsletters_block_templates (
  id, collection_id, name, block_type, description, content, sort_order, is_active
)
SELECT
  gen_random_uuid(),
  tc.id,
  'AI Summary',
  'ai_summary',
  'AI-generated content section with configurable prompt and output editor',
  jsonb_build_object(
    'html_template', '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding: 20px 40px;">{{#section_title}}<h2 style="font-size: 22px; font-weight: bold; color: #1a1a2e; margin: 0 0 16px;">{{section_title}}</h2>{{/section_title}}<div style="font-size: 16px; line-height: 1.6; color: #1a1a2e;">{{ai_body}}</div></td></tr></table>',
    'rich_text_template', '{{#section_title}}<h2>{{section_title}}</h2>{{/section_title}}
{{ai_body}}',
    'has_bricks', false,
    'schema', jsonb_build_object(
      'type', 'object',
      'properties', jsonb_build_object(
        'section_title', jsonb_build_object(
          'type', 'string',
          'title', 'Section Title'
        ),
        'ai_body', jsonb_build_object(
          'type', 'string',
          'format', 'ai_content',
          'title', 'Content',
          'x-ai-config', jsonb_build_object(
            'systemPrompt', 'You are writing a section for a newsletter. Write engaging, informative content about the given topic. Use clear headings, bullet points where appropriate, and keep the tone professional yet accessible.',
            'maxTokens', 2000
          )
        )
      )
    )
  ),
  3,
  true
FROM newsletters_template_collections tc
WHERE NOT EXISTS (
  SELECT 1 FROM newsletters_block_templates bt
  WHERE bt.collection_id = tc.id AND bt.block_type = 'ai_summary'
);
