/**
 * Church Giving Platform — Cloudflare Worker
 * ============================================================
 * Single-file backend handling all API routes:
 *
 *   OPTIONS  *                    → CORS preflight response
 *   GET      /api/categories      → giving types & config
 *   GET      /api/verify/:ref     → look up a transaction
 *   POST     /api/initiate        → create PayChangu session
 *   POST     /api/webhook         → PayChangu webhook handler
 *
 * Dependencies (all via fetch — no npm packages needed at runtime):
 *   • PayChangu API    — payment sessions & verification
 *   • Supabase REST    — PostgreSQL database
 *   • Resend API       — transactional email
 *   • Telegram Bot API — instant admin & donor alerts
 */

// ============================================================
//  CORS — allow GitHub Pages (and any origin) to call this API
// ============================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age":       "86400",
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extra },
  });
}

function jsonOk(data) {
  return corsResponse(JSON.stringify({ success: true, ...data }));
}

function jsonError(message, status = 400) {
  return corsResponse(JSON.stringify({ success: false, error: message }), status);
}

// ============================================================
//  ROUTER — main entry point
// ============================================================
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, ""); // strip trailing slash
    const method = request.method.toUpperCase();

    // ── CORS preflight ───────────────────────────────────────
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ── GET /api/categories ────────────────────────────────
      if (method === "GET" && path === "/api/categories") {
        return handleCategories(env);
      }

      // ── GET /api/verify/:ref ───────────────────────────────
      if (method === "GET" && path.startsWith("/api/verify/")) {
        const ref = decodeURIComponent(path.replace("/api/verify/", ""));
        return handleVerify(ref, env);
      }

      // ── POST /api/initiate ─────────────────────────────────
      if (method === "POST" && path === "/api/initiate") {
        const body = await request.json().catch(() => ({}));
        return handleInitiate(body, env);
      }

      // ── POST /api/webhook ──────────────────────────────────
      if (method === "POST" && path === "/api/webhook") {
        const rawBody  = await request.text();
        const signature = request.headers.get("x-paychangu-signature") || "";
        return handleWebhook(rawBody, signature, env);
      }

      return jsonError("Not found", 404);

    } catch (err) {
      console.error("Unhandled error:", err);
      await DB.logError(env, "Router", err.message, "");
      return jsonError("Internal server error", 500);
    }
  },
};

// ============================================================
//  HANDLER: GET /api/categories
// ============================================================
function handleCategories(env) {
  return jsonOk({
    church_name:     env.CHURCH_NAME     || "Church",
    min_amount:      Number(env.MIN_AMOUNT || 500),
    giving_types: [
      { value: "tithe",           label: "Tithe" },
      { value: "offering",        label: "Offering" },
      { value: "seed",            label: "Seed" },
      { value: "project_pledge",  label: "Project Pledge" },
      { value: "personal_pledge", label: "Personal Pledge" },
      { value: "special",         label: "Special / One-Off Giving" },
    ],
    payment_methods: [
      { value: "airtel_money",   label: "Airtel Money" },
      { value: "mpamba",         label: "TNM Mpamba" },
      { value: "bank_transfer",  label: "Bank Transfer" },
      { value: "card",           label: "Visa / MasterCard" },
    ],
  });
}

// ============================================================
//  HANDLER: GET /api/verify/:ref
// ============================================================
async function handleVerify(ref, env) {
  if (!ref) return jsonError("Reference is required");

  const tx = await DB.findByRef(env, ref);
  if (!tx) return jsonError("Transaction not found", 404);

  return jsonOk({ transaction: tx });
}

