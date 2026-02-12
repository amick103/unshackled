const STORAGE_KEY = "unshackled_v1";

const $ = (id) => document.getElementById(id);

const state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { debts: [], extraPayment: 0, strategy: "snowball" };
    const parsed = JSON.parse(raw);
    return {
      debts: Array.isArray(parsed.debts) ? parsed.debts : [],
      extraPayment: Number(parsed.extraPayment || 0),
      strategy: parsed.strategy === "avalanche" ? "avalanche" : "snowball",
    };
  } catch {
    return { debts: [], extraPayment: 0, strategy: "snowball" };
  }
}

function fmtMoney(n) {
  const x = (Math.round((Number(n) || 0) * 100) / 100);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function clamp0(n) {
  n = Number(n);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

// Init inputs
$("extraPayment").value = state.extraPayment || 0;
$("strategy").value = state.strategy || "snowball";

$("extraPayment").addEventListener("input", (e) => {
  state.extraPayment = clamp0(e.target.value);
  saveState();
});

$("strategy").addEventListener("change", (e) => {
  state.strategy = e.target.value === "avalanche" ? "avalanche" : "snowball";
  saveState();
});

$("btnReset").addEventListener("click", () => {
  if (!confirm("Reset Unshackled? This clears all debts on this device.")) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

// Add debt (simple prompt flow to keep v1 tiny)
$("btnAddDebt").addEventListener("click", () => {
  const name = prompt("Debt name (e.g., Navient):");
  if (!name) return;

  const balance = clamp0(prompt("Balance ($):"));
  const apr = clamp0(prompt("APR % (e.g., 6.8):"));
  const minPay = clamp0(prompt("Minimum payment ($/mo):"));

  if (balance <= 0 || minPay < 0) return;

  state.debts.push({ id: uid(), name: name.trim(), balance, apr, minPay });
  saveState();
  renderDebts();
  clearPlanUI();
});

$("btnGenerate").addEventListener("click", () => renderPlan());

// Render debts
function renderDebts() {
  const list = $("debtsList");
  list.innerHTML = "";

  if (!state.debts.length) {
    $("debtsEmpty").classList.remove("hidden");
    return;
  }
  $("debtsEmpty").classList.add("hidden");

  state.debts.forEach((d) => {
    const wrap = document.createElement("div");
    wrap.className = "debt";

    const left = document.createElement("div");
    left.innerHTML = `
      <strong>${escapeHtml(d.name)}</strong>
      <div class="meta">
        <span class="badge">Balance: ${fmtMoney(d.balance)}</span>
        <span class="badge">APR: ${Number(d.apr || 0).toFixed(2)}%</span>
        <span class="badge">Min: ${fmtMoney(d.minPay)}/mo</span>
      </div>
    `;

    const right = document.createElement("div");
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      if (!confirm(`Delete "${d.name}"?`)) return;
      state.debts = state.debts.filter(x => x.id !== d.id);
      saveState();
      renderDebts();
      clearPlanUI();
    });
    right.appendChild(del);

    wrap.appendChild(left);
    wrap.appendChild(right);
    list.appendChild(wrap);
  });
}

function clearPlanUI() {
  $("planEmpty").classList.remove("hidden");
  $("planSummary").classList.add("hidden");
  $("scheduleWrap").classList.add("hidden");
  $("schedule").innerHTML = "";
  $("planSummary").innerHTML = "";
}

// Core payoff simulation (monthly interest = APR/12)
function generatePlan(debtsInput, extraPayment, strategy) {
  const debts = debtsInput
    .map(d => ({
      id: d.id,
      name: d.name,
      balance: clamp0(d.balance),
      apr: clamp0(d.apr),
      minPay: clamp0(d.minPay),
      paidOffMonth: null
    }))
    .filter(d => d.balance > 0);

  if (!debts.length) return { months: [], payoffMonths: 0, totalInterest: 0, order: [] };

  extraPayment = clamp0(extraPayment);

  function pickTarget(activeDebts) {
    if (strategy === "avalanche") {
      return activeDebts.slice().sort((a,b) => (b.apr - a.apr) || (a.balance - b.balance))[0];
    }
    return activeDebts.slice().sort((a,b) => (a.balance - b.balance) || (b.apr - a.apr))[0];
  }

  let month = 0;
  let totalInterest = 0;
  const months = [];
  const start = new Date();

  while (month < 1200) {
    const active = debts.filter(d => d.balance > 0.009);
    if (!active.length) break;

    // interest
    let interestThisMonth = 0;
    active.forEach(d => {
      const r = (d.apr / 100) / 12;
      const interest = d.balance * r;
      d.balance += interest;
      totalInterest += interest;
      interestThisMonth += interest;
    });

    // pay minimums
    const payments = [];
    active.forEach(d => {
      const pay = Math.min(d.minPay, d.balance);
      d.balance -= pay;
      payments.push({ name: d.name, amount: pay });
    });

    // roll-up min payments from paid debts
    const rolled = debts.filter(d => d.balance <= 0.009).reduce((s,d)=>s + d.minPay, 0);
    let extra = extraPayment + rolled;

    // apply extra to target(s)
    let safety = 0;
    while (extra > 0.009 && debts.some(d => d.balance > 0.009) && safety < 1000) {
      safety++;
      const nowActive = debts.filter(d => d.balance > 0.009);
      const target = pickTarget(nowActive);
      const pay = Math.min(extra, target.balance);
      target.balance -= pay;
      extra -= pay;

      const existing = payments.find(p => p.name === target.name);
      if (existing) existing.amount += pay;
      else payments.push({ name: target.name, amount: pay });

      if (target.balance <= 0.009 && target.paidOffMonth === null) {
        target.paidOffMonth = month + 1;
      }
    }

    months.push({
      monthNumber: month + 1,
      dateLabel: monthLabel(start, month),
      interestThisMonth,
      payments: payments.sort((a,b)=>b.amount-a.amount)
    });

    month++;
  }

  const order = debts
    .slice()
    .sort((a,b)=>{
      const am = a.paidOffMonth ?? 999999;
      const bm = b.paidOffMonth ?? 999999;
      return am - bm;
    })
    .map(d=>d.name);

  return { months, payoffMonths: months.length, totalInterest, order };
}

function monthLabel(startDate, offsetMonths) {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + offsetMonths);
  return d.toLocaleString(undefined, { month: "short", year: "numeric" });
}

function addMonthsToNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function renderPlan() {
  if (!state.debts.length) {
    alert("Add at least one debt first.");
    return;
  }

  const extra = clamp0($("extraPayment").value);
  const strategy = $("strategy").value === "avalanche" ? "avalanche" : "snowball";

  const plan = generatePlan(state.debts, extra, strategy);

  if (!plan.months.length) {
    clearPlanUI();
    return;
  }

  $("planEmpty").classList.add("hidden");

  const debtFreeDate = addMonthsToNow(plan.payoffMonths);

  const summary = $("planSummary");
  summary.classList.remove("hidden");
  summary.innerHTML = `
    <div class="kpi">
      <div class="k">Debt-free date</div>
      <div class="v">${debtFreeDate}</div>
    </div>
    <div class="kpi">
      <div class="k">Months to freedom</div>
      <div class="v">${plan.payoffMonths}</div>
    </div>
    <div class="kpi">
      <div class="k">Total interest (est.)</div>
      <div class="v">${fmtMoney(plan.totalInterest)}</div>
    </div>
  `;

  $("scheduleWrap").classList.remove("hidden");
  const schedule = $("schedule");
  schedule.innerHTML = "";

  const showMonths = Math.min(plan.months.length, 60);
  for (let i = 0; i < showMonths; i++) {
    const m = plan.months[i];
    const div = document.createElement("div");
    div.className = "month";

    const lines = m.payments.slice(0, 6)
      .map(p => `<li>${escapeHtml(p.name)}: ${fmtMoney(p.amount)}</li>`)
      .join("");

    div.innerHTML = `
      <div class="top">
        <b>${m.dateLabel}</b>
        <span>Interest: ${fmtMoney(m.interestThisMonth)}</span>
      </div>
      <ul>${lines}</ul>
    `;
    schedule.appendChild(div);
  }

  // small extra: show payoff order in console for now
  console.log("Payoff order:", plan.order.join(" -> "));
}

renderDebts();
