# gatewaze-template-newsletter

Default newsletter boilerplate for the gatewaze newsletters module (canonical home: `github.com/gatewaze/gatewaze-template-newsletter`).

When a new newsletter list is created without an external git URL, this template is cloned at the pinned tag into the list's internal git repo. The first commit is pushed and the list's `wrapper_id` defaults to the `default` wrapper.

## Marker grammar

Each block + wrapper file declares itself via marker comments at the top:

```mjml
<!-- @gatewaze:block name="hero" category="hero" description="Headline + subheadline + image" -->
<mj-section>
  <mj-column>
    <mj-text font-size="32px" font-weight="700">{{headline}}</mj-text>
    <mj-text>{{subheadline}}</mj-text>
  </mj-column>
</mj-section>
```

```mjml
<!-- @gatewaze:wrapper name="default" role="site" -->
<mjml>
  <mj-body background-color="{{theme.colors.background}}">
    <!-- header -->
    {{>page_body}}
    <!-- footer -->
  </mj-body>
</mjml>
```

## Variables

Block templates use `{{variable}}` placeholders for editor content + merge tags:

- Block-level variables: filled in by the editor (`{{headline}}`, `{{button_label}}`, etc.)
- Theme tokens: `{{theme.colors.primary}}`, `{{theme.typography.heading_font}}`
- Recipient merge tags: `{{first_name}}`, `{{last_name}}` — left intact in the rendered HTML committed to git (per spec §15.3 PII boundary); ESP fills them at send time

## Local preview

```sh
pnpm install
pnpm build
pnpm preview
```

## License

Apache-2.0