// ============================================================
//  HANDLER: POST /api/initiate
// ============================================================
async function handleInitiate(body, env) {
  // ── Validate ───────────────────────────────────────────────
  const errors = [];
  const min    = Number(env.MIN_AMOUNT || 500);

  if (!body.donor_name?.trim())                          errors.push("Full name is required.");
  if (!body.donor_phone?.trim())                         errors.push("Phone number is required.");
  if (!body.amount || isNaN(Number(body.amount)))        errors.push("A valid amount is required.");
  if (Number(body.amount) < min)                         errors.push(`Minimum giving amount is MWK ${min.toLocaleString()}.`);
  if (!body.giving_type)                                 errors.push("Giving type is required.");
  if (!body.payment_method)                              errors.push("Payment method is required.");
  if (body.giving_type === "project_pledge" && !body.project_name?.trim())
                                                         errors.push("Project name is required for a Project Pledge.");

  if (errors.length > 0) {
    return corsResponse(JSON.stringify({ success: false, errors }), 422);
  }

  // ── Generate tx_ref ────────────────────────────────────────
  const txRef = generateTxRef();

  // ── Build PayChangu payload ────────────────────────────────
  const nameParts   = body.donor_name.trim().split(" ");
  const firstName   = nameParts[0];
  const lastName    = nameParts.slice(1).join(" ") || ".";
  const givingLabel = formatType(body.giving_type);
  const description = body.project_name
    ? `${givingLabel} — ${body.project_name}`
    : givingLabel;

  const paychanguPayload = {
    amount:       String(body.amount),
    currency:     "MWK",
    email:        body.donor_email?.trim() || "noreply@giving.church",
    first_name:   firstName,
    last_name:    lastName,
    phone_number: body.donor_phone.trim(),
    callback_url: `${getWorkerBaseUrl(env)}/api/webhook`,
    return_url:   `${env.FRONTEND_BASE_URL}/success.html?ref=${txRef}`,
    cancel_url:   `${env.FRONTEND_BASE_URL}/failed.html?ref=${txRef}`,
    tx_ref:       txRef,
    customization: {
      title:       env.CHURCH_NAME || "Church Giving",
      description,
      logo:        env.CHURCH_LOGO_URL || "",
    },
    meta: {
      giving_type:    body.giving_type,
      payment_method: body.payment_method,
      project_name:   body.project_name  || "",
      notes:          body.notes         || "",
      donor_name:     body.donor_name.trim(),
      donor_phone:    body.donor_phone.trim(),
    },
  };

  // ── Call PayChangu API ─────────────────────────────────────
  let checkoutUrl;
  try {
    const pcRes  = await fetch("https://api.paychangu.com/payment", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${env.PAYCHANGU_SECRET_KEY}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json",
      },
      body: JSON.stringify(paychanguPayload),
    });

    const pcData = await pcRes.json();

    if (!pcRes.ok || pcData.status !== "success") {
      console.error("PayChangu error:", JSON.stringify(pcData));
      await DB.logError(env, "handleInitiate", "PayChangu API error", JSON.stringify(pcData));
      return jsonError(pcData.message || "Payment gateway error. Please try again.");
    }

    checkoutUrl = pcData.data?.checkout_url || pcData.data?.link;
    if (!checkoutUrl) {
      await DB.logError(env, "handleInitiate", "No checkout URL returned", JSON.stringify(pcData));
      return jsonError("Payment gateway did not return a checkout URL.");
    }

  } catch (err) {
    await DB.logError(env, "handleInitiate.fetch", err.message, "");
    return jsonError("Could not reach payment gateway. Please try again.");
  }

  // ── Save pending transaction ───────────────────────────────
  await DB.insertPending(env, {
    donor_name:      body.donor_name.trim(),
    donor_email:     body.donor_email?.trim() || "",
    donor_phone:     body.donor_phone.trim(),
    amount:          Number(body.amount),
    currency:        "MWK",
    giving_type:     body.giving_type,
    payment_method:  body.payment_method,
    transaction_ref: txRef,
    project_name:    body.project_name?.trim() || "",
    notes:           body.notes?.trim() || "",
  });

  return jsonOk({ checkoutUrl, txRef });
}

// ============================================================
//  HANDLER: POST /api/webhook
// ============================================================
async function handleWebhook(rawBody, signature, env) {
  // ── Parse body ─────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  // ── Verify HMAC signature ──────────────────────────────────
  if (signature) {
    const valid = await verifyHmac(rawBody, env.PAYCHANGU_SECRET_KEY, signature);
    if (!valid) {
      await DB.logError(env, "handleWebhook", "INVALID SIGNATURE — rejected", rawBody.slice(0, 300));
      // Return 200 so PayChangu stops retrying, but don't process
      return jsonOk({ message: "rejected" });
    }
  }

  const txRef  = body.tx_ref || body.txRef || "";
  const status = (body.status || "").toLowerCase();

  if (!txRef) {
    await DB.logError(env, "handleWebhook", "Missing tx_ref", rawBody.slice(0, 300));
    return jsonOk({ message: "no tx_ref" });
  }

  // ── Duplicate guard ────────────────────────────────────────
  const existing = await DB.findByRef(env, txRef);
  if (existing && (existing.status === "success" || existing.status === "failed")) {
    return jsonOk({ message: "already processed" });
  }

  // ── Determine final status ─────────────────────────────────
  const finalStatus = ["success", "successful", "completed"].includes(status)
    ? "success"
    : "failed";

  // ── Update database ────────────────────────────────────────
  const customer = body.customer || {};
  const updates  = {
    status:         finalStatus,
    donor_name:     customer.name         || body.donor_name     || existing?.donor_name  || "",
    donor_email:    customer.email        || body.donor_email    || existing?.donor_email || "",
    donor_phone:    customer.phone_number || body.donor_phone    || existing?.donor_phone || "",
    payment_method: body.payment_type     || body.payment_method || existing?.payment_method || "",
    notified_at:    new Date().toISOString(),
  };

  await DB.updateTransaction(env, txRef, updates);

  // ── Fetch full updated record for notifications ────────────
  const tx = await DB.findByRef(env, txRef);

  // ── Fire notifications (non-blocking) ─────────────────────
  if (tx) {
    if (finalStatus === "success") {
      await Promise.allSettled([
        Notify.adminEmail(env, tx),
        Notify.adminTelegram(env, tx),
        Notify.donorEmail(env, tx),
        Notify.donorTelegram(env, tx),
      ]);
    } else {
      await Promise.allSettled([
        Notify.adminEmailFailed(env, tx),
      ]);
    }
  }

  return jsonOk({ message: "processed", status: finalStatus, txRef });
}

