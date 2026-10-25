# Setting up the monthly invoice

The Accountant makes your monthly invoice from **your own template**: an HTML file with fields it fills in (client, number, dates,
amount). The result is a PDF in the chat to download. **It is never sent anywhere**: you send it yourself.

## 1. Drop in your template

At its first start the server writes a clean default to `<data>/templates/invoice.html` (`data/templates/` in production,
`data-dev/templates/` in `pnpm dev`; the log says `[invoices] wrote the default invoice template to ...`). It never overwrites a
file that is there, and it reads the file fresh for every invoice, so an edit takes effect at once, without a restart.

To use your own layout: edit that file, or replace it with yours, and put any images it uses (a logo) in the same folder. The
Accountant cannot read or change this folder; only you can.

Your existing invoice is probably a PDF or a Word file. Recreate its layout once as HTML, starting from the default (`h1`, a
`table` for the columns, a `table` for the line items), and replace each thing that changes every month by a field from the
table below. For two columns side by side (your details left, the invoice number and dates right) use a one-row `table`.

## 2. Tell the Accountant what stays the same

In the Accountant's chat, in your own words ("my invoices go to Acme Pte Ltd at 12 Main Street, usually Nu. 50,000 for consulting,
payment within 14 days, my bank is ..."). It saves them with `set_invoice_profile`; you can change any of them later the same way.

| Setting | What it is |
| --- | --- |
| client name, client address | who the invoice is addressed to (several lines are fine) |
| sender name, sender details | you, as the invoice shows it |
| description | the line you charge for; `{period}` (October 2026), `{month}` and `{year}` are replaced: `Consulting services for {period}` |
| amount, currency | the usual amount (BTN unless you say otherwise); "make it Nu. 42,500 this month" changes one invoice only |
| payment terms | days from the issue date until payment is due (default 30) |
| payment details | how to pay: bank, account number |
| notes | a line printed on every invoice |
| numbering pattern, next number | see below |

Then: "make my October invoice". The Accountant calls `generate_invoice`, and the card in the chat has a **Download PDF** button.
A month that already has an invoice is refused unless you say you want another one (it then gets a new number).

## 3. Numbers

The default pattern is `INV-{YYYY}-{seq:03}`, which makes `INV-2026-001`, `INV-2026-002`, ... `{YYYY}`, `{YY}` and `{MM}` are the
year and month of the issue date; `{seq}` is the running number and `{seq:03}` pads it with zeros (`{seq:5}` to five digits).
Everything else must be a letter, a digit, or one of `. _ # -`, because the number is also the file's name; the pattern must
contain `{seq}` exactly once.

A number is used **once, ever**: it is taken in the same transaction that records the invoice, and a template that fails uses none.
If you have already sent invoices by hand, tell the Accountant "my next invoice is number 14" (`next_number`). Going back onto a
number that was used is refused when an invoice is made.

Every real invoice takes a number, but a **preview** does not. To try a template (or to look at an invoice before it is made), ask
the Accountant for a preview ("show me a preview of this month's invoice"): it makes the PDF the same way, writes PREVIEW across
every page, takes no number, records nothing and says what the next real invoice will be called. You can ask as often as you like,
also for a month that has an invoice already, and edit the template in between. Previews are kept in
`<data>/workspace/invoices/previews/`, one per request; nothing needs them once you have looked, so the folder may be emptied.

## 4. The fields

`{{field}}` is replaced by the value, **escaped** (a client called `A & B <Ltd>` prints as written). Fields ending in `_html` are
already escaped by the program and keep their line breaks as `<br>`: write them with three braces, `{{{notes_html}}}`.
**Use three braces only on fields that end in `_html`.** On any other field `{{{client.name}}}` prints the text as markup: a client
name that holds `<img ...>` or `<a ...>`, which the assistant took from a message or a file, would be laid out as a picture or a link
instead of being printed as it is.
`{{#field}}...{{/field}}` shows its content only when the field is not empty (`{{^field}}...{{/field}}` when it is), and a list
repeats its content for each entry. Anything that is not in this table is an error that says so (it does not print blank).

