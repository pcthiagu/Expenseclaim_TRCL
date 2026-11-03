require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");

const { checkAuth } = require("./middleware/auth");
const executeRoute = require("./routes/execute");
const authRoute = require("./routes/auth");
const pdfScheduler = require("./pdf/scheduler");
const { closeBrowser } = require("./pdf/pdfGenerator");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(
  helmet({
    // The frontend runs on a different origin/port than this API and needs
    // to load generated PDFs from /pdf-storage — Helmet's default
    // same-origin Cross-Origin-Resource-Policy would block that even with
    // permissive CORS (CORP is a separate, server-declared opt-in check).
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // Item 5: HSTS — only meaningful over HTTPS, harmless to send always.
    hsts: { maxAge: 15552000, includeSubDomains: true },
  })
);
// app.use(
//   cors({
//     origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
//     credentials: true, // required for the refresh-token cookie to work cross-origin
//   })
// );
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", limiter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Item 10.2: generated PDFs are physical files on disk; served directly so
// the frontend's existing fileUrl-based PDF viewer needs no changes at all.
app.use("/pdf-storage", express.static(path.join(__dirname, "../storage/generated-pdfs")));

// Phase D + F: login/refresh/logout/change-password/forgot-password/
// reset-password/magic-login. Individual routes inside apply checkAuth
// where needed (change-password, /me) — this router itself is NOT
// blanket-protected, since you can't require a token to log in.
app.use("/api/auth", authRoute);

// Attachment preview modal code  checkAuth,
app.get("/api/attachment/view/:docType/:fileName",checkAuth, (req, res) => {
  try {
    const rootFolder =
      process.env.ATTACHMENT_ROOT || "D:\\HRMS\\Attachments";

    const fullPath = path.join(
      rootFolder,
      req.params.docType.toUpperCase(),
      req.params.fileName
    );

    // console.log("Checking:", fullPath);

    if (!fs.existsSync(fullPath)) {
      console.log("NOT FOUND");
      return res.status(404).json({
        success: false,
        message: "File not found",
      });
    }

    // console.log("FOUND");
    return res.sendFile(fullPath);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Unable to preview file",
    });
  }
});

app.get("/api/approval-pdf/view/:transaction", checkAuth, (req, res) => {
    try {
      const rootFolder =
        process.env.GENERATED_PDF_ROOT ||
        "D:\\hrms-approval-updated_latest\\server\\storage\\generated-pdfs";

      // Transaction:
      // GEN/000223/26-27
      //
      // Filename:
      // GEN_000223_26-27.pdf
      const transaction = req.params.transaction;

      const fileName =
        transaction.replace(/\//g, "_") + ".pdf";

      const fullPath = path.join(rootFolder, fileName);

      // console.log("Transaction:", transaction);
      // console.log("PDF filename:", fileName);
      // console.log("PDF path:", fullPath);

      if (!fs.existsSync(fullPath)) {
        console.log("PDF NOT FOUND:", fullPath);

        return res.status(404).json({
          success: false,
          message: "PDF not found",
        });
      }

      return res.sendFile(fullPath);
    } catch (err) {
      console.error("Approval PDF preview error:", err);

      return res.status(500).json({
        success: false,
        message: "Unable to preview approval PDF",
      });
    }
  }
);

// All other data traffic goes through this single, auth-protected endpoint.
app.use("/api", checkAuth, executeRoute);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[server] HRMS e-Approval API listening on port ${PORT}`);
  // Item 10.5: background scheduler starts alongside the API. Disable with
  // PDF_SCHEDULER_ENABLED=false (e.g. if running multiple API instances and
  // you only want one of them generating PDFs).
  if (process.env.PDF_SCHEDULER_ENABLED !== "false") {
    pdfScheduler.start();
  }
});

async function shutdown() {
  console.log("[server] shutting down, closing PDF generator browser…");
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
