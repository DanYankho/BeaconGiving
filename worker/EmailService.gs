// ============================================================
//  EMAIL MICROSERVICE — Google Apps Script
//  Deploy this as a Web App (Execute as: Me, Access: Anyone)
//  The Cloudflare Worker POSTs to this URL to send emails.
//
//  This script only sends email — it has no database access
//  and no PayChangu integration. It is purely an email relay.
//
//  DEPLOY STEPS:
//  1. Go to script.google.com → New project
//  2. Name it "Church Giving — Email Service"
//  3. Paste this entire file into Code.gs
//  4. Click Deploy → New Deployment → Web App
//  5. Execute as: Me
//  6. Who has access: Anyone
//  7. Deploy → copy the Web App URL
//  8. Add that URL as the GAS_EMAIL_URL secret in Cloudflare
// ============================================================

// ── Shared secret — must match GAS_EMAIL_SECRET in Cloudflare ──
// Pick any random string (e.g. a UUID) and set it in both places.
var EMAIL_SECRET = "beacon-giving-2025-abc123";

// ── Church name (shown in email footer) ──────────────────────
var CHURCH_NAME  = "Beacon House";

// ============================================================
//  doPost — receives email requests from the Cloudflare Worker
// ============================================================
function doPost(e) {
  try {
    var raw  = e.postData.contents;
    var body = JSON.parse(raw);

    // ── Verify shared secret ─────────────────────────────────
    if (body.secret !== EMAIL_SECRET) {
      return respond(403, { error: "Unauthorized" });
    }

    var to      = body.to;
    var subject = body.subject;
    var html    = body.html;

    if (!to || !subject || !html) {
      return respond(400, { error: "Missing to, subject, or html" });
    }

    // ── Send via Gmail ────────────────────────────────────────
    MailApp.sendEmail({
      to:       to,
      subject:  subject,
      htmlBody: html
    });

    return respond(200, { success: true });

  } catch (err) {
    return respond(500, { error: err.toString() });
  }
}

// ── doGet — health check so you can test the URL in a browser ─
function doGet() {
  return respond(200, { status: "Church Giving Email Service is running." });
}

// ── respond helper ────────────────────────────────────────────
function respond(statusCode, data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
