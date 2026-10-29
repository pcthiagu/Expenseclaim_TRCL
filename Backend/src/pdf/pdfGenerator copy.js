const fs = require("fs");
const path = require("path");
const { renderHtml } = require("./templateEngine");
const { computeDataHash } = require("./changeDetection");
const { execProcedure } = require("../sql/execProcedure");

const STORAGE_DIR = path.join(__dirname, "../../storage/generated-pdfs");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

function sanitizeFileName(transactionNo) {
  return transactionNo.replace(/[^a-z0-9]+/gi, "_");
}

// Puppeteer's browser instance is expensive to start — reuse one across
// generations instead of launching per-PDF.
let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    // eslint-disable-next-line global-require
    const puppeteer = require("puppeteer");
    browserPromise = puppeteer
      .launch({
        headless: true,
        // Lets a locked-down server point at an already-installed system
        // Chrome/Chromium instead of the one Puppeteer downloads itself —
        // set PUPPETEER_EXECUTABLE_PATH if your environment needs that.
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })
      .catch((err) => {
        browserPromise = null; // allow retry on next call instead of caching a rejected promise
        throw err;
      });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close();
    browserPromise = null;
  }
}

/**
 * Generates (or re-generates) the PDF for one transaction, unconditionally.
 * Callers (the scheduler, or a manual trigger) are responsible for the
 * "should we bother?" decision — see shouldRegenerate() below.
 */
async function generatePdfForTransaction(transactionNo) {
  const details = await execProcedure("usp_GetApprovalRequestDetails", { Transaction: transactionNo });
  if (!details) {
    throw new Error(`No request found for transaction ${transactionNo}`);
  }

  const dataHash = computeDataHash(details);
  const html = renderHtml(details);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", bottom: "18mm", left: "15mm", right: "15mm" },
    });

    const fileName = `${sanitizeFileName(transactionNo)}.pdf`;
    const filePath = path.join(STORAGE_DIR, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    return {
      publicPath: `${PUBLIC_BASE_URL}/pdf-storage/${fileName}`,
      dataHash,
      fileSizeKb: Math.max(1, Math.ceil(pdfBuffer.length / 1024)),
    };
  } finally {
    await page.close();
  }
}

/**
 * Item 10.3: don't regenerate unnecessarily. The PdfRegenerationNeeded flag
 * (set by every action procedure) is the primary queue signal; this hash
 * comparison is a secondary safety net in case that flag was ever set too
 * eagerly by something that doesn't actually change the rendered content.
 */
async function shouldRegenerate(transactionNo) {
  const details = await execProcedure("usp_GetApprovalRequestDetails", { Transaction: transactionNo });
  if (!details) return { needed: false, details: null };
  if (!details.pdfPath) return { needed: true, details }; // never generated yet
  const currentHash = computeDataHash(details);
  return { needed: currentHash !== details.pdfDataHash, details };
}

module.exports = { generatePdfForTransaction, shouldRegenerate, closeBrowser };
