# Social Posts

Social Posts writes LinkedIn post drafts from your curated content. You pick
one or more published items, pick a format, and the AI writes the post. You
can edit it, write it again, copy it, and save it as a draft. Nothing is
posted to LinkedIn. You copy the text and post it yourself.

## What counts as curated content

The list shows items whose publish state is `published`, which is what the
Content Inbox sets when an editor approves an item. An item must also be
public by its own module's rule, because an admin's draft can carry the
`published` publish state without going through the Inbox. It reads these
tables when their modules are installed:

| Type | Table | Also required | Link used in the post |
| --- | --- | --- | --- |
| Blog posts and articles | `blog_posts` | status `published`, visibility `public` | `canonical_url`, else the portal's `/blog/<slug>` |
| Videos | `videos` | status `published`, visibility `public` | `url` |
| Events (from 90 days ago onwards) | `events` | listed | `event_link`, else the portal's `/events/<slug>` |
| Resources, such as conference recaps | `sr_items` | status `published` | `external_url`, else the portal's `/resources/<collection>/<slug>` |

A members-only item is still offered. Check that its content can go in a
public post before you use it.

Posts from content-sources feeds land in `blog_posts`, so they show here once
they are approved. Portal links need `SITE_URL` (or `PORTAL_URL`) set on the
api. A type whose module is not installed is left out of the list.

## Writing a post

1. Open **Social Posts** in the sidebar, or its card on the Marketing OS page.
2. Tick the items to write about. The post covers them in the order you tick.
3. Pick a format:
   - **Announcement**: news in one to three items.
   - **Event promo**: why to attend, when and where, and the link.
   - **Weekly roundup**: one short entry per item, for two to ten items.
   - **Article share**: one article with a point of view.
   - **Conference recap**: the headline takeaway and the themes.
4. Add extra direction if you want, for example "Registration closes Friday."
5. Click **Generate**. The post has a hook line, short paragraphs, every
   item's link, and three to five hashtags at the end.
6. Edit the text. The box under it shows what LinkedIn shows before "see
   more". The counter turns orange past 1,300 characters and red past
   LinkedIn's 3,000 limit. A warning appears if the post has a link or an
   @mention that did not come from the picked items. The items are scraped
   from the web, so check those before you post.
7. **Copy** it, or **Save draft** / **Save as ready**.

### Member mentions

When the content-keywords membership rules match an item to a member company,
the item shows a green "Member" badge and the AI may mention that company as
`@Name` in the post. The names to tag are listed under the post. When you
save, the module works out the mentions again from the text and the items'
member matches, so it only records companies the rules matched. LinkedIn only
links a mention you pick from its own menu, so type the `@` again on LinkedIn
when you paste the post.

## Drafts

The **Drafts** tab lists saved drafts with their status: Draft, Ready, or
Archived. Each draft keeps the items it was written from, with their title and
link as they were when you saved it. Open a draft to edit it or write it again.
The `scheduled` and `posted` statuses are reserved for a later version that
posts to LinkedIn, and a draft in either state can't be edited here.

## AI and cost

Generation runs through the AI module under the use case
`social-posts-linkedin` (Settings → AI). That row sets the model
(`claude-sonnet-5` by default), the allowed models, and a daily cost cap of
$2.00. Every call is recorded in the AI usage ledger. Each admin can generate
at most 10 posts a minute. The AI writes only from the items you picked; it has
no web search.

## Turning it on and off

Enable or disable **Social Posts** in Settings → Modules. It needs the `ai` and
`content-platform` modules. To show it inside an embedding platform such as
LFX, add `social-posts` to the deployment's `ADMIN_EMBED_MODULES`. To put it on
the Marketing OS page, add the card `module.social-posts..social-posts` in
Settings → Navigation.

## API

All routes need an admin's bearer token.

- `GET /api/admin/social-posts/pool?types=&q=&limit=` lists curated items.
- `POST /api/admin/social-posts/generate` writes a post from
  `{ platform, format, items: [{ content_type, content_id }], instructions }`.
- `GET /api/admin/social-posts/drafts?status=` lists drafts.
- `GET /api/admin/social-posts/drafts/:id` returns one draft with its sources.
- `POST /api/admin/social-posts/drafts` saves a draft.
- `PATCH /api/admin/social-posts/drafts/:id` changes `body`, `format`,
  `status` or `hashtags`. Send `regenerated: true` with `ai_model` after a
  regenerate.
