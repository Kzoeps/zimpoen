# Monthly invoice

The Accountant fills **your own HTML template** and gives you a PDF to download. It never sends the invoice anywhere.

## 1. Template

On first start the server writes a default to `<data>/templates/invoice.html`. It never overwrites that file, and it
re-reads it for every invoice, so edits take effect immediately. Put any images (such as a logo) in the same folder.
Agents can't read or change this folder.

To match your existing invoice, rebuild it once in HTML starting from the default, and replace each value that changes
with a field (see below). Use `<table>` for columns.

## 2. Profile

Tell the Accountant the details that stay the same, in plain words: "invoices go to Acme Pte Ltd, 12 Main St, usually
Nu. 50,000 for consulting, due in 14 days, my bank is …". It saves them with `set_invoice_profile`.

| Setting | Notes |
|---|---|
| Client name, address | Several lines are fine |
| Sender name, details | You |
| Description | `{period}`, `{month}` and `{year}` are filled in, for example `Consulting for {period}` |
| Amount, currency | Defaults to BTN. "Make it Nu. 42,500 this month" changes one invoice only |
| Payment terms | Days until due (default 30) |
| Payment details, notes | Printed on every invoice |
| Numbering pattern, next number | See below |

Then ask for an invoice: "make my October invoice". A second invoice for the same month is refused unless you ask for
another one.

## 3. Numbers

The default pattern is `INV-{YYYY}-{seq:03}`, which gives `INV-2026-001`. `{YYYY}`, `{YY}` and `{MM}` come from the issue
date. `{seq:N}` zero-pads to N digits. Only letters, digits and `. _ # -` are allowed, and `{seq}` must appear exactly
once.

Each number is used **once, ever**. A template that fails uses no number. To continue from invoices you sent by hand,
say "my next invoice is number 14".

**Previews** ("show me a preview of this month's invoice") render the same PDF with a PREVIEW watermark and take no
number. They're saved in `<data>/workspace/invoices/previews/`, which is safe to empty.

## 4. Fields

`{{field}}` inserts the value, HTML-escaped. Fields ending in `_html` keep line breaks; use them with three braces, as in
`{{{notes_html}}}`. **Only use three braces on `_html` fields.** On any other field, client-supplied text would be
rendered as markup.

`{{#x}}…{{/x}}` shows its content only if `x` is non-empty, and repeats it for a list. `{{^x}}…{{/x}}` shows it only if
`x` is empty. An unknown field is an error, not a blank.

| Field | Example |
|---|---|
| `invoice.number` | `INV-2026-001` |
| `invoice.period`, `.month`, `.year` | `October 2026`, `October`, `2026` |
| `invoice.issue_date`, `.due_date` | `25 October 2026` |
| `invoice.issue_date_iso`, `.due_date_iso` | `2026-10-25` |
| `invoice.terms_days` | `30` |
| `invoice.description` | `Consulting services for October 2026` |
| `invoice.reference` | PO number, if given |
| `invoice.notes`, `.notes_html` | |
| `invoice.amount`, `.amount_plain` | `Nu. 50,000.00`, `50,000.00` |
| `invoice.currency`, `.currency_label` | `BTN`, `Nu.` |
| `sender.name`, `.details`, `.details_html` | |
| `sender.lines`, `client.lines` | List of lines, written `{{.}}` |
| `client.name`, `.address`, `.address_html` | |
| `payment_details`, `payment_details_html` | |
| `lines` | List with `description`, `quantity`, `unit_price`, `amount` |
| `total` | `Nu. 50,000.00` |

```html
{{#client.lines}}<div>{{.}}</div>{{/client.lines}}
{{#lines}}<tr><td>{{description}}</td><td align="right">{{amount}}</td></tr>{{/lines}}
```

## 5. Supported HTML

The PDF comes from a small renderer (pdfkit), not a browser. Scripts never run, and unknown tags are skipped but keep
their text.

- **Tags:** `h1`–`h4`, `p`, `div`, `section`, `header`, `footer`, `address`, `hr`, `br`, `ul`, `ol`, `li`, `table`, `thead`,
  `tbody`, `tfoot`, `tr`, `th`, `td`, `b`, `strong`, `i`, `em`, `u`, `small`, `span`, `a` (http, https and mailto only), `img`.
- **Attributes:** `align`, `width`, `colspan`, `bgcolor`, and `border` on tables.
- **Styles:** `text-align`, `font-size`, `font-weight`, `font-style`, `text-decoration`, `color`, `background(-color)`,
  `width`, `margin` (top and bottom only), `padding`, `border(-*)`. Units: `px pt mm cm in em %`.
- **Not supported:** classes, stylesheets, flex, grid, floats, `position`, web fonts, SVG, `rowspan`.
- **Page:** A4, with 17 mm margins. Use `<meta name="page-size" content="Letter">` for Letter. Table rows never split
  across pages.
- **Images:** PNG or JPEG, either a file in the templates folder or a `data:` URI. Web URLs are refused.
- **Text:** standard Helvetica, which covers Latin text with accents. `₹` becomes `Rs.`. Other scripts, such as Dzongkha,
  print as `?`.

## 6. Errors

| Message | Fix |
|---|---|
| `There is no invoice template at …` | Put `invoice.html` in `<data>/templates/` |
| `… uses {{invoice.numer}}, which is not a field` | Fix the name. The message lists every valid field |
| `Unclosed section "lines"` | Every `{{#x}}` needs a matching `{{/x}}` |
| `The image 'logo.png' … is not in the templates folder` | Move the image into that folder |
| `There is no amount` / `no invoice profile with a client yet` | Tell the Accountant the client and the amount |
| `The number INV-2026-002 was already used` | "My next invoice is number 5" |
