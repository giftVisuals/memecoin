const REFRESH_MS = 5000;

function shortMint(mint) {
  return mint.length > 10 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;
}

function formatSol(n, decimals = 4) {
  const num = Number(n ?? 0);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(decimals)} SOL`;
}

function formatPct(n, decimals = 1) {
  const num = Number(n ?? 0);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(decimals)}%`;
}

function pnlClass(n) {
  return Number(n) > 0 ? "stat-positive" : Number(n) < 0 ? "stat-negative" : "";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1500);
  } catch {
    // Clipboard API unavailable (e.g. non-HTTPS) - nothing to fall back to safely.
  }
}

// ---- Tabs ----

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

// ---- Overview (family-wide totals) ----

async function refreshStatus() {
  const res = await fetch("/api/status");
  if (!res.ok) return;
  const data = await res.json();

  const modeBadge = document.getElementById("modeBadge");
  modeBadge.textContent = data.mode.toUpperCase();
  modeBadge.className = `badge ${data.mode === "live" ? "badge-live" : "badge-paper"}`;

  const totalBalance = data.accounts.reduce((sum, a) => sum + (a.balanceSol ?? 0), 0);
  document.getElementById("balanceBadge").textContent = `${totalBalance.toFixed(4)} SOL`;

  const stats = data.familyStats;
  const netPnlEl = document.getElementById("statNetPnl");
  netPnlEl.textContent = formatSol(stats.netPnlSol);
  netPnlEl.className = `stat-value ${pnlClass(stats.netPnlSol)}`;

  document.getElementById("statEarned").textContent = formatSol(stats.totalEarnedSol);
  document.getElementById("statLost").textContent = `-${Number(stats.totalLostSol).toFixed(4)} SOL`;
  document.getElementById("statTokensTraded").textContent = stats.tokensTraded;
  document.getElementById("statWinRate").textContent = `${stats.winRate.toFixed(0)}%`;
  document.getElementById("statBalance").textContent = `${totalBalance.toFixed(4)} SOL`;

  renderOpenPositions(data.accounts);
  updatePrimaryPauseUi(data.accounts.find((a) => a.id === "primary"));
}

function renderOpenPositions(accounts) {
  const rows = accounts.flatMap((account) =>
    account.openPositions.map((p) => ({ ...p, walletName: account.name }))
  );

  const tbody = document.querySelector("#openPositionsTable tbody");
  const empty = document.getElementById("openPositionsEmpty");
  const table = document.getElementById("openPositionsTable");
  document.getElementById("openPositionsCount").textContent = rows.length;

  if (rows.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");

  tbody.innerHTML = rows
    .map(
      (p) => `
      <tr>
        <td>
          <div class="token-cell">
            <div>
              <div class="token-symbol">${escapeHtml(p.symbol)} ${
                p.isWatchlisted ? '<span class="watchlist-tag">WATCH</span>' : ""
              }</div>
              <div class="token-mint">${shortMint(p.mint)}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(p.walletName)}</td>
        <td class="mono">${Number(p.entryPriceSol).toFixed(8)}</td>
        <td class="mono">${Number(p.lastPriceSol).toFixed(8)}</td>
        <td class="mono ${pnlClass(p.pnlPct)}">${formatPct(p.pnlPct)}</td>
        <td class="mono">${Number(p.amountSolSpent).toFixed(4)}</td>
      </tr>`
    )
    .join("");
}

// ---- History ----

async function refreshHistory() {
  const res = await fetch("/api/trades");
  if (!res.ok) return;
  const trades = await res.json();

  const tbody = document.querySelector("#historyTable tbody");
  const empty = document.getElementById("historyEmpty");
  const table = document.getElementById("historyTable");

  if (trades.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");

  tbody.innerHTML = trades
    .map(
      (t) => `
      <tr>
        <td>${new Date(t.timestamp).toLocaleString()}</td>
        <td class="${t.side === "buy" ? "side-buy" : "side-sell"}">${t.side.toUpperCase()}</td>
        <td>
          <div class="token-symbol">${escapeHtml(t.symbol)}</div>
          <div class="token-mint">${shortMint(t.mint)}</div>
        </td>
        <td class="mono">${Number(t.priceSol).toFixed(8)}</td>
        <td class="mono">${Number(t.amountSol).toFixed(4)}</td>
        <td><span class="pill">${t.mode}</span></td>
      </tr>`
    )
    .join("");
}

// ---- Primary wallet (from SOLANA_PRIVATE_KEY) ----

let revealingNewWallet = false;

function updatePrimaryPauseUi(primaryAccount) {
  const badge = document.getElementById("primaryPauseBadge");
  const btn = document.getElementById("primaryPauseToggleBtn");
  if (!primaryAccount) return;

  if (primaryAccount.paused) {
    badge.textContent = "Paused";
    badge.className = "badge badge-paused";
    btn.textContent = "Resume Trading";
  } else {
    badge.textContent = "Active";
    badge.className = "badge badge-active";
    btn.textContent = "Pause Trading";
  }
}

document.getElementById("primaryPauseToggleBtn").addEventListener("click", async () => {
  const btn = document.getElementById("primaryPauseToggleBtn");
  const currentlyPaused = document.getElementById("primaryPauseBadge").textContent === "Paused";
  btn.disabled = true;
  try {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradingPaused: !currentlyPaused }),
    });
    await refreshStatus();
  } finally {
    btn.disabled = false;
  }
});

