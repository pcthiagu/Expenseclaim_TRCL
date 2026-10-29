const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

const TEMPLATES_DIR = path.join(__dirname, "../../templates/pdf");
const DEFAULT_TEMPLATE_FILE = "_default.html";
// Register helpers once, at module load time
Handlebars.registerHelper("starDisplay", function (rating) {
  const r = Math.round(parseFloat(rating)) || 0;
  const clamped = Math.max(0, Math.min(5, r));
  return "★".repeat(clamped) + "☆".repeat(5 - clamped);
});

Handlebars.registerHelper("currency", (value) => {
    const n = Number(value || 0);

    return n.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
});

Handlebars.registerHelper("eq", (a, b) => a === b);

Handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));

/*
 * Template cache
 */
const compiledCache = new Map();

/*
 * Load template using the template filename
 * returned by PDF_gen_ApprovalRequests.HTML_TEMPLATE_NAME
 */
function templateFilePathFor(templateName) {

    const safeName = path.basename(templateName || DEFAULT_TEMPLATE_FILE);

    return path.join(TEMPLATES_DIR, safeName);
}


/*
 * Load and compile HTML template
 */
function loadTemplate(templateName) {

    let filePath = templateFilePathFor(templateName);

    /*
     * If requested template does not exist,
     * use default template.
     */
    if (!fs.existsSync(filePath)) {

        console.warn(
            `[templateEngine] Template not found: ${templateName}. Using ${DEFAULT_TEMPLATE_FILE}`
        );

        filePath = path.join(
            TEMPLATES_DIR,
            DEFAULT_TEMPLATE_FILE
        );
    }

    const stat = fs.statSync(filePath);

    const cached = compiledCache.get(filePath);

    if (
        cached &&
        cached.mtimeMs === stat.mtimeMs
    ) {
        return cached.compiled;
    }

    const source = fs.readFileSync(
        filePath,
        "utf8"
    );

    const compiled = Handlebars.compile(source);

    compiledCache.set(
        filePath,
        {
            mtimeMs: stat.mtimeMs,
            compiled
        }
    );

    console.log(
        `[templateEngine] Loaded template: ${path.basename(filePath)}`
    );

    return compiled;
}


/*
 * Render HTML using the template name
 * supplied by the PDF generation queue.
 */
function renderHtml(details, templateName) {

    const template = loadTemplate(templateName);

    return template(details);
}


module.exports = {
    renderHtml,
    loadTemplate,
    TEMPLATES_DIR
};