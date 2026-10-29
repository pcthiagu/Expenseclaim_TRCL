const fs = require("fs");
const path = require("path");
const { renderHtml } = require("./templateEngine");
const { computeDataHash } = require("./changeDetection");
const { execProcedure } = require("../sql/execProcedure");

const STORAGE_DIR = path.join(
  __dirname,
  "../../storage/generated-pdfs"
);

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  `http://localhost:${process.env.PORT || 4000}`;

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}


/*
 * Sanitize transaction number
 */
function sanitizeFileName(transactionNo) {
  return String(transactionNo || "").replace(/[^a-z0-9]+/gi, "_");
}


/*
 * Sanitize PDF file name coming from database.
 *
 * Example:
 *   CFM_M02820_APR25.pdf
 *
 * Only the file name is accepted.
 */
function sanitizePdfFileName(pdfFileName, transactionNo) {

  if (!pdfFileName) {
    return `${sanitizeFileName(transactionNo)}.pdf`;
  }

  return path.basename(pdfFileName);
}


/*
 * Puppeteer's browser instance is expensive to start.
 * Reuse one browser instance for all PDF generations.
 */
let browserPromise;

async function getBrowser() {

  if (!browserPromise) {

    // eslint-disable-next-line global-require
    const puppeteer = require("puppeteer");

    browserPromise = puppeteer
      .launch({
        headless: true,

        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH ||
          undefined,

        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox"
        ],
      })

      .catch((err) => {

        browserPromise = null;

        throw err;
      });
  }

  return browserPromise;
}


/*
 * Close browser
 */
async function closeBrowser() {

  if (browserPromise) {

    const browser =
      await browserPromise.catch(() => null);

    await browser?.close();

    browserPromise = null;
  }
}


/**
 * ============================================================
 * GENERATE PDF
 * ============================================================
 *
 * pdfItem comes directly from:
 *
 * usp_GetRequestsNeedingPdfRegeneration
 *
 * Expected:
 *
 * {
 *   tran_id,
 *   PDF_FILE_NAME,
 *   SP_NAME,
 *   HTML_TEMPLATE_NAME,
 *   USERID
 * }
 *
 */
