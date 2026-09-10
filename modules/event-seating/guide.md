# Event Seating

Arrange the guests who accepted their invite around tables on a canvas. Tables
are dragged into place to match the room, and names are dragged from the guest
list onto individual seats, so you can see exactly who sits next to whom.

This is a working tool rather than a design tool. The export is a plain, legible
snapshot of the arrangement, meant for the venue, the caterer and for writing
place cards. A final decorated plan is normally produced elsewhere.

## How it works

### Plans

A **plan** is one canvas belonging to one event. If the event has sub-events
(from the Event Invites module), a plan can be tied to one of them, so a wedding
with a day event and an evening event gets a separate plan for each, each with
its own guest list. A plan not tied to a sub-event draws on everyone invited to
the event itself.

You can hold several plans for the same sub-event at once. Duplicating a plan
copies its tables, and optionally the seated guests too, which is the easy way
to try a different arrangement without losing the one you have.

### Guests

The guest list comes from the Event Invites module. A plan lists every party
member whose RSVP for that event or sub-event matches the plan's chosen
statuses. New plans include accepted guests only; tick the other statuses in the
toolbar to pencil in people who have not replied yet.

Guests stay grouped by their invite party in the list, which keeps couples and
families together while you place them. Anyone already seated is hidden unless
you ask to see them.

People who were never invited through the system — a photographer, the band, a
late addition — can be typed into the box at the bottom of the guest list and
placed on a seat as a plain name.

### Tables and seats

A table has a shape (round or rectangular), a size, a rotation and a seat count.
Seat positions are worked out from those, never stored, so changing the seat
count or turning a table rearranges its seats immediately.

Rectangular tables offer three arrangements:

- **All the way round** — seats spread evenly over the whole perimeter.
- **Both long sides** — banquet style, with nobody on the ends.
- **One side** — a top table, where everyone faces the room.

Seats are numbered from the top of the table, clockwise, which is how a printed
plan reads.

### Moving people around

- Drag a table to move it and its seats together. Snap to grid keeps rows tidy;
  turn it off in the toolbar for fine adjustments.
- Drag a name from the guest list onto a seat to seat them.
- Drag a seated guest onto another seat to move them. If that seat is taken, the
  two guests swap.
- Drag a seated guest anywhere off a seat to return them to the guest list.
- Right-click a seat to empty it.
- Press Escape to cancel a drag in progress.

Every change saves as you make it. Table geometry saves on a short delay so that
dragging stays smooth.

### Floor plan background

Upload the venue's floor plan as a PNG, JPEG, WebP or PDF and it renders behind
the tables at half opacity, so tables can be positioned against real walls,
doors and the dance floor. PDFs have their first page rendered. The background
can be hidden without removing it, and it is included in the export whenever it
is visible.

### Export

**PNG** gives a bitmap of the plan. **PDF** places the same image on an A3
landscape page. Both are drawn from the stored geometry rather than screenshot
from the screen, so the output matches what you arranged at full resolution.

## Data

| Table | Holds |
|---|---|
| `seating_plans` | One canvas: its size, grid, background and which RSVP statuses feed it |
| `seating_tables` | Each table's label, shape, size, rotation, position and seat count |
| `seating_assignments` | One guest in one seat; either an invited member or a free-text name |
| `seating_assets` | Uploaded floor plans, in the `event-seating` storage bucket |

The `seating_plan_roster` view flattens a plan into one row per seat, with the
guest's name and party, for anyone who wants the arrangement as a list rather
than a picture.

A guest can hold at most one seat per plan, and a seat at most one guest, both
enforced in the database rather than only in the interface.

## Requirements

Depends on the `events` and `event-invites` modules. Guests must be invited, and
have replied, through Event Invites before they appear here.