// ============================================================
//  DATABASE — Supabase REST API
//  All DB operations go through Supabase's auto-generated REST
//  API — no pg client needed, just fetch calls.
// ============================================================
const DB = {

  // ── POST /rest/v1/transactions ────────────────────────────
  async insertPending(env, data) {
    const row = {
      donor_name:      data.donor_name,
      donor_email:     data.donor_email     || null,
      donor_phone:     data.donor_phone     || null,
      amount:          data.amount,
      currency:        data.currency        || "MWK",
      giving_type:     data.giving_type,
      payment_method:  data.payment_method,
      transaction_ref: data.transaction_ref,
      status:          "pending",
      project_name:    data.project_name    || null,
      notes:           data.notes           || null,
      created_at:      new Date().toISOString(),
      notified_at:     null,
    };

    const res = await supabaseFetch(env, "POST", "/rest/v1/transactions", row);
    if (!res.ok) {
      const err = await res.text();
      console.error("DB.insertPending failed:", err);
    }
    return res.ok;
  },

  // ── PATCH /rest/v1/transactions?transaction_ref=eq.{ref} ──
  async updateTransaction(env, txRef, updates) {
    const res = await supabaseFetch(
      env,
      "PATCH",
      `/rest/v1/transactions?transaction_ref=eq.${encodeURIComponent(txRef)}`,
      updates,
    );
    if (!res.ok) {
      const err = await res.text();
      console.error("DB.updateTransaction failed:", err);
    }
    return res.ok;
  },

  // ── GET /rest/v1/transactions?transaction_ref=eq.{ref} ────
  async findByRef(env, txRef) {
    const res = await supabaseFetch(
      env,
      "GET",
      `/rest/v1/transactions?transaction_ref=eq.${encodeURIComponent(txRef)}&limit=1`,
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  },

  // ── POST /rest/v1/error_log ───────────────────────────────
  async logError(env, source, message, payload) {
    try {
      await supabaseFetch(env, "POST", "/rest/v1/error_log", {
        source,
        message,
        payload:    (payload || "").slice(0, 2000),
        created_at: new Date().toISOString(),
      });
    } catch { /* never throw inside logError */ }
  },
};

// ── Supabase fetch helper ──────────────────────────────────
async function supabaseFetch(env, method, path, body) {
  const url = `${env.SUPABASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      "apikey":        env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=minimal" : "return=representation",
    },
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// ============================================================
//  NOTIFICATIONS
// ============================================================
const Notify = {

  // ── Admin email (success) ─────────────────────────────────
  async adminEmail(env, tx) {
    const subject = `💰 New Giving — ${formatType(tx.giving_type)} from ${tx.donor_name}`;

    const projectRow = tx.project_name
      ? `<tr><td style="color:#666;padding:5px 0;">Project</td><td><strong>${tx.project_name}</strong></td></tr>`
      : "";

    const notesRow = tx.notes
      ? `<tr><td style="color:#666;padding:5px 0;">Donor Note</td><td><em>${tx.notes}</em></td></tr>`
      : "";

    const html = emailShell(env.CHURCH_NAME, "#1a3c5e", "New Giving Received", `
      <p>A new giving has been received and recorded.</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px;margin-top:12px;">
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Donor</td><td><strong>${tx.donor_name}</strong></td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Amount</td><td><strong style="font-size:20px;color:#1a3c5e;">MWK ${Number(tx.amount).toLocaleString()}</strong></td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Type</td><td><strong>${formatType(tx.giving_type)}</strong></td></tr>
        ${projectRow}
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Method</td><td>${formatMethod(tx.payment_method)}</td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Phone</td><td>${tx.donor_phone || "—"}</td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Email</td><td>${tx.donor_email || "—"}</td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Ref</td><td><code style="background:#f4f4f4;padding:2px 6px;border-radius:3px;">${tx.transaction_ref}</code></td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Time</td><td>${new Date(tx.created_at).toUTCString()}</td></tr>
        ${notesRow}
      </table>`,
      `<p style="color:#aaa;font-size:12px;">Automated notification from ${env.CHURCH_NAME} Giving Platform.</p>`
    );

    return sendEmail(env, subject, html);
  },

  // ── Admin email (failed) ──────────────────────────────────
  async adminEmailFailed(env, tx) {
    const subject = `⚠️ Payment Failed — ${tx.donor_name} (MWK ${Number(tx.amount).toLocaleString()})`;
    const html = emailShell(env.CHURCH_NAME, "#8b0000", "Payment Did Not Complete", `
      <p>A payment attempt did not complete.</p>
      <table style="width:100%;border-collapse:collapse;font-size:15px;margin-top:12px;">
        <tr><td style="color:#666;padding:5px 0;">Donor</td><td><strong>${tx.donor_name}</strong></td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Amount</td><td><strong>MWK ${Number(tx.amount).toLocaleString()}</strong></td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Type</td><td>${formatType(tx.giving_type)}</td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Phone</td><td>${tx.donor_phone || "—"}</td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Ref</td><td><code>${tx.transaction_ref}</code></td></tr>
        <tr><td style="color:#666;padding:5px 0;border-top:1px solid #eee;">Time</td><td>${new Date(tx.created_at).toUTCString()}</td></tr>
      </table>`,
      `<p style="color:#aaa;font-size:12px;">Automated notification from ${env.CHURCH_NAME} Giving Platform.</p>`
    );
    return sendEmail(env, subject, html);
  },

  // ── Donor receipt email ───────────────────────────────────
  async donorEmail(env, tx) {
    if (!tx.donor_email) return;
    const subject = `✅ Your Giving Confirmation — ${env.CHURCH_NAME}`;
    const projectRow = tx.project_name
      ? `<tr><td style="color:#666;padding:5px 0;border-top:1px solid #ddd;">Project</td><td><strong>${tx.project_name}</strong></td></tr>`
      : "";

    const html = emailShell(env.CHURCH_NAME, "#1a7a4a", "Thank You for Giving!", `
      <p>Dear <strong>${tx.donor_name}</strong>,</p>
      <p>Your giving has been received and recorded. May God multiply what you have sown into His kingdom.</p>
      <div style="background:#f0f8f4;border-radius:8px;padding:20px;margin:20px 0;">
        <h3 style="color:#1a7a4a;margin-top:0;">Giving Receipt</h3>
        <table style="width:100%;border-collapse:collapse;font-size:15px;">
          <tr><td style="color:#666;padding:5px 0;">Amount</td><td><strong style="font-size:22px;color:#1a7a4a;">MWK ${Number(tx.amount).toLocaleString()}</strong></td></tr>
          <tr><td style="color:#666;padding:5px 0;border-top:1px solid #ddd;">Category</td><td><strong>${formatType(tx.giving_type)}</strong></td></tr>
          ${projectRow}
          <tr><td style="color:#666;padding:5px 0;border-top:1px solid #ddd;">Method</td><td>${formatMethod(tx.payment_method)}</td></tr>
          <tr><td style="color:#666;padding:5px 0;border-top:1px solid #ddd;">Date</td><td>${new Date(tx.created_at).toUTCString()}</td></tr>
          <tr><td style="color:#666;padding:5px 0;border-top:1px solid #ddd;">Reference</td><td><code style="background:#fff;padding:2px 6px;border-radius:3px;border:1px solid #ccc;">${tx.transaction_ref}</code></td></tr>
        </table>
      </div>
      <p style="font-size:14px;color:#555;">Keep your reference number for any queries. Contact our finance team quoting this reference.</p>`,
      `<p style="color:#888;font-size:12px;">God bless you. — ${env.CHURCH_NAME}</p>`
    );

    return sendEmail(env, subject, html, tx.donor_email);
  },

  // ── Admin Telegram (success) ──────────────────────────────
  async adminTelegram(env, tx) {
    const projectLine = tx.project_name ? `\n📌 Project: ${tx.project_name}` : "";
    const notesLine   = tx.notes        ? `\n💬 Note: ${tx.notes}`           : "";
    const msg =
      `🙏 *NEW GIVING RECEIVED*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Donor:* ${tx.donor_name}\n` +
      `💰 *Amount:* MWK ${Number(tx.amount).toLocaleString()}\n` +
      `🏷 *Type:* ${formatType(tx.giving_type)}${projectLine}\n` +
      `📱 *Method:* ${formatMethod(tx.payment_method)}\n` +
      `📞 *Phone:* ${tx.donor_phone || "—"}\n` +
      `🔖 *Ref:* \`${tx.transaction_ref}\`\n` +
      `🕐 *Time:* ${new Date(tx.created_at).toUTCString()}` +
      notesLine;
    return sendTelegram(env, msg);
  },

  // ── Donor Telegram (success) ──────────────────────────────
  // Note: requires donor to have started a chat with your bot first.
  // This is a Phase 2 feature once donor chat IDs are captured.
  async donorTelegram(env, tx) {
    // Placeholder — donor Telegram requires capturing their chat_id at sign-up.
    // Log intent for now.
    console.log(`Donor Telegram (pending chat_id capture): ${tx.donor_phone}`);
  },
};

