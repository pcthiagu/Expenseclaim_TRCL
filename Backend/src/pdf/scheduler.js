const cron = require("node-cron");
const { execProcedure } = require("../sql/execProcedure");
const { generatePdfForTransaction, shouldRegenerate } = require("./pdfGenerator");

const SCHEDULE = process.env.PDF_SCHEDULER_CRON || "*/1 * * * *"; // every minute by default

let running = false; // simple re-entrancy guard so overlapping ticks can't stack up

async function processTransaction(item) {
  const transactionNo = item.tran_id;
  const startedAt = new Date().toISOString();

   const {
        SP_NAME,
        HTML_TEMPLATE_NAME,
        PDF_FILE_NAME,
        USERID
    } = item;

    console.log(
        `[pdf-scheduler] Processing ${transactionNo} | SP: ${SP_NAME} | Template: ${HTML_TEMPLATE_NAME}`
    );
  try {
    // Item 10.3 + 10.6: confirm regeneration is actually warranted (the
    // flag got it into the queue; the hash confirms the content really
    // changed) before spending a Puppeteer render on it.
    const { needed } = await shouldRegenerate(item);
    console.log(`[pdf-scheduler] regeneration needed for ${transactionNo}: ${needed}`);
    if (!needed) {
      
      console.log(`[pdf-scheduler] skipping regeneration for ${transactionNo} as it's not needed`);
      // Flag was set but content hash matches what's already rendered —
      // clear the flag without wasting a render. Reuse usp_MarkPdfGenerated
      // with the existing path/hash so it just clears the flag.
      //const details = await execProcedure("usp_GetApprovalRequestDetails", { Transaction: transactionNo });
      const details = await execProcedure(
        "ExpenseClaimDB",
          SP_NAME,
          {
              Transaction: transactionNo,
              UserID: USERID
          }
        );

      // await execProcedure("usp_MarkPdfGenerated", {
      //   Transaction: transactionNo,
      //   PdfPath: details?.pdfPath,
      //   DataHash: details?.pdfDataHash,
      // });
      return;
    }

    const { publicPath, dataHash, fileSizeKb } = await generatePdfForTransaction(item);
    console.log(`[pdf-scheduler] generated PDF for ${transactionNo} at ${publicPath} (${fileSizeKb} KB)`);
    // await execProcedure("usp_MarkPdfGenerated", {
    //   Transaction: transactionNo,
    //   PdfPath: publicPath,
    //   DataHash: dataHash,
    //   FileSizeKb: fileSizeKb,
    // });

    // await execProcedure("usp_LogPdfGeneration", {
    //   Transaction: transactionNo,
    //   Success: true,
    //   StartedAt: startedAt,
    // });

    console.log(`[pdf-scheduler] generated PDF for ${transactionNo}`);
  } catch (err) {
    console.error(`[pdf-scheduler] failed to generate PDF for ${transactionNo}:`, err.message);
    try {
      await execProcedure("ExpenseClaimDB","usp_LogPdfGeneration", {
        Transaction: transactionNo,
        Success: false,
        ErrorMessage: err.message,
        StartedAt: startedAt
      });
    } catch (logErr) {
      console.error("[pdf-scheduler] also failed to write the failure log:", logErr.message);
    }
  }
}

async function runOnce() {
  if (running) {
    console.log("[pdf-scheduler] previous run still in progress, skipping this tick");
    return;
  }
  running = true;
  try {
    const queue = await execProcedure("ExpenseClaimDB","usp_GetRequestsNeedingPdfRegeneration", {});
    const items = Array.isArray(queue) ? queue : [];
    if (items.length === 0) return;

    console.log(`[pdf-scheduler] ${items.length} request(s) need PDF regeneration`);
    // Sequential on purpose — Puppeteer pages share one browser instance,
    // and this is a background job with no user waiting on it, so
    // throughput isn't worth the complexity of parallelizing yet.
    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop
     // await processTransaction(item.transaction);
     await processTransaction(item);
    }
  } catch (err) {
    console.error("[pdf-scheduler] failed to fetch the regeneration queue:", err.message);
  } finally {
    running = false;
  }
}

function start() {
  console.log(`[pdf-scheduler] scheduled with cron expression "${SCHEDULE}"`);
  cron.schedule(SCHEDULE, runOnce);
  runOnce(); // also run once immediately on boot, don't wait for the first tick
}

module.exports = { start, runOnce, processTransaction };
