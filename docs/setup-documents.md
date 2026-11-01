# Documents and invoices

Zimpoen and the Accountant make PDFs with `make_pdf`: invoices, quotes, receipts, letters, reports. The agent writes the
document as HTML and a headless Chromium on the server prints it. The PDF appears in the chat to download. Nothing is
ever sent anywhere.

## 1. Chromium

The server looks for Chrome or Chromium at the usual paths (`/usr/bin/chromium`, `/usr/bin/chromium-browser`,
`/usr/bin/google-chrome`, ...). Install one, or point `ASSISTANT_CHROMIUM_PATH` at it:

```bash
sudo apt install chromium      # Debian/Ubuntu; or install Google Chrome
```

Without one the server still starts, logs `[documents] no Chrome or Chromium found`, and `make_pdf` says what to install.

The page is printed with **scripts off and the network off**: images must be files in `<data>/templates` (`src="logo.png"`)
or `data:` URLs. A browser starts for each document and closes after it.

## 2. Templates (optional)

An agent can design every document from scratch. To keep a design, ask it to save one ("save this as my invoice
template"): it becomes `<data>/templates/<name>.html`, with Mustache fields for what changes:

```html
<!-- description: Monthly invoice to Acme -->
<h1>Invoice {{number}}</h1>
<p>Bill to {{client.name}}</p>
<table>
  {{#items}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/items}}
</table>
```

Keep as many templates as you like. You can also put your own files in that folder; edits take effect immediately. A
field the data doesn't have is an error that names it, never a blank. Values are HTML-escaped.

## 3. Numbers

`next_number` takes the next number of a series (`invoice`, `quote`, `receipt`...) **for good**, in a transaction: a
number is never given twice. A new series starts at 1 with `INV-{YYYY}-{seq:03}`. To change the pattern or continue
from documents made by hand, say "my next invoice is number 14" (`set_number_series`). Pattern fields: `{YYYY}`, `{YY}`,
`{MM}` (of the day the number is taken) and `{seq}` or `{seq:03}`.

The `invoice` series continues from the old invoice module's counter. Its tables (`invoice_profile`, `invoice_issued`)
and the PDFs in `workspace/invoices/` are kept as they were.

## Verify

Ask the Accountant for a draft invoice with two line items. A PDF appears in the chat, and `workspace/documents/` has it.
