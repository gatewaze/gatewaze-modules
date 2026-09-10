# Event Seating

Arrange the guests who accepted their invite around tables on a canvas. Tables
are dragged into place to match the room, and names are dragged from the guest
list onto individual seats, so you can see exactly who sits next to whom.

This is a working tool rather than a design tool. The export is a plain, legible
snapshot of the arrangement, meant for the venue, the caterer and for writing
place cards. A final decorated plan is normally produced elsewhere.

## How it works

### Layouts

Each event holds as many **layouts** as you want, shown as tabs across the top.
A layout is one canvas with its own tables, its own seating and its own
exports, so you can try three arrangements of the same room side by side and
compare them.

The **+** button copies the current layout's tables into a new one with the
seats left empty, which is usually what you want when trying a variation.
**Duplicate with seating** copies where everyone is sitting too, for when you
only mean to nudge one table. **Empty** starts from a blank canvas.
Double-click a tab to rename it.

A layout belongs to one event. If the event has sub-events
(from the Event Invites module), a plan can be tied to one of them, so a wedding
with a day event and an evening event gets a separate plan for each, each with
its own guest list. A plan not tied to a sub-event draws on everyone invited to
the event itself.

Layouts are how you keep alternatives around without losing the one you have.

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

**The plan is drawn at real scale: one unit is one centimetre.** Tables are
the size the venue's tables actually are, so a room that looks full is full,
and a scaled floor plan behind the tables lines up with them.

Set the room to your venue's dimensions with the **Room** boxes in the toolbar
(in metres). The default is 14 × 9m.

Add a table from the **Add a table** menu, which carries the sizes tables are
actually hired in:

| Rectangular, guests opposite | Round | Top table |
|---|---|---|
| 2 · 70 × 70cm square | 6 · 122cm (4ft) | 4 along one side |
| 4 · 120 × 75cm | 8 · 152cm (5ft) | 6 along one side |
| 6 · 180 × 85cm | 10 · 168cm (5ft 6) | 8 along one side |
| 8 · 240 × 90cm | 12 · 183cm (6ft) | 10 along one side |
| 10 · 300 × 90cm | | |
| 12 · 360 × 90cm | | |

The larger rectangles continue at 60cm of table edge per guest, which is where
the 6ft six-seater and 8ft eight-seater come from. Any table can still be
resized by hand in the table panel, in centimetres.

### Elbow room

Every guest needs **60cm to themselves**, measured centre to centre between
seats, so a table cannot be given more seats than its size supports. The table
panel shows what the current dimensions fit, and asking for more is refused
with the number it will take. Shrinking a table below what its existing seats
need is refused the same way, rather than quietly dropping seats and unseating
someone.

The limit is worked out from where the seats actually land, not from a formula
per shape, so it holds for round tables, banquet rows and top tables alike. It
also means a rectangle seats one more than its name suggests if you put someone
on the end: a 180cm six-seater takes three a side at exactly 60cm, and a
seventh on the end who has 88cm of clearance. The eighth is refused, because
that would be four a side at 45cm.

A table has a shape (round or rectangular), a size, a rotation and a seat count.
Seat positions are worked out from those, never stored, so changing the seat
count or turning a table rearranges its seats immediately.

Rectangular tables offer four arrangements:

- **All the way round** — seats spread evenly over the whole perimeter, in
  proportion to edge length.
- **Both long sides** — banquet style, with nobody on the ends.
- **Equal sides, odd one at the end** — the same number down each long side so
  guests sit directly opposite one another, with any odd seat at the far end.
  A nine-seater reads 4 / 4 / 1. Use this when "all the way round" leaves the
  two sides uneven and nobody lines up.
- **One side** — a top table, where everyone faces the room.

Seats are numbered from the top of the table, clockwise, which is how a printed
plan reads.

### Seat numbers

By default every seat in the room is numbered once — 1 up to however many
places are laid — rather than each table starting again at 1.

This matters as soon as tables are pushed together. A U shape built from eleven
tables, covered with linen and joined, is one table to the people serving it:
the table names are invisible, and eleven seat 1s identify nothing. A number
that is unique across the room is the only thing a waiter can act on.

Numbering follows the way the room gets served. Tables pushed together are
treated as one run, and its seats are numbered as a walk: **round the outside
first** — up one arm, across the top, down the other — **then back along the
inside the other way**, up the far arm, across the top and down the near one.
Neighbouring numbers are therefore neighbouring seats.

