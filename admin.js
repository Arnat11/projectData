const loginSection = document.querySelector("#login-section");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const dashboard = document.querySelector("#admin-dashboard");
const editor = document.querySelector("#product-editor");
const productForm = document.querySelector("#product-form");
const formMessage = document.querySelector("#form-message");
let adminUser = null;
let products = [];

const categoryNames = {
  purifiers: "เครื่องฟอกอากาศ",
  filters: "ไส้กรองอากาศ",
  monitors: "เครื่องวัดคุณภาพอากาศ",
  accessories: "อุปกรณ์เสริม",
};

async function request(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "เกิดข้อผิดพลาด กรุณาลองใหม่");
    error.status = response.status;
    throw error;
  }
  return data;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function money(value) {
  return `฿${Number(value).toLocaleString("th-TH")}`;
}

function setLoginMessage(message) {
  loginMessage.textContent = message;
  loginMessage.hidden = false;
}

function productImage(product) {
  if ((product.image || "").startsWith("sprite:")) {
    const position = product.image.slice(7);
    return `<div class="product-art" role="img" aria-label="ภาพตัวอย่าง ${escapeHtml(product.name)}"><span class="product-sprite" style="background-position:${escapeHtml(position)}"></span></div>`;
  }
  return `<div class="product-art"><img src="${escapeHtml(product.image || "")}" alt="${escapeHtml(product.name)}" loading="lazy"></div>`;
}

async function showDashboard(user) {
  if (user.role !== "admin") {
    window.location.href = "./account.html?error=admin";
    return;
  }
  adminUser = user;
  loginSection.hidden = true;
  loginMessage.hidden = true;
  dashboard.hidden = false;
  document.querySelector("#admin-name").textContent = `เข้าสู่ระบบในชื่อ ${user.displayName} (@${user.username})`;
  await Promise.all([loadInventory(), loadOrders()]);
}

async function loadInventory() {
  const result = await request("/api/admin/products");
  products = result.items;
  document.querySelector("#inventory-count").textContent = `${result.total} รายการ`;
  const list = document.querySelector("#inventory-list");
  list.innerHTML = products.length ? products.map((product) => `<article class="inventory-row">
      ${productImage(product)}
      <div><strong>${escapeHtml(product.name)}</strong><small>${categoryNames[product.category] || "สินค้า"} · ${escapeHtml(product.spec || "")}</small><small>${money(product.price)} · สต็อก ${product.stock} ชิ้น</small></div>
      <div class="row-actions"><button class="button button-quiet" type="button" data-edit="${escapeHtml(product.id)}">แก้ไข</button><button class="button button-text" type="button" data-delete="${escapeHtml(product.id)}">ลบ</button></div>
    </article>`).join("") : `<div class="blank"><p>ยังไม่มีสินค้าในร้าน</p></div>`;
}

function resetProductForm() {
  productForm.reset();
  productForm.elements.id.value = "";
  editor.hidden = true;
  formMessage.hidden = true;
  document.querySelector("#image-preview").innerHTML = "";
}

