/**
 * The invoice template the server writes to `<data>/templates/invoice.html` when there is none. It is a string here, not a
 * file next to the code, because the built server is one bundle that cannot read the package's files. The owner replaces it
 * with their own (`docs/setup-invoice.md`); the server never overwrites it.
 *
 * `{{field}}` is HTML-escaped text, `{{{field_html}}}` is text this program escaped itself, `{{#list}}...{{/list}}` repeats
 * for each entry and `{{#field}}...{{/field}}` shows its content only when the field is not empty.
 */
export const DEFAULT_INVOICE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="page-size" content="A4">
<title>Invoice {{invoice.number}}</title>
</head>
<body style="font-size: 10pt">

<table width="100%">
  <tr>
    <td width="58%">
      <h1 style="color: #1f3a5f">INVOICE</h1>
      <p><b>{{sender.name}}</b></p>
      {{#sender.lines}}<div>{{.}}</div>
      {{/sender.lines}}
    </td>
    <td width="42%" align="right">
      <p><small>Invoice number</small><br><b>{{invoice.number}}</b></p>
      <p><small>Issue date</small><br>{{invoice.issue_date}}</p>
      <p><small>Due date</small><br>{{invoice.due_date}}</p>
    </td>
  </tr>
</table>

<hr>

<p><small>Billed to</small></p>
<p><b>{{client.name}}</b></p>
{{#client.lines}}<div>{{.}}</div>
{{/client.lines}}
{{#invoice.reference}}<p style="margin-top: 6pt"><small>Reference</small> {{invoice.reference}}</p>{{/invoice.reference}}

<div style="margin-top: 18pt"></div>

<table width="100%">
  <tr bgcolor="#eef1f5" style="border-bottom: 1px solid #1f3a5f">
    <th align="left" width="52%">Description</th>
    <th align="center" width="10%">Qty</th>
    <th align="right" width="19%">Unit price</th>
    <th align="right" width="19%">Amount</th>
  </tr>
  {{#lines}}
  <tr style="border-bottom: 1px solid #dddddd">
    <td>{{description}}</td>
    <td align="center">{{quantity}}</td>
    <td align="right">{{unit_price}}</td>
    <td align="right">{{amount}}</td>
  </tr>
  {{/lines}}
</table>

<p align="right" style="margin-top: 10pt; font-size: 13pt"><b>Total due {{total}}</b></p>
<p align="right"><small>Payment due by {{invoice.due_date}} ({{invoice.terms_days}} days)</small></p>

{{#payment_details}}
<div style="margin-top: 18pt"></div>
<p><b>Payment details</b></p>
{{{payment_details_html}}}
{{/payment_details}}

{{#invoice.notes}}
<div style="margin-top: 12pt"></div>
<p><small>{{{invoice.notes_html}}}</small></p>
{{/invoice.notes}}

</body>
</html>
`;