// ============================================================
//  EMAIL — Google Apps Script Email Microservice
//
//  The Cloudflare Worker cannot use Gmail directly, but it CAN
//  make a server-to-server POST to a GAS Web App — no CORS
//  issues because this is Worker → GAS, not browser → GAS.
//
//  Required secrets (set via wrangler secret put):
//    GAS_EMAIL_URL    — your deployed GAS web app URL
//    GAS_EMAIL_SECRET — shared secret set in EmailService.gs
//    ADMIN_EMAIL      — admin recipient address
// ============================================================
async function sendEmail(env, subject, html, toOverride) {
  const to = toOverride || env.ADMIN_EMAIL;

  if (!to) {
    console.warn("Email skipped — no recipient address.");
    return;
  }
  if (!env.GAS_EMAIL_URL) {
    console.warn("Email skipped — GAS_EMAIL_URL secret not set.");
    return;
  }

  const res = await fetch(env.GAS_EMAIL_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret:  env.GAS_EMAIL_SECRET || "",
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("GAS email failed:", err);
    await DB.logError(env, "sendEmail", `GAS email error for ${to}`, err.slice(0, 500));
  }
}

// ============================================================
//  TELEGRAM — Bot API
// ============================================================
async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_CHAT_ID) {
    console.warn("Telegram skipped — token or chat_id not set.");
    return;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    env.TELEGRAM_ADMIN_CHAT_ID,
        text:       message,
        parse_mode: "Markdown",
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram failed:", err);
  }
}