A table standing on its own is numbered from the top, clockwise, as before, and
several separate tables are taken in reading order — top row left to right,
then the next row down.

Because the walk passes a joined table's outer seats on the way round and its
inner seats on the way back, one table's numbers are deliberately not
consecutive. That is the point: the numbers follow the room, not the furniture.
Seats taken out of use are skipped, so the last number is the number of places
laid.

If your room is separate round tables, "Table 4, seat 3" reads perfectly well;
switch **Seat numbers** in the toolbar to *Restart on each table*.

### Tables pushed together

Tables get arranged into U shapes, horseshoes and long banks, and where two
tables meet the seats on the touching edges cannot be sat in. Take a seat out
of use by unticking it in the table panel, or alt-clicking it on the plan.

A seat out of use is not drawn, cannot be dropped on, and does not count
towards the table's capacity, so "4/6 seated" always reflects real places. The
numbering closes up rather than leaving holes: block two seats on an eight-
seater and the remaining six read 1 to 6, on the plan and in every export.
Underneath, the seat keeps its original position, so bringing it back into use
restores the table exactly as it was.

Blocking a seat somebody is sitting in returns them to the guest list first —
better than a guest who exists in the data but appears nowhere on the plan. The
database refuses to seat anyone in a blocked seat, so it cannot happen by
another route either.

### Moving people around

- Drag a table to move it and its seats together. With **Snap** on, a table
  lines itself up with its neighbours: edges flush, centres in line, or butted
  right up against another table, with a guide line showing what it caught.
  Each direction is decided separately, so a table can sit against one
  neighbour while lining up with another. Anything not near a neighbour falls
  back to the grid. Turn Snap off in the toolbar for free placement.
- Drag a name from the guest list onto a seat to seat them.
- Drag a seated guest onto another seat to move them. If that seat is taken, the
  two guests swap.
- Drag a seated guest anywhere off a seat to return them to the guest list.
- Right-click a seat to empty it.
- Drag the canvas itself to move around the plan — useful once zoomed in.
  A click on bare canvas with no drag clears the selection.
- **Shift-drag across the canvas** to rubber-band a selection: every table the
  box touches is taken. Drag any one of them to move the whole group, keeping
  its arrangement. Shift-click a table to add it to the selection or drop it.
- Select a table and press Backspace or Delete to remove it — or several, to
  remove them all. Tables with guests in them ask first; empty ones just go.
- Press Escape to cancel a drag in progress.

The board opens showing the whole plan. Zoom in with the **+ / −** controls in
the corner, or hold Ctrl (Cmd on a Mac) and scroll — zooming follows the
cursor, so the part you are pointing at stays put. Above the fit level the
board scrolls; the percentage button resets it. Names on seats become readable
from about 150%.

Every change saves as you make it. Table geometry saves on a short delay so that
dragging stays smooth.

### Undoing

The arrows in the toolbar step back and forward, as do **Ctrl+Z** and
**Ctrl+Shift+Z** (**⌘Z** and **⇧⌘Z** on a Mac; Ctrl+Y also redoes). Hovering an
arrow says what it will undo — "Undo move 3 tables".

Everything on the board is covered: moving tables, adding and deleting them,
changing a table's shape or size, taking seats out of use, seating and
unseating guests. A burst of related edits counts as one step, so typing a
table name is a single undo rather than one per letter, and dragging a bank of
tables across the room is one step rather than one per frame.

Pressing Ctrl+Z while the cursor is in a text box does what it always does —
undoes your typing — rather than reaching for the plan.

History belongs to the layout tab you are on and lasts as long as the page is
open. Switching tabs or reloading starts it fresh; the plan itself is saved
either way.

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

**Meal sheets** produces the document the venue actually needs. It opens with a
map of the room showing every seat number, so a place can be found from its
number alone. Then pick which RSVP questions count as courses — anything that
looks like one is preselected — and each becomes its own sheet listing every
seated guest by seat number with their choice. Each sheet opens with a total per option for the
kitchen ("24 x Salmon"), and a seat with no answer recorded is marked rather
than left blank, so nothing is missed quietly. A course with more guests than
fits one page continues onto the next.

Every layout exports independently, so you can send the venue the arrangement
you settled on without deleting the ones you rejected.

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
