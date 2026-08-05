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

// ---- Tabs ----

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

// ---- Overview ----

async function refreshStatus() {
  const res = await fetch("/api/status");
  if (!res.ok) return;
  const data = await res.json();

  const modeBadge = document.getElementById("modeBadge");
  modeBadge.textContent = data.mode.toUpperCase();
  modeBadge.className = `badge ${data.mode === "live" ? "badge-live" : "badge-paper"}`;

  document.getElementById("balanceBadge").textContent = `${Number(data.balanceSol).toFixed(4)} SOL`;

  const stats = data.stats;
  const netPnlEl = document.getElementById("statNetPnl");
  netPnlEl.textContent = formatSol(stats.netPnlSol);
  netPnlEl.className = `stat-value ${pnlClass(stats.netPnlSol)}`;

  document.getElementById("statEarned").textContent = formatSol(stats.totalEarnedSol);
  document.getElementById("statLost").textContent = `-${Number(stats.totalLostSol).toFixed(4)} SOL`;
  document.getElementById("statTokensTraded").textContent = stats.tokensTraded;
  document.getElementById("statWinRate").textContent = `${stats.winRate.toFixed(0)}%`;
  document.getElementById("statBalance").textContent = `${Number(data.balanceSol).toFixed(4)} SOL`;

  const tbody = document.querySelector("#openPositionsTable tbody");
  const empty = document.getElementById("openPositionsEmpty");
  const table = document.getElementById("openPositionsTable");
  document.getElementById("openPositionsCount").textContent = data.openPositions.length;

  if (data.openPositions.length === 0) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");

  tbody.innerHTML = data.openPositions
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
        <td class="mono">${Number(p.entryPriceSol).toFixed(8)}</td>
        <td class="mono">${Number(p.lastPriceSol).toFixed(8)}</td>
        <td class="mono ${pnlClass(p.pnlPct)}">${formatPct(p.pnlPct)}</td>
        <td class="mono">${Number(p.amountSolSpent).toFixed(4)}</td>
        <td></td>
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---- Wallet ----

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

let revealingNewWallet = false;

async function refreshWallet() {
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

document.getElementById("generateWalletBtn").addEventListener("click", async () => {
  const btn = document.getElementById("generateWalletBtn");
  btn.disabled = true;
  btn.textContent = "Generating...";
  try {
    const res = await fetch("/api/wallet/generate", { method: "POST" });
    const data = await res.json();
    document.getElementById("revealAddress").textContent = data.address;
    document.getElementById("revealPrivateKey").textContent = data.privateKeyBase58;
    document.getElementById("walletRevealCard").classList.remove("hidden");
    document.getElementById("walletNoneCard").classList.add("hidden");
    revealingNewWallet = true;
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
  refreshWallet();
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
  refreshWallet().catch(() => {});
}

loadSettings();
refreshAll();
setInterval(refreshAll, REFRESH_MS);
