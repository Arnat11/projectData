const panel = document.querySelector("#account-panel");
const home = document.querySelector("#account-home");
const errorBox = document.querySelector("#account-error");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
let currentUser = null;

async function request(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "เกิดข้อผิดพลาด กรุณาลองใหม่");
  return data;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function setMode(mode) {
  const register = mode === "register";
  loginForm.hidden = register;
  registerForm.hidden = !register;
  document.querySelector("#show-login").setAttribute("aria-selected", String(!register));
  document.querySelector("#show-register").setAttribute("aria-selected", String(register));
  document.querySelector("#account-title").textContent = register ? "สมัครสมาชิก" : "เข้าสู่ระบบลูกค้า";
  errorBox.hidden = true;
}

function showAccount(user) {
  currentUser = user;
  if (user.role === "admin") {
    window.location.href = "./admin.html";
    return;
  }
  panel.hidden = true;
  home.hidden = false;
  document.querySelector("#account-name").textContent = `${user.displayName} · @${user.username}`;
  loadOrders();
}

async function loadOrders() {
  const target = document.querySelector("#my-orders-list");
  try {
    const result = await request("/api/orders/mine");
    const statuses = { new: "รับคำสั่งซื้อแล้ว", processing: "กำลังจัดเตรียม", shipped: "จัดส่งแล้ว", completed: "เสร็จสิ้น", cancelled: "ยกเลิก" };
    target.innerHTML = result.items.length ? result.items.map((order) => `<article class="order-row"><strong>${escapeHtml(order.id)}</strong><span> · ${statuses[order.status] || "รับคำสั่งซื้อแล้ว"} · ฿${Number(order.total).toLocaleString("th-TH")}</span><small>${new Date(order.createdAt).toLocaleString("th-TH")}</small><small>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(", ")}</small></article>`).join("") : `<p class="muted">ยังไม่มีรายการสั่งซื้อ</p>`;
  } catch (error) { target.textContent = error.message; }
}

document.querySelector("#show-login").addEventListener("click", () => setMode("login"));
document.querySelector("#show-register").addEventListener("click", () => setMode("register"));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  try {
    const result = await request("/api/auth/customer/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    showAccount(result.user);
  } catch (error) { showError(error.message); }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(registerForm);
  try {
    const result = await request("/api/auth/customer/register", { method: "POST", body: JSON.stringify({ displayName: form.get("displayName"), username: form.get("username"), password: form.get("password") }) });
    showAccount(result.user);
  } catch (error) { showError(error.message); }
});

document.querySelector("#logout").addEventListener("click", async () => {
  try { await request("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": currentUser.csrfToken }, body: "{}" }); }
  finally { window.location.reload(); }
});

if (new URLSearchParams(location.search).get("error") === "admin") document.querySelector("#forbidden-message").hidden = false;

request("/api/auth/me").then(({ user }) => {
  if (user) showAccount(user);
}).catch((error) => showError(error.message));
