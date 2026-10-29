const nodemailer = require("nodemailer");
const authConfig = require("../config/authConfig");

let transporter;
function getTransporter() {
  if (!transporter) {
    if (!authConfig.smtp.host) {
      console.warn(
        "[mailer] SMTP_HOST is not set — password reset emails will fail to send. " +
          "Configure SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD in .env."
      );
    }
    transporter = nodemailer.createTransport({
      host: authConfig.smtp.host,
      port: authConfig.smtp.port,
      secure: authConfig.smtp.secure,
      auth: authConfig.smtp.user ? { user: authConfig.smtp.user, pass: authConfig.smtp.password } : undefined,
    });
  }
  return transporter;
}

async function sendPasswordResetEmail(toEmail, employeeName, resetUrl) {
  const html = `
    <p>Hi ${employeeName || ""},</p>
    <p>A password reset was requested for your HRMS e-Approval account. Click the link below to set a new password:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>This link expires in ${authConfig.passwordReset.tokenExpiryMinutes} minutes and can only be used once.</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;

  await getTransporter().sendMail({
    from: `"${authConfig.smtp.fromName}" <${authConfig.smtp.fromAddress}>`,
    to: toEmail,
    subject: "Reset your HRMS e-Approval password",
    html,
  });
}

module.exports = { sendPasswordResetEmail };