function editProduct(product) {
  productForm.elements.id.value = product.id;
  productForm.elements.name.value = product.name;
  productForm.elements.category.value = product.category;
  productForm.elements.price.value = product.price;
  productForm.elements.stock.value = product.stock;
  productForm.elements.spec.value = product.spec || "";
  productForm.elements.description.value = product.description || "";
  productForm.elements.image.value = product.image || "";
  document.querySelector("#editor-title").textContent = "แก้ไขสินค้า";
  document.querySelector("#product-form button[type=submit]").textContent = "บันทึกการแก้ไข";
  editor.hidden = false;
  previewImage();
  editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function previewImage() {
  const image = productForm.elements.image.value.trim();
  const name = productForm.elements.name.value.trim() || "ภาพตัวอย่างสินค้า";
  const preview = document.querySelector("#image-preview");
  if (!image) { preview.innerHTML = ""; return; }
  if (image.startsWith("sprite:")) {
    preview.innerHTML = `<div class="product-art" role="img" aria-label="${escapeHtml(name)}"><span class="product-sprite" style="background-position:${escapeHtml(image.slice(7))}"></span></div>`;
  } else {
    preview.innerHTML = `<div class="product-art"><img src="${escapeHtml(image)}" alt="${escapeHtml(name)}"></div>`;
  }
}

async function loadOrders() {
  const target = document.querySelector("#orders-list");
  try {
    const result = await request("/api/admin/orders");
    const statuses = { new: "รับคำสั่งซื้อแล้ว", processing: "กำลังจัดเตรียม", shipped: "จัดส่งแล้ว", completed: "เสร็จสิ้น", cancelled: "ยกเลิก" };
    target.innerHTML = result.items.length ? result.items.map((order) => `<article class="order-row"><strong>${escapeHtml(order.id)} · ${escapeHtml(order.customer.name)}</strong><small>ลูกค้า @${escapeHtml(order.username)} · ${escapeHtml(order.customer.phone)}</small><small>${escapeHtml(order.customer.address)}</small><small>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(", ")}</small><small>${money(order.total)} · ${statuses[order.status] || "รับคำสั่งซื้อแล้ว"} · ${new Date(order.createdAt).toLocaleString("th-TH")}</small></article>`).join("") : `<p class="muted">ยังไม่มีคำสั่งซื้อ</p>`;
  } catch (error) { target.textContent = error.message; }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  try {
    const result = await request("/api/auth/admin/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    await showDashboard(result.user);
  } catch (error) { setLoginMessage(error.message); }
});

document.querySelector("#password-toggle").addEventListener("click", () => {
  const password = document.querySelector("#password");
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  document.querySelector("#password-toggle").setAttribute("aria-label", visible ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน");
});

document.querySelector("#add-product").addEventListener("click", () => {
  resetProductForm();
  document.querySelector("#editor-title").textContent = "เพิ่มสินค้า";
  document.querySelector("#product-form button[type=submit]").textContent = "บันทึกสินค้า";
  editor.hidden = false;
  editor.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#cancel-edit").addEventListener("click", resetProductForm);

document.querySelector("#inventory-list").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    const product = products.find((item) => item.id === editButton.dataset.edit);
    if (product) editProduct(product);
    return;
  }
  const deleteButton = event.target.closest("[data-delete]");
  if (!deleteButton) return;
  const product = products.find((item) => item.id === deleteButton.dataset.delete);
  if (!product || !window.confirm(`ยืนยันลบ “${product.name}” ออกจาก MongoDB หรือไม่?`)) return;
  try {
    await request(`/api/admin/products/${encodeURIComponent(product.id)}`, { method: "DELETE", headers: { "X-CSRF-Token": adminUser.csrfToken } });
    await loadInventory();
  } catch (error) { window.alert(error.message); }
});

productForm.elements.image.addEventListener("input", previewImage);
productForm.elements.name.addEventListener("input", previewImage);
productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(productForm);
  const id = String(form.get("id") || "");
  const payload = {
    name: form.get("name"), category: form.get("category"), price: Number(form.get("price")), stock: Number(form.get("stock")),
    spec: form.get("spec"), description: form.get("description"), image: form.get("image"),
  };
  try {
    await request(id ? `/api/admin/products/${encodeURIComponent(id)}` : "/api/admin/products", {
      method: id ? "PUT" : "POST", headers: { "X-CSRF-Token": adminUser.csrfToken }, body: JSON.stringify(payload),
    });
    await loadInventory();
    resetProductForm();
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.hidden = false;
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  try { await request("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": adminUser.csrfToken }, body: "{}" }); }
  finally { window.location.reload(); }
});

request("/api/auth/me").then(({ user, adminConfigured }) => {
  if (user) return showDashboard(user);
  if (!adminConfigured) setLoginMessage("ยังไม่ได้กำหนด ADMIN_USERNAME และ ADMIN_PASSWORD ในไฟล์ .env");
}).catch((error) => setLoginMessage(error.message));