async function generatePdfForTransaction(pdfItem) {

  if (!pdfItem) {
    throw new Error("PDF generation item is required");
  }


  const transactionNo = pdfItem.tran_id;

  const spName = pdfItem.SP_NAME;

  const templateName = pdfItem.HTML_TEMPLATE_NAME;

  const pdfFileName = pdfItem.PDF_FILE_NAME;

  const userId = pdfItem.USERID;


  if (!transactionNo) {
    throw new Error("tran_id is missing");
  }

  if (!spName) {
    throw new Error(
      `SP_NAME is missing for transaction ${transactionNo}`
    );
  }

  if (!templateName) {
    throw new Error(
      `HTML_TEMPLATE_NAME is missing for transaction ${transactionNo}`
    );
  }


  console.log(
    `[pdf-generator] Transaction : ${transactionNo}`
  );

  console.log(
    `[pdf-generator] SP          : ${spName}`
  );

  console.log(
    `[pdf-generator] Template    : ${templateName}`
  );

  console.log(
    `[pdf-generator] PDF File    : ${pdfFileName}`
  );

  console.log(
    `[pdf-generator] User ID     : ${userId}`
  );


  /*
   * ==========================================================
   * EXECUTE THE SP SPECIFIED IN PDF_gen_ApprovalRequests
   * ==========================================================
   *
   * Previously:
   *
   * usp_GetApprovalRequestDetails
   *
   * Now:
   *
   * pdfItem.SP_NAME
   *
   */
  const details = await execProcedure(
    "ExpenseClaimDB",
    spName,
    {
      Transaction: transactionNo,
      UserID: userId
    }
  );
  
  console.log(
    `[pdf-generator] Retrieved details for transaction ${transactionNo} from ${spName}`
  );
  console.log(details);

  if (!details) {

    throw new Error(
      `No data returned from ${spName} for transaction ${transactionNo}`
    );
  }


  /*
   * ==========================================================
   * COMPUTE DATA HASH
   * ==========================================================
   */
  const dataHash = computeDataHash(details);


  /*
   * ==========================================================
   * RENDER HTML USING DATABASE TEMPLATE NAME
   * ==========================================================
   *
   * Previously template was determined from:
   *
   * details.requestInfo.transactionType
   *
   * Now it comes directly from:
   *
   * PDF_gen_ApprovalRequests.HTML_TEMPLATE_NAME
   *
   */
  const html = renderHtml(
    details,
    templateName
  );


  /*
   * ==========================================================
   * GET BROWSER
   * ==========================================================
   */
  const browser = await getBrowser();

  const page = await browser.newPage();


  try {

    const logoMap = {
      TRCL: "TRCL_LOGO.png",
      RITSL: "RITSL_LOGO.png",
      OEPL: "OEPL_LOGO.png"
    };

    const logoFile = logoMap[details.company_code];

    if (!logoFile) {throw new Error(`Invalid company_code: ${details.company_code}`);}

    // const logoPath = path.join(__dirname, "../../templates/pdf/logo.png");
    const logoPath = path.join(__dirname,"../../templates/pdf/logos",logoFile);

    if (!fs.existsSync(logoPath)) {
      throw new Error(`Logo not found: ${logoPath}`);
    }

    const logoBase64 = fs.readFileSync(logoPath).toString("base64");

    const pdfHtml = html.replace(
      /src=["']\.\/logo\.png["']/gi,
      `src="data:image/png;base64,${logoBase64}"`
    );

    await page.setContent(pdfHtml, {
      waitUntil: "networkidle0"
    });


    /*
     * ========================================================
     * GENERATE PDF
     * ========================================================
     */
    const pdfBuffer = await page.pdf({

      format: "A4",

      printBackground: true,

      margin: {
        top: "18mm",
        bottom: "18mm",
        left: "15mm",
        right: "15mm"
      }

    });


    /*
     * ========================================================
     * FILE NAME
     * ========================================================
     */
    const fileName =
      sanitizePdfFileName(
        pdfFileName,
        transactionNo
      );

 
    const filePath =
      path.join(
        STORAGE_DIR,
        fileName
      );


    /*
     * ========================================================
     * SAVE PDF
     * ========================================================
     */
    fs.writeFileSync(
      filePath,
      pdfBuffer
    );


    /*
     * ========================================================
     * RETURN INFORMATION
     * ========================================================
     */
    return {

      publicPath:
        `${PUBLIC_BASE_URL}/pdf-storage/${fileName}`,

      fileName,

      dataHash,

      fileSizeKb:
        Math.max(
          1,
          Math.ceil(pdfBuffer.length / 1024)
        )

    };

  } finally {

    await page.close();

  }
}


/**
 * ============================================================
 * CHECK WHETHER PDF NEEDS REGENERATION
 * ============================================================
 *
 * pdfItem comes from:
 *
 * usp_GetRequestsNeedingPdfRegeneration
 *
 */
async function shouldRegenerate(pdfItem) {
  console.log(
    `[pdf-generator] Checking if PDF regeneration is needed for transaction ${pdfItem?.tran_id}`
  );
  console.log(pdfItem);

  if (!pdfItem) {
    throw new Error("PDF item is required");
  }
  if (!pdfItem) {

    return {
      needed: false,
      details: null
    };

  }


  const transactionNo =
    pdfItem.tran_id;

  const spName =
    pdfItem.SP_NAME;

  const userId =
    pdfItem.USERID;


  if (!transactionNo) {

    return {
      needed: false,
      details: null
    };

  }


  if (!spName) {

    throw new Error(
      `SP_NAME is missing for transaction ${transactionNo}`
    );

  }


  /*
   * Execute the SP specified by the queue.
   */
  const details = await execProcedure(
    "ExpenseClaimDB",
    spName,
    {
      Transaction: transactionNo,
      UserID: userId
    }
  );

    console.log(
      `[pdf-generator] Transaction : ${transactionNo}`
    );

    console.log(
      `[pdf-generator] SP          : ${spName}`
    );

    console.log(
      `[pdf-generator] User ID     : ${userId}`
    );

  if (!details) {

    return {
      needed: false,
      details: null
    };

  }


  /*
   * If PDF has never been generated,
   * regeneration is required.
   */
  if (!details.pdfPath) {

    return {
      needed: true,
      details
    };

  }


  /*
   * Compare current data with previous hash.
   */
  const currentHash =
    computeDataHash(details);


  return {

    needed:
      currentHash !== details.pdfDataHash,

    details

  };

}


module.exports = {

  generatePdfForTransaction,

  shouldRegenerate,

  closeBrowser

};