async function refreshPrimaryWallet() {
  if (revealingNewWallet) return; // don't clobber the one-time key reveal mid-poll

  const res = await fetch("/api/wallet");
  if (!res.ok) return;
  const data = await res.json();

  const noneCard = document.getElementById("walletNoneCard");
  const existingCard = document.getElementById("walletExistingCard");

  if (!data.hasWallet) {
    noneCard.classList.remove("hidden");
    existingCard.classList.add("hidden");
    return;
  }

  noneCard.classList.add("hidden");
  existingCard.classList.remove("hidden");
  document.getElementById("walletAddress").textContent = data.address;
  document.getElementById("walletBalance").textContent =
    data.balanceSol === null ? "unavailable" : `${Number(data.balanceSol).toFixed(4)} SOL`;
}

document.getElementById("copyAddressBtn").addEventListener("click", (e) => {
  copyToClipboard(document.getElementById("walletAddress").textContent, e.target);
});

function showReveal(hint, address, privateKeyBase58) {
  document.getElementById("revealHint").textContent = hint;
  document.getElementById("revealAddress").textContent = address;
  document.getElementById("revealPrivateKey").textContent = privateKeyBase58;
  document.getElementById("walletRevealCard").classList.remove("hidden");
  revealingNewWallet = true;
}

