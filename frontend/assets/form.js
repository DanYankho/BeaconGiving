/* ============================================================
   form.js — Church Giving Platform Frontend Logic
   Backend: Cloudflare Workers (full CORS support)
   ============================================================ */

// ──────────────────────────────────────────────────────────────
//  CONFIGURATION — paste your Cloudflare Worker URL here after
//  deploying. Format: https://church-giving-api.YOUR_NAME.workers.dev
// ──────────────────────────────────────────────────────────────
var API_BASE = "https://church-giving-api.danyankho.workers.dev/";

var MIN_AMOUNT = 500;

// ──────────────────────────────────────────────────────────────
//  DOM READY
// ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {
  initForm();
  loadCategories();
});

// ──────────────────────────────────────────────────────────────
//  LOAD CATEGORIES from Worker — updates church name if set
// ──────────────────────────────────────────────────────────────
function loadCategories() {
  fetch(API_BASE + "api/categories")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.success) return;

      if (data.church_name) {
        var nameEl = document.getElementById("church-name-display");
        if (nameEl) nameEl.textContent = data.church_name;
        document.title = "Give — " + data.church_name;
        sessionStorage.setItem("churchName", data.church_name);
      }

      if (data.min_amount) {
        MIN_AMOUNT = data.min_amount;
        var amountInput = document.getElementById("amount");
        if (amountInput) amountInput.min = data.min_amount;
      }
    })
    .catch(function () {
      // Silent fail — form works with hardcoded HTML options
    });
}

// ──────────────────────────────────────────────────────────────
//  INIT FORM
// ──────────────────────────────────────────────────────────────
function initForm() {
  var givingTypeSelect = document.getElementById("giving_type");
  var projectNameField = document.getElementById("project-name-field");
  var form             = document.getElementById("giving-form");

  // Show/hide Project Name field
  if (givingTypeSelect) {
    givingTypeSelect.addEventListener("change", function () {
      var isProject = this.value === "project_pledge";
      projectNameField.classList.toggle("visible", isProject);
      var projectInput = document.getElementById("project_name");
      if (projectInput) projectInput.required = isProject;
    });
  }

  // Form submit
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      handleSubmit();
    });
  }

  // Clear individual field errors on input
  document.querySelectorAll("input, select, textarea").forEach(function (el) {
    el.addEventListener("input",  function () { clearFieldError(this.id); });
    el.addEventListener("change", function () { clearFieldError(this.id); });
  });
}

// ──────────────────────────────────────────────────────────────
//  HANDLE SUBMIT
// ──────────────────────────────────────────────────────────────
function handleSubmit() {
  clearAllErrors();

  var formData = collectFormData();
  var errors   = validateForm(formData);

  if (errors.length > 0) {
    showErrors(errors);
    return;
  }

  setLoading(true);

  // Cloudflare Workers support full CORS including application/json
  fetch(API_BASE + "api/initiate", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(formData),
  })
  .then(function (res) { return res.json(); })
  .then(function (data) {
    if (data.success && data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
    } else if (data.errors && data.errors.length > 0) {
      setLoading(false);
      showErrors(data.errors.map(function (msg) { return { message: msg }; }));
    } else {
      setLoading(false);
      showGlobalError(data.error || "Something went wrong. Please try again.");
    }
  })
  .catch(function (err) {
    setLoading(false);
    showGlobalError("Network error. Please check your connection and try again.");
    console.error("Submission error:", err);
  });
}

// ──────────────────────────────────────────────────────────────
//  COLLECT FORM DATA
// ──────────────────────────────────────────────────────────────
function collectFormData() {
  var paymentMethod = "";
  document.querySelectorAll('input[name="payment_method"]').forEach(function (input) {
    if (input.checked) paymentMethod = input.value;
  });

  return {
    donor_name:     val("donor_name"),
    donor_email:    val("donor_email"),
    donor_phone:    val("donor_phone"),
    amount:         val("amount"),
    giving_type:    val("giving_type"),
    payment_method: paymentMethod,
    project_name:   val("project_name"),
    notes:          val("notes"),
  };
}

function val(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

// ──────────────────────────────────────────────────────────────
//  VALIDATION
// ──────────────────────────────────────────────────────────────
function validateForm(data) {
  var errors = [];

  if (!data.donor_name) {
    errors.push({ field: "donor_name", message: "Full name is required." });
  }
  if (!data.donor_phone) {
    errors.push({ field: "donor_phone", message: "Phone number is required." });
  } else if (!/^(\+?265|0)[0-9]{8,9}$/.test(data.donor_phone.replace(/\s/g, ""))) {
    errors.push({ field: "donor_phone", message: "Please enter a valid Malawi phone number." });
  }
  if (!data.amount) {
    errors.push({ field: "amount", message: "Please enter an amount." });
  } else if (isNaN(Number(data.amount)) || Number(data.amount) < MIN_AMOUNT) {
    errors.push({ field: "amount", message: "Minimum giving amount is MWK " + MIN_AMOUNT.toLocaleString() + "." });
  }
  if (!data.giving_type) {
    errors.push({ field: "giving_type", message: "Please select a giving type." });
  }
  if (data.giving_type === "project_pledge" && !data.project_name) {
    errors.push({ field: "project_name", message: "Please enter the project name for your pledge." });
  }
  if (!data.payment_method) {
    errors.push({ field: "payment_method", message: "Please select a payment method." });
  }

  return errors;
}

// ──────────────────────────────────────────────────────────────
//  ERROR DISPLAY
// ──────────────────────────────────────────────────────────────
function showErrors(errors) {
  errors.forEach(function (error) {
    if (error.field) showFieldError(error.field, error.message);
  });

  var firstInvalid = document.querySelector(".invalid");
  if (firstInvalid) firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });

  var nonFieldErrors = errors.filter(function (e) { return !e.field; });
  if (nonFieldErrors.length > 0) {
    showGlobalError(nonFieldErrors.map(function (e) { return e.message; }).join(" "));
  }
}

function showFieldError(fieldId, message) {
  var input = document.getElementById(fieldId);
  if (input) input.classList.add("invalid");
  var errorEl = document.getElementById(fieldId + "-error");
  if (errorEl) { errorEl.textContent = message; errorEl.classList.add("visible"); }
}

function clearFieldError(fieldId) {
  var input = document.getElementById(fieldId);
  if (input) input.classList.remove("invalid");
  var errorEl = document.getElementById(fieldId + "-error");
  if (errorEl) { errorEl.textContent = ""; errorEl.classList.remove("visible"); }
}

function clearAllErrors() {
  document.querySelectorAll(".invalid").forEach(function (el) { el.classList.remove("invalid"); });
  document.querySelectorAll(".field-error").forEach(function (el) {
    el.textContent = ""; el.classList.remove("visible");
  });
  var banner = document.getElementById("error-banner");
  if (banner) { banner.textContent = ""; banner.classList.remove("visible"); }
}

function showGlobalError(message) {
  var banner = document.getElementById("error-banner");
  if (banner) {
    banner.textContent = "⚠️  " + message;
    banner.classList.add("visible");
    banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ──────────────────────────────────────────────────────────────
//  LOADING STATE
// ──────────────────────────────────────────────────────────────
function setLoading(isLoading) {
  var btn = document.getElementById("submit-btn");
  if (!btn) return;
  btn.disabled = isLoading;
  btn.classList.toggle("loading", isLoading);
}