| Field | Example |
| --- | --- |
| `invoice.number` | `INV-2026-001` |
| `invoice.period`, `invoice.month`, `invoice.year` | `October 2026`, `October`, `2026` |
| `invoice.issue_date`, `invoice.due_date` | `25 October 2026`, `24 November 2026` |
| `invoice.issue_date_iso`, `invoice.due_date_iso` | `2026-10-25`, `2026-11-24` |
| `invoice.terms_days` | `30` |
| `invoice.description` | `Consulting services for October 2026` |
| `invoice.reference` | a purchase order number, empty unless given |
| `invoice.notes`, `invoice.notes_html` | the note, empty unless set |
| `invoice.amount`, `invoice.amount_plain` | `Nu. 50,000.00`, `50,000.00` |
| `invoice.currency`, `invoice.currency_label` | `BTN`, `Nu.` |
| `sender.name`, `sender.details`, `sender.details_html` | you |
| `sender.lines` | list: one entry per line of the details, written `{{.}}` |
| `client.name`, `client.address`, `client.address_html` | the client |
| `client.lines` | list, as `sender.lines` |
| `payment_details`, `payment_details_html` | how to pay |
| `lines` | list with one entry, with `description`, `quantity` (`1`), `unit_price`, `amount` |
| `total` | `Nu. 50,000.00` |

```html
{{#client.lines}}<div>{{.}}</div>{{/client.lines}}
{{#lines}}<tr><td>{{description}}</td><td align="right">{{amount}}</td></tr>{{/lines}}
```

## 5. What the layout understands

The PDF is laid out by a small renderer (pdfkit, pure JavaScript, no browser), so it is a subset of HTML. It never runs anything:
`<script>` and `<style>` are dropped, and a tag it does not know is skipped with its text kept.

- **Tags:** `h1` `h2` `h3` `h4`, `p`, `div`, `section`, `header`, `footer`, `address`, `hr`, `br`, `ul` `ol` `li`, `table` `thead` `tbody`
  `tfoot` `tr` `th` `td`, `b` `strong` `i` `em` `u` `small` `span`, `a` (links to `http`, `https` and `mailto` only), `img`.
- **Attributes:** `align`, `width`, `colspan`, `bgcolor`, and `border` on a table.
- **`style` properties:** `text-align`, `font-size`, `font-weight`, `font-style`, `text-decoration`, `color`, `background` /
  `background-color`, `width`, `margin` (top and bottom), `padding`, `border` and `border-top` / `-bottom` / `-left` / `-right`;
  units `px`, `pt`, `mm`, `cm`, `in`, `em`, `%`. Colours are `#rgb`, `#rrggbb`, `rgb(...)` and a few names.
- **Not supported:** classes and stylesheets, floats, flexbox and grid, `position`, web fonts, SVG, `rowspan`. Use a `table` for columns.
- **Page:** A4 by default; `<meta name="page-size" content="Letter">` for Letter. Margins are 17 mm. Long content continues on
  the next page, and a table row is never split between pages.
- **Images:** PNG or JPEG, `<img src="logo.png" width="120">`: a file in the templates folder (links are resolved, and a file
  outside the folder is refused), or a `data:image/png;base64,...` URI. A web address is refused: nothing is fetched.
- **Text:** the PDF uses the standard Helvetica fonts, which can draw Latin letters with accents and the usual punctuation (`€`,
  quotes, dashes). `₹` is written `Rs.`. **Any other script (Dzongkha, Devanagari) prints as `?`** until a font is embedded.

## 6. When something goes wrong

The Accountant reads you the message; each says what is wrong and where.

| Message | Fix |
| --- | --- |
| `There is no invoice template at ...` | put `invoice.html` in `<data>/templates/` |
| `... uses {{invoice.numer}}, which is not a field` | fix the name; the message lists every field |
| `... has a mistake: Unclosed section "lines"` | a `{{#x}}` needs its `{{/x}}` |
| `The image 'logo.png' ... is not in the templates folder` | put the file there |
| `There is no amount` / `no invoice profile with a client yet` | tell the Accountant the client and the amount |
| `The number INV-2026-002 was already used` | raise the number: "my next invoice is number 5" |

A template that fails makes no invoice and uses no number.
