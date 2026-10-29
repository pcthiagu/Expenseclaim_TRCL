const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

const TEMPLATES_DIR = path.join(__dirname, "../../templates/pdf");
const DEFAULT_TEMPLATE_FILE = "_default.html";

Handlebars.registerHelper("currency", (value) => {
  const n = Number(value || 0);
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

Handlebars.registerHelper("eq", (a, b) => a === b);

Handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));

// Item 10.1: templates live in a plain server folder, one HTML file per
// transaction type. Adding a new type = adding a new file here — no code
// change, no rebuild. Compiled templates are cached in memory but the
// cache key includes the file's mtime, so an edited/added template is
// picked up on the very next PDF generation without restarting the server.
const compiledCache = new Map(); // filePath -> { mtimeMs, compiled }

function templateFilePathFor(transactionType) {
  const safeName = `${transactionType}.html`;
  return path.join(TEMPLATES_DIR, safeName);
}

function loadTemplate(transactionType) {
  let filePath = templateFilePathFor(transactionType);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(TEMPLATES_DIR, DEFAULT_TEMPLATE_FILE);
  }

  const stat = fs.statSync(filePath);
  const cached = compiledCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.compiled;
  }

  const source = fs.readFileSync(filePath, "utf8");
  const compiled = Handlebars.compile(source);
  compiledCache.set(filePath, { mtimeMs: stat.mtimeMs, compiled });
  return compiled;
}

// `details` is exactly the shape usp_GetApprovalRequestDetails returns —
// the same data the "View PDF" popup and Details tab already use, so the
// generated PDF can never drift from what the app itself shows.
function renderHtml(details) {
  const transactionType = details?.requestInfo?.transactionType || "General Approval";
  const template = loadTemplate(transactionType);
  return template(details);
}

module.exports = { renderHtml, TEMPLATES_DIR };