// ============================================================
//  HMAC-SHA256 — webhook signature verification
// ============================================================
async function verifyHmac(message, secret, expectedHex) {
  try {
    const enc     = new TextEncoder();
    const keyMat  = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig     = await crypto.subtle.sign("HMAC", keyMat, enc.encode(message));
    const computed = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return computed.toLowerCase() === expectedHex.toLowerCase();
  } catch {
    return false;
  }
}

// ============================================================
//  UTILITIES
// ============================================================
function generateTxRef() {
  const ts     = Date.now();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CG-${ts}-${random}`;
}

function formatType(t) {
  const map = {
    tithe:           "Tithe",
    offering:        "Offering",
    seed:            "Seed",
    project_pledge:  "Project Pledge",
    personal_pledge: "Personal Pledge",
    special:         "Special Giving",
  };
  return map[t] || t;
}

function formatMethod(m) {
  const map = {
    airtel_money:  "Airtel Money",
    mpamba:        "TNM Mpamba",
    bank_transfer: "Bank Transfer",
    card:          "Card",
  };
  return map[m] || m;
}

function getWorkerBaseUrl(env) {
  // Set WORKER_BASE_URL as a var in wrangler.toml after you know your worker URL.
  // Format: https://church-giving-api.YOUR_SUBDOMAIN.workers.dev
  return env.WORKER_BASE_URL || "https://church-giving-api.workers.dev";
}

// ── HTML email shell ──────────────────────────────────────────
function emailShell(churchName, accentColor, heading, content, footer) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:${accentColor};padding:24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;">${churchName}</h1>
        <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">${heading}</p>
      </div>
      <div style="padding:24px;background:#fff;">${content}</div>
      <div style="padding:16px 24px;background:#f4f4f4;border-top:1px solid #ddd;">${footer}</div>
    </div>
  </body></html>`;
}