document.getElementById("generateWalletBtn").addEventListener("click", async () => {
  const btn = document.getElementById("generateWalletBtn");
  btn.disabled = true;
  btn.textContent = "Generating...";
  try {
    const res = await fetch("/api/wallet/generate", { method: "POST" });
    const data = await res.json();
    document.getElementById("walletNoneCard").classList.add("hidden");
    showReveal(
      "This is the only time this private key will ever be shown. Copy it somewhere safe, " +
        "then paste it into Railway → Variables → SOLANA_PRIVATE_KEY and redeploy. Generating " +
        "a new wallet does not change which wallet is live until you update that variable yourself.",
      data.address,
      data.privateKeyBase58
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate New Wallet";
  }
});

document.getElementById("copyRevealAddressBtn").addEventListener("click", (e) => {
  copyToClipboard(document.getElementById("revealAddress").textContent, e.target);
});
document.getElementById("copyRevealKeyBtn").addEventListener("click", (e) => {
  copyToClipboard(document.getElementById("revealPrivateKey").textContent, e.target);
});
document.getElementById("dismissRevealBtn").addEventListener("click", () => {
  document.getElementById("revealAddress").textContent = "";
  document.getElementById("revealPrivateKey").textContent = "";
  document.getElementById("walletRevealCard").classList.add("hidden");
  revealingNewWallet = false;
  refreshPrimaryWallet();
  refreshFamilyWallets();
});

// ---- Family wallets (added from the dashboard) ----

async function refreshFamilyWallets() {
  if (revealingNewWallet) return;

  const res = await fetch("/api/wallets");
  if (!res.ok) return;
  const wallets = await res.json();

  document.getElementById("familyWalletsCount").textContent = wallets.length;
  const list = document.getElementById("familyWalletsList");
  const empty = document.getElementById("familyWalletsEmpty");

  if (wallets.length === 0) {
    empty.classList.remove("hidden");
    list.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = wallets
    .map(
      (w) => `
      <div class="wallet-item">
        <div class="wallet-item-top">
          <span class="wallet-item-name">${escapeHtml(w.name)}</span>
          <span class="wallet-item-balance">${
            w.balanceSol === null ? "unavailable" : `${Number(w.balanceSol).toFixed(4)} SOL`
          }</span>
        </div>
        <div class="wallet-item-address">${w.address}</div>
        <div class="wallet-item-actions">
          <button class="btn-secondary" data-action="toggle-pause" data-id="${w.id}" data-paused="${w.paused}">
            ${w.paused ? "Resume" : "Pause"}
          </button>
          <button class="btn-secondary btn-danger" data-action="remove" data-id="${w.id}" data-name="${escapeHtml(w.name)}">
            Remove
          </button>
        </div>
      </div>`
    )
    .join("");
}

document.getElementById("familyWalletsList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === "toggle-pause") {
    const nextPaused = btn.dataset.paused !== "true";
    btn.disabled = true;
    try {
      await fetch(`/api/wallets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: nextPaused }),
      });
      await refreshFamilyWallets();
    } finally {
      btn.disabled = false;
    }
  }

  if (action === "remove") {
    if (!confirm(`Remove ${btn.dataset.name}'s wallet? This can't be undone from here.`)) return;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/wallets/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Failed to remove wallet.");
      }
      await refreshFamilyWallets();
    } finally {
      btn.disabled = false;
    }
  }
});

document.getElementById("showAddWalletBtn").addEventListener("click", () => {
  document.getElementById("addWalletForm").classList.remove("hidden");
  document.getElementById("showAddWalletBtn").classList.add("hidden");
  document.getElementById("newWalletName").focus();
});

document.getElementById("cancelAddWalletBtn").addEventListener("click", () => {
  document.getElementById("addWalletForm").classList.add("hidden");
  document.getElementById("showAddWalletBtn").classList.remove("hidden");
  document.getElementById("newWalletName").value = "";
});

document.getElementById("confirmAddWalletBtn").addEventListener("click", async () => {
  const nameInput = document.getElementById("newWalletName");
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }

  const btn = document.getElementById("confirmAddWalletBtn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || "Failed to create wallet.");
      return;
    }
    const data = await res.json();
    nameInput.value = "";
    document.getElementById("addWalletForm").classList.add("hidden");
    document.getElementById("showAddWalletBtn").classList.remove("hidden");
    showReveal(
      `This wallet is already saved (encrypted) so the bot can trade with it automatically - ` +
        `it starts paused, so switch it on from the Family Wallets list when you're ready. This ` +
        `key is shown once, as your own personal backup outside the bot.`,
      data.address,
      data.privateKeyBase58
    );
  } finally {
    btn.disabled = false;
  }
});

// ---- Settings ----

const settingsFields = [
  "positionSizeSol",
  "maxConcurrentPositions",
  "watchlistPositionMultiplier",
  "minLiquiditySol",
  "maxTopHolderPct",
  "maxSellPriceImpactPct",
  "minTokenAgeSec",
  "maxTokenAgeSec",
  "takeProfitPct",
  "stopLossPct",
  "trailingStopPct",
  "maxHoldTimeSec",
];
const settingsToggles = ["requireMintAuthorityRenounced", "requireFreezeAuthorityRenounced"];

async function loadSettings() {
  const res = await fetch("/api/settings");
  if (!res.ok) return;
  const settings = await res.json();

  document.getElementById("watchlistKeywords").value = settings.watchlistKeywords.join(", ");
  document.getElementById("primaryWalletName").textContent = settings.primaryWalletName || "Main";
  for (const key of settingsFields) {
    const el = document.getElementById(key);
    if (el) el.value = settings[key];
  }
  for (const key of settingsToggles) {
    const el = document.getElementById(key);
    if (el) el.checked = Boolean(settings[key]);
  }
}

document.getElementById("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settingsStatus");
  statusEl.textContent = "Saving...";
  statusEl.className = "settings-status";

  const payload = {
    watchlistKeywords: document
      .getElementById("watchlistKeywords")
      .value.split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  };
  for (const key of settingsFields) {
    payload[key] = Number(document.getElementById(key).value);
  }
  for (const key of settingsToggles) {
    payload[key] = document.getElementById(key).checked;
  }

  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    statusEl.textContent = "Saved - applies to the next trades immediately, no restart needed.";
    statusEl.className = "settings-status success";
  } catch (err) {
    statusEl.textContent = `Failed to save: ${err.message}`;
    statusEl.className = "settings-status error";
  }
});

// ---- Boot ----

function refreshAll() {
  refreshStatus().catch(() => {});
  refreshHistory().catch(() => {});
  refreshPrimaryWallet().catch(() => {});
  refreshFamilyWallets().catch(() => {});
}

loadSettings();
refreshAll();
setInterval(refreshAll, REFRESH_MS);
